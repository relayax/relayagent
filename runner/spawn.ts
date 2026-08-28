import fs from "node:fs";
import path from "node:path";
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

let cachedBash: string | null = null;

function existingFile(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function windowsBash(): string {
  if (cachedBash) return cachedBash;

  const configured = process.env.RELAY_BASH?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) || existingFile(configured)) {
      cachedBash = configured;
      return configured;
    }
    throw new Error(`RELAY_BASH 파일이 없습니다: ${configured}`);
  }

  const where = nodeSpawnSync("where.exe", ["bash.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const fromPath = String(where.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => existingFile(line))
    .find((line): line is string => Boolean(line));
  if (fromPath) {
    cachedBash = fromPath;
    return fromPath;
  }

  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  for (const root of roots) {
    const found = existingFile(root ? path.join(root, "Git", "bin", "bash.exe") : undefined)
      ?? existingFile(root ? path.join(root, "Git", "usr", "bin", "bash.exe") : undefined);
    if (found) {
      cachedBash = found;
      return found;
    }
  }

  throw new Error("Windows harness 실행에 Git Bash가 필요합니다. Git for Windows를 설치하거나 RELAY_BASH에 bash.exe 경로를 지정하세요.");
}

function commandForEntry(entry: string): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: entry, prefix: [] };
  return { command: windowsBash(), prefix: [entry] };
}

/** 진입 파일의 디렉토리를 기본 cwd 로 — 부모(데몬)의 cwd 를 물려받지 않는다. 실사고(2026-08-28): Tauri 앱이
 *  데몬을 임시 스테이징 디렉토리(current_app)에서 띄웠고 그 디렉토리가 뒤에 지워졌다. cwd 가 사라진 자식에서
 *  어댑터의 `node --input-type=module`·`claude` 가 uv_cwd ENOENT 로 죽어 info/models 동사가 전부 침묵했고,
 *  개막 capability(steer·effort)가 빠졌다. cwd 를 명시하는 세션 스폰만 무사했다. */
function withEntryCwd<T extends { cwd?: string | URL }>(entry: string, options: T): T {
  return options.cwd ? options : { ...options, cwd: path.dirname(entry) };
}

export function spawnEntry(entry: string, args: readonly string[], options?: SpawnOptions): ChildProcess {
  const { command, prefix } = commandForEntry(entry);
  return nodeSpawn(command, [...prefix, ...args], withEntryCwd(entry, options ?? {}));
}

/** 자식 하나를 끝까지 비동기로 돌린 결과 — spawnSync 의 답과 같은 축에 시한·스폰 오류를 더했다 */
export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** 시한을 넘겨 기판이 죽였다 */
  timedOut: boolean;
  /** 스폰 자체가 실패했다(ENOENT 등) — status 는 null */
  error?: NodeJS.ErrnoException;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** ms. 넘기면 SIGTERM 으로 죽이고 timedOut 으로 답한다 */
  timeout?: number;
  /** stdin 으로 흘릴 것 — 없으면 stdin 은 닫힌다 */
  input?: string;
}

/**
 * 자식 프로세스 하나를 **비동기로** 끝까지 — 데몬의 이벤트 루프를 붙들지 않는다.
 * spawnSync 가 있던 자리 전부의 답이다(빌드·하네스 어댑터 동사·바이너리 설치·docker·계약 검사):
 * 그 하나하나가 도는 동안 기판 전체(콘솔·위젯·세션·트리거)가 멈추던 것이 실측 2026-08-28 의 증상이다.
 */
export function runCommand(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = nodeSpawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: [options.input != null ? "pipe" : "ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ status: null, stdout: "", stderr: String(e), timedOut: false, error: e as NodeJS.ErrnoException });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const done = (r: RunResult): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    child.stdout?.on("data", (b) => { stdout += String(b); });
    child.stderr?.on("data", (b) => { stderr += String(b); });
    const timer = options.timeout && options.timeout > 0
      ? setTimeout(() => {
          timedOut = true;
          try { child.kill("SIGTERM"); } catch { /* 이미 종료 */ }
        }, options.timeout)
      : null;
    child.on("error", (e) => done({ status: null, stdout, stderr: stderr + String(e), timedOut, error: e as NodeJS.ErrnoException }));
    child.on("close", (status) => done({ status, stdout, stderr, timedOut }));
    if (options.input != null) child.stdin?.end(options.input);
  });
}

/** 어댑터 진입 파일을 비동기로 — spawnEntrySync 의 짝. cwd 규율(진입 디렉토리 기본)은 같다 */
export function runEntry(entry: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const { command, prefix } = commandForEntry(entry);
  const o = withEntryCwd(entry, options);
  return runCommand(command, [...prefix, ...args], o);
}

export function spawnEntrySync(
  entry: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnEntrySync(
  entry: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function spawnEntrySync(
  entry: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const { command, prefix } = commandForEntry(entry);
  return nodeSpawnSync(command, [...prefix, ...args], withEntryCwd(entry, options) as never) as SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>;
}

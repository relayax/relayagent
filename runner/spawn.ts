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

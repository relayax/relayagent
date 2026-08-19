import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { RELAY_HOME } from "./state.ts";
import type { HarnessVariant } from "./manifest.ts";

/**
 * 하네스 도구 살림 — **기판이 소유한, 버전 고정된 사본**.
 *
 * 어댑터는 도구를 번역할 뿐 동봉하지 않는다(claude·codex·pi·kimi 는 전부 남의 CLI 다).
 * 종전에는 그 도구가 호스트 전역 설치뿐이어서, 사용자의 `npm -g` 가 깨지면 에이전트 패키지가
 * 통째로 멈췄다 — 실사고: @openai/codex 의 네이티브 바이너리가 빠진 설치. 패키지는 멀쩡한데
 * 기계가 문제라 기판이 할 말이 "다시 설치하세요" 밖에 없었다.
 *
 * 그래서 매니페스트가 **획득 레시피**를 선언하고(harness.variants[].binary) 기판이 자기 prefix 에
 * 설치해 그 하네스의 스폰에만 PATH 앞에 둔다. 호스트 전역 설치는 더 이상 경로에 없다.
 *
 * 왜 컨테이너가 아닌가(2026-08-19 결정): 여기서 필요한 것은 격리가 아니라 소유와 고정이다.
 * 컨테이너는 workspace 를 마운트 문제로 바꾸고(규칙 6 은 세션이 폴더 하나 위에 선다고 말한다),
 * 구독 자격을 끊는다(도구 Keychain 은 호스트에 있다 — 어댑터가 그걸 일부러 안 빌린다).
 * prefix 설치는 셋 다 건드리지 않는다: 폴더 그대로, 자격 그대로, VM 없음.
 * 대신 격리는 아니다 — 이 기판은 이미 "가드레일이지 샌드박스가 아니다"(hooks.deny)라고 말한다.
 */

/** 도구가 앉는 자리 — (패키지, 변형)마다 하나. 버전 고정이 패키지별이라 공유하지 않는다. */
export function binaryPrefix(pkg: string, variant: string): string {
  return path.join(RELAY_HOME, "harness", pkg, variant);
}

/** 실행 파일이 놓이는 디렉토리 — 매니저마다 관례가 다르다. */
function binDir(prefix: string, manager: string): string {
  return manager === "npm" ? path.join(prefix, "node_modules", ".bin") : path.join(prefix, "bin");
}

/** 기판 사본의 실행 파일 경로. 선언이 없으면 null(호스트 PATH 를 쓰던 종전 동작). */
export function binaryPath(pkg: string, v: HarnessVariant): string | null {
  if (!v.binary) return null;
  return path.join(binDir(binaryPrefix(pkg, v.name), v.binary.manager), v.binary.name);
}

/** 기판 사본이 실재하는가. 실행 가능 여부까지 본다 — 껍데기만 남은 설치를 준비됨으로 세지 않는다. */
export function binaryReady(pkg: string, v: HarnessVariant): boolean {
  const bin = binaryPath(pkg, v);
  if (!bin) return true; // 선언 없음 = 기판이 대는 도구가 없다. 판정 대상 아님
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 어댑터 스폰용 env — 기판 사본을 PATH **앞에** 둔다.
 * 앞에 두는 것이 계약이다: 호스트에 같은 이름의 깨진 전역 설치가 있어도 그것이 먼저 걸리면
 * 이 축이 통째로 무의미해진다.
 */
export function binaryEnv(pkg: string, v: HarnessVariant, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(base ?? process.env) } as NodeJS.ProcessEnv;
  if (!v.binary) return env;
  const dir = binDir(binaryPrefix(pkg, v.name), v.binary.manager);
  env.PATH = dir + path.delimiter + (env.PATH ?? "");
  return env;
}

/** 매니저별 설치 명령 — 닫힌집합이라 셸 문자열을 매니페스트에서 받지 않는다. */
function installCommand(v: HarnessVariant, prefix: string): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const t = v.binary!;
  const ref = t.version ? `${t.package}@${t.version}` : t.package;
  if (t.manager === "npm") {
    return {
      cmd: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
      args: process.platform === "win32"
        ? ["/d", "/s", "/c", "npm.cmd", "install", "--prefix", prefix, "--no-audit", "--no-fund", ref]
        : ["install", "--prefix", prefix, "--no-audit", "--no-fund", ref],
      env: process.env,
    };
  }
  // uv 는 prefix 인자가 없다 — 도구·실행파일 자리를 env 로 잡는다
  const pyRef = t.version ? `${t.package}==${t.version}` : t.package;
  return {
    cmd: "uv",
    args: ["tool", "install", "--force", pyRef],
    env: { ...process.env, UV_TOOL_DIR: path.join(prefix, "tools"), UV_TOOL_BIN_DIR: binDir(prefix, "uv") },
  };
}

export interface EnsureResult {
  ok: boolean;
  out: string;
  /** true = 이미 있어서 아무것도 하지 않음 */
  cached: boolean;
}

/**
 * 선언된 도구를 기판 prefix 에 앉힌다. 이미 있으면 아무것도 하지 않는다(멱등).
 * 설치는 네트워크를 타므로 호출자는 이것을 **설치·전환 시점**에만 부른다 — 턴마다 부르지 않는다.
 */
export function ensureBinary(pkg: string, v: HarnessVariant): EnsureResult {
  if (!v.binary) return { ok: true, out: "", cached: true };
  if (binaryReady(pkg, v)) return { ok: true, out: `${v.binary.name} 준비됨 (기판 사본)`, cached: true };
  const prefix = binaryPrefix(pkg, v.name);
  fs.mkdirSync(prefix, { recursive: true });
  const { cmd, args, env } = installCommand(v, prefix);
  const r = spawnSync(cmd, args, { encoding: "utf8", env, timeout: 10 * 60_000 });
  const tail = ((r.stdout ?? "") + (r.stderr ?? "")).trim().slice(-600);
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { ok: false, cached: false, out: `${v.binary.manager} 이 없습니다 — 이 하네스의 도구를 기판이 설치하려면 ${v.binary.manager} 가 필요합니다` };
  }
  if (r.status !== 0) return { ok: false, cached: false, out: `${v.binary.manager} 설치 실패:\n${tail}` };
  if (!binaryReady(pkg, v)) {
    // 설치는 0 으로 끝났는데 실행 파일이 없다 = 선언과 실체의 불일치(bin 이름이 틀렸거나 패키지가 그 이름을 안 깐다)
    return { ok: false, cached: false, out: `설치는 끝났지만 실행 파일이 없습니다: ${binaryPath(pkg, v)} — binary.name 이 이 패키지가 까는 이름과 다른지 확인하세요` };
  }
  return { ok: true, cached: false, out: `${v.binary.name} 설치됨 (${v.binary.package}${v.binary.version ? "@" + v.binary.version : ""})` };
}

/** 패키지 제거의 동반 조치 — 기판이 깐 도구 사본도 함께 치운다. */
export function removeBinaries(pkg: string): void {
  fs.rmSync(path.join(RELAY_HOME, "harness", pkg), { recursive: true, force: true });
}

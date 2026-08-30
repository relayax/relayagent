import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runCommand } from "../spawn.ts";
import { RELAY_HOME } from "./ledger.ts";
import type { BinaryRequire, Manifest } from "./manifest.ts";

/**
 * requires.binaries 의 집행 — **기판이 소유한, 버전 고정 가능한 실행 파일 사본**.
 *
 * requires 는 AND 다: 설치가 끝나면 목록 전부가 실재한다. 레시피(manager+package) 없는 항목은
 * 종전대로 안내와 함께 fail-loud 하고(git 처럼 기판이 깔아줄 수 없는 것), 레시피 있는 항목은
 * 없으면 기판이 ~/.relay/bin/<패키지>/ 에 깔아 그 패키지의 스폰에 PATH 앞으로 준다.
 * 이 축이 있어야 AND 가 성립한다 — 종전에는 codex 를 요구하면 claude 만 쓰는 사용자의 설치가
 * 막혀서, 하네스 도구를 requires 에 올릴 수 없었다(실사고: 네이티브 바이너리가 빠진 전역
 * codex 가 턴마다 죽는데 기판이 할 말이 "다시 설치하세요" 뿐이었다).
 *
 * 왜 컨테이너가 아닌가(2026-08-19 결정): 여기서 필요한 것은 격리가 아니라 소유와 고정이다.
 * 컨테이너는 workspace 를 마운트 뒤로 옮기고(규칙 6: 세션은 결재된 폴더 하나 위에 선다),
 * 도구를 자기 Keychain 자격에서 끊는다(구독 로그인은 도구 소유 — 어댑터가 일부러 안 빌린다).
 * prefix 설치는 셋 다 건드리지 않는다: 폴더 그대로, 자격 그대로, VM 없음. 대신 격리는 아니다 —
 * 이 기판은 이미 "가드레일이지 샌드박스가 아니다"(번들 담장)라고 말한다.
 */

/** 기판 사본의 뿌리 — 패키지마다 하나. 버전 고정이 패키지별이라 공유하지 않는다. */
function pkgBinRoot(pkg: string): string {
  return path.join(RELAY_HOME, "bin", pkg);
}

/** 실행 파일이 놓이는 디렉토리 — 매니저마다 관례가 다르다. */
function binDirOf(pkg: string, manager: "npm" | "uv"): string {
  const root = pkgBinRoot(pkg);
  return manager === "npm" ? path.join(root, "npm", "node_modules", ".bin") : path.join(root, "uv", "bin");
}

function hasRecipe(b: BinaryRequire): b is BinaryRequire & { manager: "npm" | "uv"; package: string } {
  return b.manager != null && b.package != null;
}

/** 기판 사본의 실행 파일 경로. 레시피 없으면 null(기판이 대는 대상이 아니다). */
export function substrateBinaryPath(pkg: string, b: BinaryRequire): string | null {
  if (!hasRecipe(b)) return null;
  return path.join(binDirOf(pkg, b.manager), b.name);
}

/** 기판 사본이 실재·실행 가능한가. */
export function substrateBinaryReady(pkg: string, b: BinaryRequire): boolean {
  const bin = substrateBinaryPath(pkg, b);
  if (!bin) return false;
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 호스트 PATH 에 있는가 — 존재 검사다. 껍데기만 남은 설치(존재하지만 실행 불능)는 여기서
 *  걸리지 않는다: 그 부류는 setup 실패 → provisionForVariant 재시도가 덮는다. */
export function hostBinaryExists(name: string): boolean {
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  return probe.status === 0;
}

/**
 * 패키지 스폰용 env — 기판 사본 bin 디렉토리들을 PATH **앞에** 둔다.
 * 앞이 계약이다: 호스트에 같은 이름의 깨진 전역 설치가 있어도 기판 사본이 먼저 걸려야 한다.
 * 사본이 없는 매니저의 디렉토리는 넣지 않는다(빈 경로로 PATH 를 늘리지 않는다).
 */
export function binaryEnv(pkg: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...(base ?? process.env) } as NodeJS.ProcessEnv;
  const dirs = (["npm", "uv"] as const).map((mgr) => binDirOf(pkg, mgr)).filter((d) => fs.existsSync(d));
  if (dirs.length) env.PATH = dirs.join(path.delimiter) + path.delimiter + (env.PATH ?? "");
  return env;
}

/** 매니저별 설치 명령 — 닫힌집합이라 셸 문자열을 매니페스트에서 받지 않는다. */
function installCommand(pkg: string, b: BinaryRequire & { manager: "npm" | "uv"; package: string }): { cmd: string; args: string[]; env: NodeJS.ProcessEnv } {
  const root = pkgBinRoot(pkg);
  if (b.manager === "npm") {
    const prefix = path.join(root, "npm");
    const ref = b.version ? `${b.package}@${b.version}` : b.package;
    return {
      cmd: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm",
      args: process.platform === "win32"
        ? ["/d", "/s", "/c", "npm.cmd", "install", "--prefix", prefix, "--no-audit", "--no-fund", ref]
        : ["install", "--prefix", prefix, "--no-audit", "--no-fund", ref],
      env: process.env,
    };
  }
  // uv 는 prefix 인자가 없다 — 도구·실행파일 자리를 env 로 잡는다
  const ref = b.version ? `${b.package}==${b.version}` : b.package;
  return {
    cmd: "uv",
    args: ["tool", "install", "--force", ref],
    env: { ...process.env, UV_TOOL_DIR: path.join(root, "uv", "tools"), UV_TOOL_BIN_DIR: binDirOf(pkg, "uv") },
  };
}

export interface EnsureResult {
  ok: boolean;
  out: string;
  /** true = 아무것도 내려받지 않음(이미 충족) */
  cached: boolean;
}

/**
 * 요구 하나를 충족시킨다. 판정 순서가 비용 순서다:
 *   ① version 고정 → 기판 사본이 정본. 호스트는 보지 않는다(재현성 요구).
 *   ② 기판 사본이 이미 있음 → 그대로.
 *   ③ 호스트에 있음 → 그대로(되는 도구를 두고 수백 MB 를 받지 않는다 — 실측: 전 변형
 *      무조건 설치는 한 번에 921MB 였다).
 *   ④ 어디에도 없음 → 레시피가 있으면 깔고, 없으면 안내와 함께 실패.
 */
export async function ensureBinary(pkg: string, b: BinaryRequire): Promise<EnsureResult> {
  const pinned = hasRecipe(b) && b.version != null;
  if (pinned && substrateBinaryReady(pkg, b)) return { ok: true, cached: true, out: `${b.name} 준비됨 (기판 사본, ${b.version} 고정)` };
  if (!pinned) {
    if (substrateBinaryReady(pkg, b)) return { ok: true, cached: true, out: `${b.name} 준비됨 (기판 사본)` };
    if (hostBinaryExists(b.name)) return { ok: true, cached: true, out: `${b.name} 준비됨 (호스트)` };
  }
  if (!hasRecipe(b)) {
    return { ok: false, cached: true, out: `requires binary 없음: ${b.name}${b.install ? ` (설치: ${b.install})` : ""}` };
  }
  fs.mkdirSync(pkgBinRoot(pkg), { recursive: true });
  const { cmd, args, env } = installCommand(pkg, b);
  const r = await runCommand(cmd, args, { env, timeout: 10 * 60_000 });
  if (r.error && r.error.code === "ENOENT") {
    return { ok: false, cached: false, out: `${b.manager} 이 없습니다 — ${b.name} 을 기판이 설치하려면 ${b.manager} 가 필요합니다${b.install ? ` (직접 설치: ${b.install})` : ""}` };
  }
  if (r.status !== 0) {
    const tail = (r.stdout + r.stderr).trim().slice(-600);
    return { ok: false, cached: false, out: `${b.name} 설치 ${r.timedOut ? "시한 초과(10분)" : "실패"}(${b.manager}):\n${tail}` };
  }
  if (!substrateBinaryReady(pkg, b)) {
    // 설치는 0 으로 끝났는데 실행 파일이 없다 = 선언과 실체의 불일치(name 이 패키지가 까는 이름과 다르다)
    return { ok: false, cached: false, out: `설치는 끝났지만 실행 파일이 없습니다: ${substrateBinaryPath(pkg, b)} — requires.binaries[].name 이 ${b.package} 가 까는 이름과 다른지 확인하세요` };
  }
  return { ok: true, cached: false, out: `${b.name} 설치됨 (${b.package}${b.version ? "@" + b.version : ""} → 기판 사본)` };
}

/**
 * 변형의 setup 실패에 대한 기판의 답 — 참조된 요구를 **기판 사본으로 강제 승격**한다.
 * 존재 검사(ensureBinary ③)는 껍데기 설치를 통과시키므로, "있는데 안 도는" 부류는 여기가
 * 유일한 회복 경로다. 참조가 없으면 null(기판이 대줄 것이 없다 — 어댑터의 처방이 답이다).
 */
export async function provisionForVariant(
  pkg: string,
  m: Manifest,
  variantBinary: string | undefined,
  /** 풀 변형이 실어 온 레시피 사본 — 소비 패키지의 매니페스트가 답할 수 없을 때의 답.
   *
   *  풀 어댑터의 `binary` 는 **콘솔 패키지**의 requires.binaries 를 가리키는데, 조달은
   *  소비 패키지의 m 을 본다. 그래서 card-forge(requires.binaries = [python3])가 풀의
   *  claude-code 를 고르면 "claude" 참조가 영원히 미해석이고, 설치 버튼이 같은 "도구 없음"
   *  을 되풀이한다(실사고 2026-08-30). 이름은 이름대로 두고 레시피를 함께 나른다. */
  poolRecipe?: BinaryRequire | null,
): Promise<EnsureResult | null> {
  if (!variantBinary) return null;
  // 소비 패키지의 선언이 먼저다 — 자기 매니페스트에 같은 이름을 적어 둔 패키지는 그 뜻을
  // 존중한다(핀 버전이 다를 수 있다). 없을 때만 풀이 실어 온 사본으로 떨어진다
  const b = (m.requires?.binaries ?? []).find((x) => x.name === variantBinary) ?? poolRecipe ?? null;
  if (!b || !hasRecipe(b)) return null;
  if (substrateBinaryReady(pkg, b)) return null; // 이미 기판 사본인데도 실패 — 도구 문제가 아니다
  const forced: BinaryRequire = { ...b, version: b.version ?? "latest" };
  // version "latest" 는 npm/uv 의 실제 태그다 — 고정 취급으로 호스트를 건너뛰게 하는 장치
  return await ensureBinary(pkg, forced);
}

/** 패키지 제거의 동반 조치 — 기판이 깐 사본도 함께 치운다. */
export function removeBinaries(pkg: string): void {
  fs.rmSync(pkgBinRoot(pkg), { recursive: true, force: true });
  // 구판 자리(~/.relay/harness/<pkg>)도 치운다 — 이 축의 첫 구현이 거기 깔았다
  fs.rmSync(path.join(RELAY_HOME, "harness", pkg), { recursive: true, force: true });
}

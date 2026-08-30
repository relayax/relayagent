import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { loadManifest } from "../supply/manifest.ts";
import type { Ledger } from "../supply/ledger.ts";
import type { Authority } from "../authority-contract.ts";
import { harnessEntry, harnessEnv, chooseHarness } from "./harness-entry.ts";
import { spawnEntry } from "../spawn.ts";

/**
 * headless 로그인. 대화형 인증은 TTY 를 요구하지만 사람이 볼 터미널 창까지 요구하지는 않는다 —
 * pty 를 씌워 데몬 안에서 돌리고, 출력은 화면으로 흘리고 입력은 화면에서 받는다.
 * 터미널 창을 여는 길(launchHarnessLogin)은 이 경로가 막힌 환경의 폴백으로 남는다.
 *
 * 자격은 여전히 도구가 만든다. 기판은 그 대화를 중계할 뿐 토큰을 보거나 저장하지 않는다.
 */
export interface LoginProc {
  pkg: string;
  variant: string;
  child: ChildProcess;
  out: string[];
  /** out 에서 **버려진** 줄 수. 링버퍼가 앞을 자르면 배열 인덱스가 밀리므로, 밖으로 나가는
   *  커서는 이 값을 더한 절대 줄번호다. 종전에는 커서가 배열 인덱스여서 400줄을 넘기는
   *  순간부터 새 줄을 조용히 잃었다 — 하필 로그인 URL 이 사라질 수 있는 자리다 */
  dropped: number;
  done: boolean;
  code: number | null;
  started: number;
}

const procs = new Map<string, LoginProc>();
const OUT_CAP = 400; // 링버퍼 — 로그인 대화는 짧다. 무한 누적은 데몬 메모리를 먹는다

let scriptProbe: boolean | null = null;
/** pty 를 씌우는 script(1) 이 이 기계에 있나 — 한 번만 묻는다 */
function hasScript(): boolean {
  if (scriptProbe == null) {
    scriptProbe = process.platform !== "win32"
      && spawnSync("which", ["script"], { windowsHide: true }).status === 0;
  }
  return scriptProbe;
}

function shQuote(s: string): string {
  return `'` + s.replace(/'/g, `'\\''`) + `'`;
}

/**
 * 대화형 로그인에 pty 를 씌운다. **문법이 플랫폼마다 다르고, Windows 엔 script 자체가 없다.**
 *
 * pty 가 없으면 파이프로 간다. 어댑터 규약이 이미 "사람이 볼 터미널 창을 전제하지 마라 —
 * URL·코드·프롬프트는 평문 한 줄로, 입력은 줄 단위 stdin 으로 받아라" 를 요구하므로,
 * 규약을 지킨 어댑터는 파이프로도 끝난다. pty 는 그 규약을 어기고 TTY 를 고집하는 도구를
 * 위한 안전장치이지 전제가 아니다. 파이프로도 안 되는 도구는 창을 여는 폴백으로 강등된다.
 */
function spawnPty(entry: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const cwd = path.dirname(entry);
  const stdio: ["pipe", "pipe", "pipe"] = ["pipe", "pipe", "pipe"];
  if (hasScript()) {
    if (process.platform === "darwin") {
      // BSD script: script -q /dev/null <cmd> [args…] — 명령이 인자로 이어진다
      return spawn("script", ["-q", "/dev/null", entry, ...args], { cwd, env, stdio });
    }
    // util-linux script: 명령을 -c 뒤에 **한 문자열로** 받는다. 인용은 우리 몫이다.
    // -e 는 자식의 종료코드를 그대로 돌려준다(없으면 늘 0 이라 실패가 성공으로 보인다)
    const cmd = [entry, ...args].map(shQuote).join(" ");
    return spawn("script", ["-q", "-e", "-c", cmd, "/dev/null"], { cwd, env, stdio });
  }
  // pty 없이 — spawnEntry 가 Windows 의 Git Bash 경유까지 안다
  return spawnEntry(entry, args, { cwd, env, stdio });
}

export async function loginStart(
  ledger: Ledger,
  pkg: string,
  authority: Authority,
  opts: { switch?: boolean; variant?: string } = {},
): Promise<{ ok: true; variant: string; pty: boolean }> {
  const rec = ledger.packages[pkg];
  if (!rec) throw new Error(`미설치 패키지: ${pkg}`);
  const m = loadManifest(rec.path);
  const choice = chooseHarness(m, rec.harness, ledger.preferences?.harness);
  // 변형 지정은 제공사 화면의 요구다 — 그 줄의 provider 를 대는 어댑터로 로그인해야 한다.
  // 활성 하네스로만 돌면 openai 줄을 눌렀는데 anthropic 에 로그인하는 일이 생긴다
  const v = opts.variant ? (choice.candidates.find((x) => x.name === opts.variant) ?? null) : choice.variant;
  if (!v) throw new Error(opts.variant ? `쓸 수 없는 하네스: ${opts.variant}` : (choice.reason ?? `하네스 없음: ${pkg}`));
  const prev = procs.get(pkg);
  if (prev && !prev.done) throw new Error("이미 진행 중인 로그인이 있습니다");
  // 끝난 프로세스의 자리는 비운다 — 종전에는 지우는 곳이 없어, 한 번 매달린 로그인이
  // done=false 로 남으면 그 패키지는 데몬을 재시작할 때까지 다시 로그인할 수 없었다
  procs.delete(pkg);

  const entry = harnessEntry(rec.path, v);
  const args = opts.switch ? ["login", "--switch"] : ["login"];
  // 준비 문을 지난다 — 종전에는 이 자리만 맨 process.env 라, 기판이 ~/.relay/bin 에 깔아둔
  // 도구를 헤드리스 로그인만 못 찾았다(다른 호출부는 전부 PATH 를 앞세운다)
  const env = { ...(await harnessEnv(v, pkg)), TERM: "xterm-256color", CI: "" };
  const pty = hasScript();
  const child = spawnPty(entry, args, env);
  const proc: LoginProc = { pkg, variant: v.name, child, out: [], dropped: 0, done: false, code: null, started: Date.now() };
  const push = (chunk: Buffer | string): void => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "" && proc.out.length && proc.out[proc.out.length - 1] === "") continue;
      proc.out.push(stripAnsi(line));
      if (proc.out.length > OUT_CAP) {
        proc.out.shift();
        proc.dropped++;
      }
    }
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("exit", (code) => {
    proc.done = true;
    proc.code = code ?? 0;
    // 소비 계열 감사 — exit 콜백(동기 문맥)이라 fire-and-forget. 실패는 미처리 거부로 표면화된다
    void authority.audit("login", { pkg, variant: v.name, code: proc.code });
  });
  child.on("error", (e) => {
    proc.done = true;
    proc.code = 1;
    push(`기판: 로그인 프로세스 실행 실패 — ${e}`);
  });
  procs.set(pkg, proc);
  return { ok: true, variant: v.name, pty };
}

export function loginRead(pkg: string, from = 0): { lines: string[]; from: number; done: boolean; code: number | null; running: boolean } {
  const p = procs.get(pkg);
  if (!p) return { lines: [], from: 0, done: true, code: null, running: false };
  // 커서는 **절대 줄번호**다(버려진 줄 포함). 링버퍼가 앞을 자른 뒤에도 어긋나지 않는다
  const total = p.dropped + p.out.length;
  const start = Math.max(p.dropped, Math.min(from, total));
  return { lines: p.out.slice(start - p.dropped), from: total, done: p.done, code: p.code, running: !p.done };
}

export function loginInput(pkg: string, text: string): { ok: boolean } {
  const p = procs.get(pkg);
  if (!p || p.done) throw new Error("진행 중인 로그인이 없습니다");
  p.child.stdin?.write(text.endsWith("\n") ? text : text + "\n");
  return { ok: true };
}

export function loginStop(pkg: string): { ok: boolean } {
  const p = procs.get(pkg);
  if (p && !p.done) p.child.kill("SIGINT");
  return { ok: true };
}

// pty 출력에는 제어열이 섞인다. 화면은 평문만 받는다
function stripAnsi(s: string): string {
  return s
    .replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\u001b\][^\u0007]*\u0007?/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
}

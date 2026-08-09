import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { loadManifest, activeHarness } from "./manifest.ts";
import { logLine, type Ledger } from "./state.ts";

/**
 * headless 로그인. 대화형 인증은 TTY 를 요구하지만 사람이 볼 터미널 창까지 요구하지는 않는다 —
 * script(1) 로 pty 를 씌워 데몬 안에서 돌리고, 출력은 화면으로 흘리고 입력은 화면에서 받는다.
 * 터미널 창을 여는 길(launchHarnessLogin)은 이 경로가 막힌 환경의 폴백으로 남는다.
 *
 * 자격은 여전히 도구가 만든다. 기판은 그 대화를 중계할 뿐 토큰을 보거나 저장하지 않는다.
 */
export interface LoginProc {
  pkg: string;
  variant: string;
  child: ChildProcess;
  out: string[];
  done: boolean;
  code: number | null;
  started: number;
}

const procs = new Map<string, LoginProc>();
const OUT_CAP = 400; // 링버퍼 — 로그인 대화는 짧다. 무한 누적은 데몬 메모리를 먹는다

export function loginStart(ledger: Ledger, pkg: string, opts: { switch?: boolean } = {}): { ok: true; variant: string } {
  const rec = ledger.packages[pkg];
  if (!rec) throw new Error(`미설치 패키지: ${pkg}`);
  const m = loadManifest(rec.path);
  const v = activeHarness(m, rec.harness);
  if (!v) throw new Error(`하네스 미동봉 패키지: ${pkg}`);
  const prev = procs.get(pkg);
  if (prev && !prev.done) throw new Error("이미 진행 중인 로그인이 있습니다");

  const entry = path.join(rec.path, v.source, v.entry);
  const args = opts.switch ? ["login", "--switch"] : ["login"];
  // BSD script: script -q /dev/null <cmd> [args...] — pty 를 씌운다. 의존성 없이 쓰는 유일한 길
  const child = spawn("script", ["-q", "/dev/null", entry, ...args], {
    cwd: path.dirname(entry),
    env: { ...process.env, TERM: "xterm-256color", CI: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const proc: LoginProc = { pkg, variant: v.name, child, out: [], done: false, code: null, started: Date.now() };
  const push = (chunk: Buffer | string) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim() === "" && proc.out.length && proc.out[proc.out.length - 1] === "") continue;
      proc.out.push(stripAnsi(line));
      if (proc.out.length > OUT_CAP) proc.out.shift();
    }
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  child.on("exit", (code) => {
    proc.done = true;
    proc.code = code ?? 0;
    logLine("login", { pkg, variant: v.name, code: proc.code });
  });
  child.on("error", (e) => {
    proc.done = true;
    proc.code = 1;
    push(`기판: 로그인 프로세스 실행 실패 — ${e}`);
  });
  procs.set(pkg, proc);
  return { ok: true, variant: v.name };
}

export function loginRead(pkg: string, from = 0): { lines: string[]; from: number; done: boolean; code: number | null; running: boolean } {
  const p = procs.get(pkg);
  if (!p) return { lines: [], from: 0, done: true, code: null, running: false };
  const start = Math.max(0, Math.min(from, p.out.length));
  return { lines: p.out.slice(start), from: p.out.length, done: p.done, code: p.code, running: !p.done };
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

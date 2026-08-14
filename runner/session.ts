import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { API_URL, RELAY_HOME, PRINCIPAL, pkgToken, sessionDir, workspaceDir, stageDir, logLine, type Ledger } from "./state.ts";
import { loadManifest, landingAgentName, activeHarness, type Manifest } from "./manifest.ts";
import { spawnEntry, spawnEntrySync } from "./entry.ts";


export interface SessionInput {
  ledger: Ledger;
  pkg: string;
  agent?: string;
  prompt?: string;
  slot?: string;
  interactive?: boolean;
  /** workspace 상대경로. 업로드 라우트가 발급한 참조만 유효하다 */
  attachments?: { path: string; name?: string }[];
  /** 화면 맥락 스냅샷 — 프롬프트 서문으로만 붙는다. 이력의 user text 는 원문으로 남는다 (첨부와 같은 계약) */
  scene?: string;
}

export interface SessionResult {
  reply: string;
  code: number;
  /** 봉투 reply 이벤트가 알려준 실제 사용 모델 (별칭 해석 결과) */
  model?: string | null;
  /** 봉투 reply 이벤트의 토큰 장부 {input, output, context_window} — 턴의 청구 합계다 */
  usage?: unknown;
  /** 봉투 reply 의 context {input, window} — 대화 점유량. 게이지는 usage 가 아니라 이걸 쓴다
      (usage.input 은 툴 왕복마다 캐시 읽기가 누적돼 점유율로 쓰면 부푼다) */
  context?: unknown;
  /** 이 턴이 stage 에 내놓은 파일들 (봉투 file 이벤트 + stage diff 합집합) */
  files?: { path: string; name: string }[];
}

// 첨부는 프롬프트 앞에 경로로 붙는다. 첨부의 실체는 stage 에 앉으므로 cwd 와 무관하게
// 절대경로로 준다 (이미지는 비전). 사용자는 경로를 보지 않는다 — 위젯이 칩으로 보여줄 뿐이다
function safeAttachments(atts: SessionInput["attachments"]): { path: string; name: string }[] {
  return (atts ?? [])
    .map((a) => ({ path: String(a.path ?? ""), name: String(a.name ?? path.basename(String(a.path ?? ""))) }))
    .filter((a) => a.path && !a.path.startsWith("/") && !a.path.split("/").includes(".."));
}

function composeBundle(pkgPath: string, m: Manifest, agent: string, slot: string, pkg: string, token: string, ground: { workspace: string; stage: string }): string {
  const bundle = path.join(sessionDir(pkg, slot), "bundle");
  fs.mkdirSync(path.join(bundle, "agents"), { recursive: true });

  const decl = (m.agents ?? []).find((a) => a.name === agent);
  for (const sub of ["skills", "commands"]) fs.rmSync(path.join(bundle, sub), { recursive: true, force: true });
  if (decl) {
    fs.writeFileSync(path.join(bundle, "persona.md"), fs.readFileSync(path.join(pkgPath, decl.persona), "utf8"));
    if (decl.skills && fs.existsSync(path.join(pkgPath, decl.skills))) {
      fs.cpSync(path.join(pkgPath, decl.skills), path.join(bundle, "skills"), { recursive: true });
    }
    if (decl.commands && fs.existsSync(path.join(pkgPath, decl.commands))) {
      fs.cpSync(path.join(pkgPath, decl.commands), path.join(bundle, "commands"), { recursive: true });
    }

    for (const sub of decl.dispatch ?? []) {
      const subDecl = (m.agents ?? []).find((a) => a.name === sub);
      if (!subDecl) continue;
      fs.writeFileSync(path.join(bundle, "agents", sub + ".md"), fs.readFileSync(path.join(pkgPath, subDecl.persona), "utf8"));
    }
  } else {
    fs.writeFileSync(path.join(bundle, "persona.md"), `당신은 ${m.display_name} 에이전트입니다.\n${m.description}\n`);
  }

  const meta = {
    pkg,
    agent,
    slot,
    greeting: m.surfaces?.chat?.greeting,
    workspace: ground.workspace,
    stage: ground.stage,
    // 담장 선언. 기판 홈은 패키지 선언과 무관하게 기판이 무조건 병합한다 — 협상 불가.
    // 번역(네이티브 훅·권한 규칙)은 어댑터 소유. 도구 호출 레벨 가드레일이지 OS 샌드박스가 아니다
    hooks: { deny: [RELAY_HOME, ...(m.hooks?.deny ?? [])] },
    agents: (decl?.dispatch ?? []).map((sub) => ({
      name: sub,
      description: `${m.display_name} 패키지의 ${sub} 서브에이전트`,
    })),
    mcp: {
      url: `${API_URL}/mcp/${encodeURIComponent(pkg)}?agent=${encodeURIComponent(agent)}`,
      authorization: `Bearer ${token}`,
    },
  };
  fs.writeFileSync(path.join(bundle, "meta.json"), JSON.stringify(meta, null, 2));
  return bundle;
}

// ── 진행 중 턴 레지스트리 — cancel 라우트의 착지점 ─────────────────────────
const live = new Map<string, ChildProcess>();

/** 봉투 제어(stdin cancel)가 1순위 — 어댑터가 정리할 기회. 그물은 SIGTERM, 최후는 SIGKILL */
export function cancelSession(pkg: string, slot: string): boolean {
  const child = live.get(`${pkg}/${slot}`);
  if (!child) return false;
  try {
    child.stdin?.write(JSON.stringify({ type: "cancel" }) + "\n");
  } catch { /* stdin 이미 닫힘 — 아래 신호로 */ }
  const term = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* 이미 종료 */ } }, 3000);
  const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ } }, 8000);
  child.once("exit", () => {
    clearTimeout(term);
    clearTimeout(kill);
  });
  return true;
}

// ── 상주 하네스 (serve 동사) ───────────────────────────────────────────────
// 어댑터가 info 로 serve 를 선언하면 프로세스를 턴마다 갈지 않고 상주시킨다:
// 턴 = stdin 의 {"type":"turn"} 주입, 턴 경계 = reply/error 이벤트, 은퇴 = stdin EOF.
// 얻는 것은 warm turn(프로세스 spawn·대화 재독·MCP 재연결이 턴마다 사라진다)이고,
// 잃지 않는 것은 투영물 계약이다 — 상주는 언제 죽어도 다음 턴이 디스크의 대화를 잇는다.
// 상주는 데몬 전용이다: CLI 1회 실행이 상주를 남기면 고아가 된다 (enableResidents 는 데몬만 부른다)
let residentsEnabled = false;
export function enableResidents(): void {
  residentsEnabled = true;
}

interface Resident {
  child: ChildProcess;
  pkg: string;
  slot: string;
  /** 상주를 가른 조립 지문 — 모델·강도·자격·설치 경로가 달라지면 낡은 상주를 은퇴시킨다 */
  fp: string;
  idle: ReturnType<typeof setTimeout> | null;
  /** 진행 중 턴의 이벤트 수신자 — null 이면 유휴 */
  sink: ((ev: { event: string; [k: string]: unknown }) => void) | null;
  stderrTail: string;
  /** 봉투가 알린 미완 백그라운드 작업(task 이벤트) — 유휴 은퇴와 강제 종료를 유예하는 근거 */
  tasks: Set<string>;
  /** 마지막 봉투 이벤트 시각 — 스톨 워치독의 근거 */
  lastEvent: number;
}

const residents = new Map<string, Resident>();
const RESIDENT_TTL_MS = (() => {
  const v = Number(process.env.RELAY_RESIDENT_TTL_S);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 600_000;
})();
// 스톨 워치독 — 턴 진행 중 무이벤트가 이 시간을 넘으면 고착으로 판정하고 취소를 넣는다.
// 없으면 wedge 된 턴이 슬롯을 영구 busy 로 만들어 다음 메시지가 전부 튕긴다
const STALL_MS = (() => {
  const v = Number(process.env.RELAY_TURN_STALL_S);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 1_200_000;
})();

// serve 선언 조회 — info 는 어댑터 프로세스 1회 비용이라 mtime 캐시로 어댑터당 한 번만 돈다
const serveCache = new Map<string, { mtime: number; serves: boolean }>();
function harnessServes(entry: string): boolean {
  let mtime: number;
  try {
    mtime = fs.statSync(entry).mtimeMs;
  } catch {
    return false;
  }
  const hit = serveCache.get(entry);
  if (hit && hit.mtime === mtime) return hit.serves;
  let serves = false;
  try {
    const r = spawnEntrySync(entry, ["info"], { encoding: "utf8", timeout: 15_000 });
    const j = JSON.parse(r.stdout || "{}");
    serves = Array.isArray(j.verbs) && j.verbs.includes("serve");
  } catch { /* info 불달 — 상주 없이 턴마다 프로세스로 */ }
  serveCache.set(entry, { mtime, serves });
  return serves;
}

function retireEntry(key: string, r: Resident, force = false): void {
  if (residents.get(key) === r) residents.delete(key);
  if (r.idle) {
    clearTimeout(r.idle);
    r.idle = null;
  }
  try {
    r.child.stdin?.end(); // EOF = 은퇴 지시 — 봉투가 claude 를 자연 종료시킨다
  } catch { /* 이미 닫힘 */ }
  // 미완 백그라운드가 있으면 드레인이다 — 도구가 작업 완주까지 살았다가 스스로 내려온다(실측).
  // 강제 시계는 드레인이 아닐 때와 데몬 종료(force)에만 건다
  if (!force && r.tasks.size > 0) return;
  const term = setTimeout(() => { try { r.child.kill("SIGTERM"); } catch { /* 이미 종료 */ } }, 5000);
  const kill = setTimeout(() => { try { r.child.kill("SIGKILL"); } catch { /* 이미 종료 */ } }, 8000);
  term.unref?.();
  kill.unref?.();
  r.child.once("close", () => {
    clearTimeout(term);
    clearTimeout(kill);
  });
}

/** 대화 재시작(reset)·세션 삭제의 동반 조치 — 상주가 낡은 대화를 메모리에 물고 있으면 안 된다 */
export function retireResident(pkg: string, slot: string): boolean {
  const key = `${pkg}/${slot}`;
  const r = residents.get(key);
  if (!r) return false;
  retireEntry(key, r);
  return true;
}

/** 설치·발행·롤백·하네스 전환의 동반 조치 — 상주는 옛 코드·옛 번들로 떠 있다 */
export function retireResidents(pkg: string): number {
  let n = 0;
  for (const [key, r] of [...residents]) {
    if (key.startsWith(pkg + "/")) {
      retireEntry(key, r);
      n++;
    }
  }
  return n;
}

export function retireAllResidents(): void {
  for (const [key, r] of [...residents]) retireEntry(key, r, true);
}

/** 진행 중 턴 여부 — 화면이 새로고침 뒤에도 서버의 진행 상태(와 중지 버튼)를 되찾게 한다 */
export function isSessionBusy(pkg: string, slot: string): boolean {
  return live.has(`${pkg}/${slot}`);
}

/** ask(질문) 회송 — 위젯 답변을 진행 중 봉투의 제어 채널로 넣는다 */
export function deliverAnswer(pkg: string, slot: string, id: string, answers: unknown): boolean {
  const child = live.get(`${pkg}/${slot}`);
  if (!child?.stdin) return false;
  try {
    child.stdin.write(JSON.stringify({ type: "answer", id, answers }) + "\n");
    return true;
  } catch {
    return false;
  }
}

// 유휴 은퇴 시계 — 미완 백그라운드가 있으면 은퇴 대신 재무장한다(드레인)
function armIdle(key: string, r: Resident): void {
  r.idle = setTimeout(() => {
    r.idle = null;
    if (residents.get(key) !== r) return;
    if (r.tasks.size > 0) return armIdle(key, r);
    retireEntry(key, r);
  }, RESIDENT_TTL_MS);
  r.idle.unref?.();
}

// 유휴 이벤트 — 주입 없는 자발 턴(백그라운드 continuation)의 배달.
// reply 는 이력에 bot 메시지로 앉히고, 나머지는 진행 장부에 남겨 위젯이 줍게 한다
function idleEvent(r: Resident, ev: { event: string; [k: string]: unknown }): void {
  try {
    fs.appendFileSync(path.join(sessionDir(r.pkg, r.slot), "events.jsonl"), JSON.stringify({ t: Date.now(), ...ev }) + "\n");
  } catch { /* 세션 디렉토리가 지워짐 — 기록만 포기 */ }
  if (ev.event === "reply") {
    appendBot(r.pkg, r.slot, String(ev.text ?? ""), {
      model: typeof ev.model === "string" ? ev.model : null,
      usage: ev.usage ?? null,
      context: ev.context ?? null,
    });
  }
}

function acquireResident(pkg: string, slot: string, entry: string, env: Record<string, string>, cwd: string, fp: string): Resident {
  const key = `${pkg}/${slot}`;
  const cur = residents.get(key);
  if (cur && cur.fp === fp && cur.child.exitCode === null) {
    if (cur.idle) {
      clearTimeout(cur.idle);
      cur.idle = null;
    }
    return cur;
  }
  if (cur) retireEntry(key, cur);
  const child = spawnEntry(entry, ["serve"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const r: Resident = { child, pkg, slot, fp, idle: null, sink: null, stderrTail: "", tasks: new Set(), lastEvent: Date.now() };
  child.stdin?.on("error", () => { /* EPIPE — 실패는 close 가 sink 로 배달한다 */ });
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    // serve 선언 어댑터의 stdout 은 봉투 전용이다 — 이벤트 아닌 줄은 소음으로 버린다
    if (!line.startsWith("{")) return;
    let ev: { event?: unknown; [k: string]: unknown } | null = null;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!ev || typeof ev.event !== "string") return;
    r.lastEvent = Date.now();
    // 백그라운드 원장 — 턴 중이든 유휴든 항상 접는다. 유휴 은퇴·강제 종료 유예의 근거다
    if (ev.event === "task" && typeof ev.id === "string" && ev.id) {
      if (ev.status === "started") r.tasks.add(ev.id);
      else r.tasks.delete(ev.id);
    }
    if (r.sink) r.sink(ev as { event: string });
    else idleEvent(r, ev as { event: string });
  });
  child.stderr!.on("data", (d) => {
    r.stderrTail = (r.stderrTail + String(d)).slice(-2000);
  });
  child.on("error", (e) => {
    if (residents.get(key) === r) residents.delete(key);
    r.sink?.({ event: "error", message: `하네스 상주 기동 실패: ${e}` });
  });
  child.on("close", (code) => {
    rl.close();
    if (residents.get(key) === r) residents.delete(key);
    if (r.idle) clearTimeout(r.idle);
    // 턴 도중의 사망은 그 턴의 실패다 — 유휴 사망(sink 없음)은 다음 턴이 새 상주로 잇는다
    const tail = r.stderrTail.trim().split("\n").slice(-2).join(" / ");
    r.sink?.({ event: "error", message: `하네스 상주 종료 (exit ${code})${tail ? " — " + tail : ""}` });
  });
  residents.set(key, r);
  return r;
}

function residentTurn(
  pkg: string,
  slot: string,
  entry: string,
  env: Record<string, string>,
  cwd: string,
  fp: string,
  prompt: string,
  eventsFile: string,
  evFiles: { path: string; name: string }[],
): Promise<{ reply: string; code: number; model: string | null; usage: unknown; context?: unknown }> {
  return new Promise((resolve, reject) => {
    const key = `${pkg}/${slot}`;
    const r = acquireResident(pkg, slot, entry, env, cwd, fp);
    live.set(key, r.child);
    r.lastEvent = Date.now();
    // 스톨 워치독 — 무이벤트가 길면 고착이다. 취소 제어로 턴을 실패 종결시켜 슬롯을 풀어준다
    const stall = setInterval(() => {
      if (Date.now() - r.lastEvent < STALL_MS) return;
      logLine("sessions", { pkg, slot, stall_s: Math.round((Date.now() - r.lastEvent) / 1000) });
      try {
        r.child.stdin?.write(JSON.stringify({ type: "cancel" }) + "\n");
      } catch { /* 이미 닫힘 */ }
    }, 60_000);
    stall.unref?.();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(stall);
      r.sink = null;
      if (live.get(key) === r.child) live.delete(key);
      if (residents.get(key) === r && r.child.exitCode === null) {
        // 유휴 은퇴 시계 — 다음 턴의 acquire 가 푼다
        armIdle(key, r);
      }
      fn();
    };
    r.sink = (ev) => {
      fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now(), ...ev }) + "\n");
      if (ev.event === "reply") {
        finish(() => resolve({
          reply: String(ev.text ?? ""),
          code: 0,
          model: typeof ev.model === "string" ? ev.model : null,
          usage: ev.usage ?? null,
          context: ev.context ?? null,
        }));
      } else if (ev.event === "error") {
        finish(() => reject(new Error(String(ev.message ?? "하네스 오류"))));
      } else if (ev.event === "file" && typeof ev.path === "string" && !ev.path.startsWith("/") && !ev.path.split("/").includes("..")) {
        evFiles.push({ path: ev.path, name: path.basename(ev.path) });
      }
    };
    try {
      r.child.stdin!.write(JSON.stringify({ type: "turn", prompt }) + "\n");
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

// ── stage 산출물 감지 ──────────────────────────────────────────────────────
// 봉투 file 이벤트가 없는 어댑터에서도 파일 회신이 성립하는 보장선: 턴 전후 diff.
// uploads/ 는 사용자 인바운드 무대라 제외한다
function stageSnapshot(stage: string): Map<string, number> {
  const seen = new Map<string, number>();
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || seen.size > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rel === "" && e.name === "uploads") continue;
      const p = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(p, r, depth + 1);
      else if (e.isFile()) {
        try {
          seen.set(r, fs.statSync(p).mtimeMs);
        } catch { /* 경합 삭제 */ }
      }
    }
  };
  walk(stage, "", 0);
  return seen;
}

function stageDiffFiles(stage: string, before: Map<string, number>): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  for (const [r, mtime] of stageSnapshot(stage)) {
    const prev = before.get(r);
    if (prev == null || prev < mtime) out.push({ path: r, name: path.basename(r) });
  }
  return out;
}

export async function runSession(input: SessionInput): Promise<SessionResult> {
  const rec = input.ledger.packages[input.pkg];
  if (!rec) throw new Error(`미설치 패키지: ${input.pkg}`);
  const m = loadManifest(rec.path);
  const agent = input.agent ?? landingAgentName(m) ?? "";
  const slot = input.slot ?? `agent-${agent || "main"}`;
  const token = pkgToken(input.ledger, input.pkg);

  // cwd = workspace = 설치 때 결재된 폴더 (기본 ~/Relay/<이름>, system 은 ~ 로 결재).
  // harness.workdir 선언은 workspace 하위 상대경로로 해석한다
  const workdir = path.join(workspaceDir(input.ledger, input.pkg), m.harness?.workdir ?? "");
  fs.mkdirSync(workdir, { recursive: true });
  const stage = stageDir(input.pkg);
  const bundle = composeBundle(rec.path, m, agent, slot, input.pkg, token, { workspace: workdir, stage });

  const variant = activeHarness(m, rec.harness);
  if (!variant) throw new Error(`하네스 미동봉 패키지: ${input.pkg} — relay.yaml 에 harness.variants 를 선언하고 어댑터를 동봉하세요`);
  const entry = path.join(rec.path, variant.source, variant.entry);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    RELAY_NAME: input.pkg,
    RELAY_AGENT: agent,
    RELAY_PRINCIPAL: PRINCIPAL,
    RELAY_API: API_URL,
    RELAY_TOKEN: token,
    RELAY_SESSION: slot,
    RELAY_BUNDLE: bundle,
  };
  if (variant?.llm?.auth?.kind === "token" && variant.llm.auth.env) {
    const { vaultGet } = await import("./vault.ts");
    const cred = vaultGet(`llm/${variant.llm.provider}`);
    if (cred) env[variant.llm.auth.env] = cred;
  }
  if (rec.model) env.RELAY_MODEL = rec.model;
  if (rec.effort) env.RELAY_EFFORT = rec.effort;

  // 상주 지문: 이 값이 달라지면 낡은 상주를 은퇴시키고 새로 편다.
  // 자격은 값 대신 해시로 — 지문이 로그에 실려도 비밀이 새지 않는다
  const cred = variant.llm?.auth?.kind === "token" && variant.llm.auth.env ? env[variant.llm.auth.env] ?? "" : "";
  const fp = crypto.createHash("sha256")
    .update([rec.path, agent, rec.model ?? "", rec.effort ?? "", cred].join("\u0000"))
    .digest("hex").slice(0, 16);
  const resident = !input.interactive && residentsEnabled && harnessServes(entry);

  logLine("sessions", { pkg: input.pkg, agent, slot, mode: input.interactive ? "tty" : resident ? "resident" : "auto" });

  if (input.interactive) {
    return await new Promise((resolve) => {
      const child = spawnEntry(entry, ["session"], { cwd: workdir, env, stdio: "inherit" });
      child.on("exit", (code) => resolve({ reply: "", code: code ?? 0 }));
    });
  }

  const atts = safeAttachments(input.attachments);
  // 서문 합성은 기판 몫이다 — 화면 맥락(scene)도 첨부도 프롬프트에만 붙고 이력에는 원문만 남는다
  const scene = String(input.scene ?? "").trim();
  const prompt = (scene ? `[화면 맥락 — 사용자가 지금 보고 있는 화면]\n${scene}\n\n` : "")
    + (atts.length ? `첨부 파일 — Read 도구로 읽어라:\n${atts.map((a) => "- " + path.join(stage, a.path)).join("\n")}\n\n` : "")
    + (input.prompt ?? "");

  // 한 슬롯에 턴은 하나다. 돌고 있는데 또 넣으면 두 프로세스가 같은 하네스 세션을
  // --resume 으로 함께 물어 답이 통째로 비는 일이 생긴다. 조용히 비우느니 막고 알린다.
  // 아래 장부를 건드리기 전에 막아야 한다 — 진행 장부는 턴마다 비우므로,
  // 늦게 막으면 돌고 있는 턴의 실황 로그를 지워버린다
  const key = `${input.pkg}/${slot}`;
  if (live.has(key)) {
    throw new Error("이 대화는 아직 이전 요청을 처리하는 중입니다. 끝나면 이어서 말씀해 주세요 (급하면 진행 표시의 중지를 누르세요)");
  }

  // 이 턴의 진행 이벤트 장부 — 위젯이 폴링해 delta·tool 진행을 그린다. 턴마다 새로 시작한다
  const eventsFile = path.join(sessionDir(input.pkg, slot), "events.jsonl");
  fs.writeFileSync(eventsFile, "");
  // 질문은 턴이 끝나기를 기다리지 않는다. 답변까지 모아서 마지막에 한 번 쓰면
  // 도중에 기판이 죽었을 때 질문까지 통째로 사라진다 — 물음은 지금, 답은 끝나고
  appendUser(input.pkg, slot, input.prompt ?? "", atts);
  const stageBefore = stageSnapshot(stage);
  const evFiles: { path: string; name: string }[] = [];

  // 세션 봉투는 감지형이다: stdout 의 JSON 이벤트 줄은 봉투로, 그 외 줄은 구형 통짜 응답으로
  // 받는다. 어댑터의 protocol 선언을 세션마다 조회하지 않아도 신구가 공존한다.
  // serve 선언 어댑터는 상주 경로다 — 프로세스를 갈지 않고 stdin 으로 턴을 주입한다
  const turn = resident
    ? residentTurn(input.pkg, slot, entry, env, workdir, fp, prompt, eventsFile, evFiles)
    : new Promise<{ reply: string; code: number; model: string | null; usage: unknown; context?: unknown }>((resolve, reject) => {
      const child = spawnEntry(entry, ["session", prompt], { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] });
      live.set(key, child);
      let raw = "";
      let err = "";
      let lastLine = Date.now();
      // 스톨 워치독 — 봉투가 취소 제어를 받는 어댑터라면 고착 턴이 여기서 풀린다
      const stall = setInterval(() => {
        if (Date.now() - lastLine < STALL_MS) return;
        logLine("sessions", { pkg: input.pkg, slot, stall_s: Math.round((Date.now() - lastLine) / 1000) });
        try {
          child.stdin?.write(JSON.stringify({ type: "cancel" }) + "\n");
        } catch { /* 이미 닫힘 */ }
      }, 60_000);
      stall.unref?.();
      let reply: { text: string; model: string | null; usage: unknown; context: unknown } | null = null;
      let errEvent = "";
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        lastLine = Date.now();
        let ev: { event?: unknown; [k: string]: unknown } | null = null;
        if (line.startsWith("{")) {
          try {
            ev = JSON.parse(line);
          } catch { /* 봉투 아님 */ }
        }
        if (!ev || typeof ev.event !== "string") {
          raw += line + "\n";
          return;
        }
        fs.appendFileSync(eventsFile, JSON.stringify({ t: Date.now(), ...ev }) + "\n");
        if (ev.event === "reply") {
          reply = {
            text: String(ev.text ?? ""),
            model: typeof ev.model === "string" ? ev.model : null,
            usage: ev.usage ?? null,
            context: ev.context ?? null,
          };
        } else if (ev.event === "error") {
          errEvent = String(ev.message ?? "");
        } else if (ev.event === "file" && typeof ev.path === "string" && !ev.path.startsWith("/") && !ev.path.split("/").includes("..")) {
          evFiles.push({ path: ev.path, name: path.basename(ev.path) });
        }
      });
      child.stderr!.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearInterval(stall);
        live.delete(key);
        reject(e);
      });
      child.on("close", (code) => {
        clearInterval(stall);
        live.delete(key);
        if (reply) return resolve({ reply: reply.text, code: code ?? 0, model: reply.model, usage: reply.usage, context: reply.context });
        if (errEvent) return reject(new Error(errEvent));
        const legacy = raw.trim();
        if (code !== 0 && !legacy) return reject(new Error(`하네스 종료 코드 ${code}: ${err.slice(-500)}`));
        resolve({ reply: legacy, code: code ?? 0, model: null, usage: null, context: null });
      });
    });

  // 실패도 이력이다. 물음만 남기고 끝내면 다음 기동의 복구가 죽은 턴으로 오해한다
  let r: { reply: string; code: number; model: string | null; usage: unknown; context?: unknown };
  try {
    r = await turn;
  } catch (e) {
    appendBot(input.pkg, slot, `오류: ${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
  // 어댑터가 종결 본문을 못 준 턴 — 화면에 "(빈 응답)" 을 띄우기 전에 이 턴에 흘렀던
  // 말부터 줍는다. 하네스가 어떤 이유로 침묵해도 한 말이 있으면 그것이 답이다
  if (!r.reply.trim()) {
    const salvaged = deltaText(eventsFile);
    if (salvaged) r = { ...r, reply: salvaged };
  }

  const seen = new Set(evFiles.map((f) => f.path));
  const files = [...evFiles, ...stageDiffFiles(stage, stageBefore).filter((f) => !seen.has(f.path))];
  appendBot(input.pkg, slot, r.reply, { model: r.model, usage: r.usage, context: r.context, files });
  return { ...r, files };
}

// 대화 이력은 기판 장부다. 하네스가 자기 세션(claude jsonl)을 따로 갖더라도,
// 세션 목록·전환·복원은 기판이 답해야 하므로 여기서 쌓는다.
// 이력의 user text 는 첨부 서문 없는 원문이다 — 첨부는 files 필드로 따로 앉는다 (위젯이 칩으로 그림).
// bot 의 files 는 아웃바운드(이 턴의 stage 산출물), model·usage 는 봉투 reply 의 장부다
const HISTORY_TEXT_CAP = 16_384;

function writeRecord(pkg: string, slot: string, rec: object): void {
  fs.appendFileSync(path.join(sessionDir(pkg, slot), "history.jsonl"), JSON.stringify(rec) + "\n");
}

function appendUser(pkg: string, slot: string, prompt: string, files: { path: string; name: string }[] = []): void {
  if (!prompt.trim() && !files.length) return;
  writeRecord(pkg, slot, {
    t: new Date().toISOString(),
    role: "user",
    text: prompt.slice(0, HISTORY_TEXT_CAP),
    ...(files.length ? { files } : {}),
  });
}

function appendBot(
  pkg: string,
  slot: string,
  reply: string,
  extra: { model?: string | null; usage?: unknown; context?: unknown; files?: { path: string; name: string }[] } = {},
): void {
  writeRecord(pkg, slot, {
    t: new Date().toISOString(),
    role: "bot",
    text: reply.slice(0, HISTORY_TEXT_CAP),
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.usage ? { usage: extra.usage } : {}),
    ...(extra.context ? { context: extra.context } : {}),
    ...(extra.files?.length ? { files: extra.files } : {}),
  });
}

/** 진행 장부에 흘렀던 본류 텍스트를 이어 붙인다 — 종결 본문이 없는 턴의 대타 */
function deltaText(eventsFile: string): string {
  if (!fs.existsSync(eventsFile)) return "";
  let out = "";
  for (const l of fs.readFileSync(eventsFile, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const ev = JSON.parse(l);
      if (ev.event === "delta" && typeof ev.text === "string") out += ev.text;
      else if (ev.event === "reply" && typeof ev.text === "string" && ev.text.trim()) out = ev.text;
    } catch { /* 부서진 줄은 건너뛴다 */ }
  }
  return out.trim();
}

// ── 자동 제목 — 첫 턴이 끝난 뒤 하네스에 한 줄 요약을 시켜 auto-label 로 앉힌다.
// 사용자가 지은 이름(label 파일)이 항상 이긴다. 생성은 임시 슬롯(_title-*)에서 돌고
// 끝나면 그 슬롯을 지운다 — 목록에는 "_" 접두 슬롯이 애초에 안 나온다(api.listSessions).
// 실패는 조용히 삼킨다: 제목은 편의지 대화의 기능이 아니다
const titling = new Set<string>();

export async function autoTitleSession(ledger: Ledger, pkg: string, slot: string): Promise<void> {
  const key = `${pkg}/${slot}`;
  if (titling.has(key)) return;
  const dir = sessionDir(pkg, slot);
  if (fs.existsSync(path.join(dir, "label")) || fs.existsSync(path.join(dir, "auto-label"))) return;
  const hist = path.join(dir, "history.jsonl");
  if (!fs.existsSync(hist)) return;
  const msgs = fs.readFileSync(hist, "utf8").trim().split("\n")
    .map((l) => { try { return JSON.parse(l) as { role?: string; text?: string }; } catch { return null; } })
    .filter(Boolean) as { role?: string; text?: string }[];
  const user = msgs.find((m) => m.role === "user");
  const bot = msgs.find((m) => m.role === "bot");
  if (!user || !bot) return; // 완결된 첫 교환이 있어야 제목이 선다
  titling.add(key);
  const tmp = `_title-${slot}`.slice(0, 64);
  try {
    const prompt = [
      "아래 대화에 어울리는 제목을 짓는 작업이다. 도구를 쓰지 말고 즉시 답하라.",
      "요구: 한국어 20자 이내의 명사구 한 줄. 따옴표나 마침표, '제목:' 같은 접두어 없이 제목 텍스트만 출력하라.",
      "",
      "사용자: " + String(user.text ?? "").slice(0, 500),
      "어시스턴트: " + String(bot.text ?? "").slice(0, 500),
    ].join("\n");
    const r = await runSession({ ledger, pkg, prompt, slot: tmp });
    const title = String(r.reply ?? "")
      .split("\n").map((s) => s.trim()).filter(Boolean)[0]
      ?.replace(/^["'`「『]+|["'`」』.]+$/g, "").slice(0, 40) ?? "";
    // 생성 도중 사용자가 직접 이름을 지었을 수 있다 — 그때는 버린다
    if (title && !fs.existsSync(path.join(dir, "label"))) {
      fs.writeFileSync(path.join(dir, "auto-label"), title);
    }
  } catch { /* 제목 실패는 대화에 영향을 주지 않는다 */ } finally {
    titling.delete(key);
    // 상주 하네스가 켜져 있으면 제목 턴이 임시 슬롯의 상주를 남긴다 — TTL 을 기다리지 않고 은퇴시킨다
    retireResident(pkg, tmp);
    fs.rmSync(sessionDir(pkg, tmp), { recursive: true, force: true });
  }
}

/** 한 패키지가 가진 세션 슬롯 목록 — 복구는 슬롯 단위로 돈다 */
export function listSessionSlots(pkg: string): string[] {
  const root = path.join(RELAY_HOME, "sessions", pkg);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

/**
 * 끊긴 턴 줍기 — 기판이 죽으면 그 턴의 답은 저장 시점에 닿지 못하고 사라진다.
 * 물음만 남고 답이 없는 마지막 기록을 찾아, 그 턴의 이벤트 장부에 흘러 있던
 * 중간 텍스트로 답을 복구한다. 흐른 말이 없으면 끊겼다는 사실이라도 남긴다.
 * 데몬이 뜰 때 한 번만 돈다 — 도는 중인 턴을 죽은 것으로 오인하지 않기 위해서다.
 */
export function recoverDanglingTurns(pkg: string, slot: string): boolean {
  const dir = sessionDir(pkg, slot);
  const hist = path.join(dir, "history.jsonl");
  if (!fs.existsSync(hist)) return false;
  const lines = fs.readFileSync(hist, "utf8").trim().split("\n").filter(Boolean);
  if (!lines.length) return false;
  let last: { role?: string } | null = null;
  try {
    last = JSON.parse(lines[lines.length - 1]);
  } catch {
    return false;
  }
  if (last?.role !== "user") return false;

  const text = deltaText(path.join(dir, "events.jsonl"));
  appendBot(
    pkg,
    slot,
    text
      ? `${text}\n\n(작업 도중 기판이 멈춰 답변이 끝까지 저장되지 못했습니다. 여기까지 오간 내용입니다.)`
      : "(작업 도중 기판이 멈춰 답변이 저장되지 못했습니다. 남은 내용이 없습니다.)",
  );
  return true;
}

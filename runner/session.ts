import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { API_URL, RELAY_HOME, PRINCIPAL, pkgToken, sessionDir, workspaceDir, stageDir, logLine, type Ledger } from "./state.ts";
import { loadManifest, landingAgentName, activeHarness, type Manifest } from "./manifest.ts";


export interface SessionInput {
  ledger: Ledger;
  pkg: string;
  agent?: string;
  prompt?: string;
  slot?: string;
  interactive?: boolean;
  /** workspace 상대경로. 업로드 라우트가 발급한 참조만 유효하다 */
  attachments?: { path: string; name?: string }[];
}

export interface SessionResult {
  reply: string;
  code: number;
  /** 봉투 reply 이벤트가 알려준 실제 사용 모델 (별칭 해석 결과) */
  model?: string | null;
  /** 봉투 reply 이벤트의 토큰 장부 {input, output, context_window} — 위젯의 컨텍스트 게이지용 */
  usage?: unknown;
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

  logLine("sessions", { pkg: input.pkg, agent, slot, mode: input.interactive ? "tty" : "auto" });

  if (input.interactive) {
    return await new Promise((resolve) => {
      const child = spawn(entry, ["session"], { cwd: workdir, env, stdio: "inherit" });
      child.on("exit", (code) => resolve({ reply: "", code: code ?? 0 }));
    });
  }

  const atts = safeAttachments(input.attachments);
  const prompt = atts.length
    ? `첨부 파일 — Read 도구로 읽어라:\n${atts.map((a) => "- " + path.join(stage, a.path)).join("\n")}\n\n${input.prompt ?? ""}`
    : input.prompt ?? "";

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
  // 받는다. 어댑터의 protocol 선언을 세션마다 조회하지 않아도 신구가 공존한다
  const turn = new Promise<{ reply: string; code: number; model: string | null; usage: unknown }>((resolve, reject) => {
    const child = spawn(entry, ["session", prompt], { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] });
    live.set(key, child);
    let raw = "";
    let err = "";
    let reply: { text: string; model: string | null; usage: unknown } | null = null;
    let errEvent = "";
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
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
        };
      } else if (ev.event === "error") {
        errEvent = String(ev.message ?? "");
      } else if (ev.event === "file" && typeof ev.path === "string" && !ev.path.startsWith("/") && !ev.path.split("/").includes("..")) {
        evFiles.push({ path: ev.path, name: path.basename(ev.path) });
      }
    });
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      live.delete(key);
      reject(e);
    });
    child.on("close", (code) => {
      live.delete(key);
      if (reply) return resolve({ reply: reply.text, code: code ?? 0, model: reply.model, usage: reply.usage });
      if (errEvent) return reject(new Error(errEvent));
      const legacy = raw.trim();
      if (code !== 0 && !legacy) return reject(new Error(`하네스 종료 코드 ${code}: ${err.slice(-500)}`));
      resolve({ reply: legacy, code: code ?? 0, model: null, usage: null });
    });
  });

  // 실패도 이력이다. 물음만 남기고 끝내면 다음 기동의 복구가 죽은 턴으로 오해한다
  let r: { reply: string; code: number; model: string | null; usage: unknown };
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
  appendBot(input.pkg, slot, r.reply, { model: r.model, usage: r.usage, files });
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
  extra: { model?: string | null; usage?: unknown; files?: { path: string; name: string }[] } = {},
): void {
  writeRecord(pkg, slot, {
    t: new Date().toISOString(),
    role: "bot",
    text: reply.slice(0, HISTORY_TEXT_CAP),
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.usage ? { usage: extra.usage } : {}),
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

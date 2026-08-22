// client-wire.ts — 클라이언트 전송 계약 v1(docs/client-protocol.md)의 서버 반쪽.
//
// 배선됨(원자 컷 §9-47-3): api.ts 가 /registry 직후 `if (await handleClientWire(...)) return;`
// 로 마운트하고, session.ts 의 봉투 기록 지점이 setEnvelopeTap 주입을 통해 tapSessionEvent 를
// 부른다(session→client-wire 직접 import 는 순환이라 조립점 api.ts 가 주입한다).
//
// http 보조(json/readBody/MIME)는 api.ts 관용구의 자체 사본이다 — api.ts 를 import 하면
// 순환(api → installer → …)이자 배선이 되므로 금지. 컷에서 구 wire 삭제와 함께 단일화한다.
// 오류 봉투는 구 wire({error: string})가 아니라 계약의 {error:{code,message}} 다(§5.0-10).

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RELAY_HOME, sessionDir, stageDir, saveLedger, type Ledger } from "./state.ts";
import { runSession, cancelSession, autoTitleSession, deliverAnswer, isSessionBusy, retireResident } from "./session.ts";
import { loadManifest, landingAgentName, activeHarness, type Manifest } from "./manifest.ts";
import { harnessVerb } from "./installer.ts";
import { SLOT_RE, UPLOADS_DIR, UPLOADS_PREFIX } from "./protocol.ts";
import type { Authority } from "./authority-contract.ts";

/** 클라이언트 프로토콜 버전 — §9-47-3 의 컷부터 발효. 하네스 봉투 protocol(현재 3)과 별개 축 */
export const CLIENT_PROTOCOL = 1;

export interface ClientWireDeps {
  getLedger: () => Ledger;
  authority: Authority;
}

// ── http 보조 — api.ts 관용구의 사본 (컷에서 단일화) ─────────────────────────

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
};

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 계약 오류 봉투(§5.0-10) — HTTP 상태 + {error:{code,message}}. code 는 E_ 접두 */
function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

/** 핸들러가 던지면 dispatch 그물이 봉투로 바꾼다 — 상태·코드를 실은 fail-loud 통로 */
class WireError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 신 wire 의 본문은 JSON 단일이다(§5.0-11) — 구 wire 와 달리 form-urlencoded 분기가 없다
async function readBody(req: http.IncomingMessage): Promise<any> {
  // 형식 판정은 api.ts 의 Origin 검사와 짝이다: content-type 을 안 보고 파싱하면 브라우저가
  // 프리플라이트 없이 보낼 수 있는 simple request(text/plain·form)가 상태 변경 문에 그대로
  // 닿는다. 미선언은 통과 — 브라우저가 아닌 소비자(어댑터·CLI)는 헤더를 안 붙이기도 한다
  const ctype = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ctype && ctype !== "application/json") {
    throw new WireError(415, "E_BAD_CONTENT_TYPE", `본문은 application/json 이어야 합니다: ${ctype}`);
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new WireError(400, "E_BAD_JSON", "본문이 JSON 이 아닙니다");
  }
}

/**
 * 장부를 **인자로 받는다** — deps.getLedger() 는 요청마다 파일을 다시 읽어 매번 새 객체를 준다.
 * 안에서 몰래 부르면 "레코드를 준 장부"와 "저장할 장부"가 갈려, 쓴 값이 조용히 버려진다:
 * 실사고 — POST /model 이 200 {ok:true} 를 돌려주는데 원장은 그대로였다(모델이 안 바뀐다는 보고).
 * 호출자가 자기 장부를 넘기게 해서 그 갈림이 타입에서 보이게 한다.
 */
function requirePkg(l: Ledger, pkg: string): { path: string; model?: string; effort?: string; harness?: string } {
  const rec = l.packages[pkg];
  if (!rec) throw new WireError(404, "E_NO_PKG", `미설치 패키지: ${pkg}`);
  return rec;
}

// ── SSE 프레이밍(§5.2) — 이벤트 하나 = data: JSON 하나, 15초 하트비트 :hb ────

const HEARTBEAT_MS = 15_000;

interface Sse {
  /** line 은 직렬화된 JSON 한 덩이 — data: 한 줄에 그대로 싣는다(§5.2-18) */
  send(line: string): void;
  /** 서버측 정상 종결 — settled 이후에만 부른다(§5.2-20) */
  close(): void;
  /** 절단·종결 공통 정리 콜백(구독 해제 등) */
  onClose(fn: () => void): void;
}

function openSse(req: http.IncomingMessage, res: http.ServerResponse): Sse {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  // 이벤트 공백이 15초를 넘기 전에 주석 라인을 흘린다 — 중간 프록시 idle timeout 의
  // 조용한 절단을 §5.2-20 판정으로 드러나게 하는 최소 장치(§5.2-19)
  const hb = setInterval(() => {
    res.write(":hb\n\n");
  }, HEARTBEAT_MS);
  hb.unref?.();
  let open = true;
  const onCloseFns: (() => void)[] = [];
  const shut = (): void => {
    if (!open) return;
    open = false;
    clearInterval(hb);
    for (const f of onCloseFns) {
      try { f(); } catch { /* 정리 실패가 다른 정리를 막으면 안 된다 */ }
    }
  };
  req.on("close", shut);
  return {
    send(line: string): void {
      if (open) res.write("data: " + line + "\n\n");
    },
    close(): void {
      if (open) res.end();
      shut();
    },
    onClose(fn: () => void): void {
      onCloseFns.push(fn);
    },
  };
}

// ── 턴 단위 이벤트 장부(§6-35 리플레이 원천) ─────────────────────────────────
// 현행 events.jsonl(session.ts)은 턴마다 truncate 되어 종결 턴 재생(§5.1-13)과
// attach 처음부터 재생(§5.1-14)의 원천이 못 된다. 신 wire 는 턴마다 독립 장부를 쓴다:
//   ~/.relay/sessions/<pkg>/<slot>/turns/<turnId>.jsonl
// 장부 한 줄 = {t, ...봉투이벤트} — events.jsonl 과 같은 어휘라 라이브 SSE 와 재생이
// 같은 JSON 을 나른다(§5.2-18 의 단일 축).

const TURNS_DIR = "turns";
/** 슬롯당 보존 상한 — 재생 계약의 보존 정책은 기판 소유다. 무한 축적만 막는다 */
const TURN_LEDGER_KEEP = 200;

interface EnvelopeEvent {
  event: string;
  [k: string]: unknown;
}

interface TurnSink {
  write(line: string): void;
  end(): void;
}

interface TurnRecord {
  id: string;
  pkg: string;
  session: string;
  status: "queued" | "running" | "settled";
  ok: boolean | null;
  /** 턴 장부 경로 — 202 시점에 빈 파일로 실재한다(stream 이 즉시 붙어도 읽을 파일이 있게) */
  file: string;
  sinks: Set<TurnSink>;
  /** reply/error 봉투가 장부를 지나갔는가 — 지나지 않은 턴만 종결 봉투를 합성한다 */
  settledEnvelope: boolean;
  /** 봉투 file 이벤트가 이미 알린 stage 상대경로 — 종결 시 무대 산출물 중복 고지를 막는다 */
  announcedFiles: Set<string>;
}

const turns = new Map<string, TurnRecord>();
/** 세션별 턴 열 — [0] 이 진행(또는 다음 실행) 턴. attach 의 착지점 */
const sessionQueues = new Map<string, TurnRecord[]>();
/** 세션 직렬화 지점(§5.1-12) — 기판만이 세션의 유일한 직렬화 지점이다 */
const sessionChains = new Map<string, Promise<void>>();

function sessionKey(pkg: string, session: string): string {
  return pkg + "/" + session;
}

/** 그 세션의 진행 중 턴 — running 이 없으면 첫 queued. 없으면 null */
function activeTurn(pkg: string, session: string): TurnRecord | null {
  return sessionQueues.get(sessionKey(pkg, session))?.[0] ?? null;
}

/** 장부 기록 + 라이브 중계 — 봉투 이벤트는 번역 없이 그대로 나른다(§6-35 데몬=파이프) */
function appendTurnEvent(t: TurnRecord, ev: EnvelopeEvent): void {
  const line = JSON.stringify({ t: Date.now(), ...ev });
  try {
    fs.appendFileSync(t.file, line + "\n");
  } catch { /* 세션 삭제 경합 — 기록만 포기, 라이브 중계는 계속 (session.ts idleEvent 와 같은 판정) */ }
  if (ev.event === "reply" || ev.event === "error") t.settledEnvelope = true;
  if (ev.event === "file" && typeof ev.path === "string") t.announcedFiles.add(ev.path);
  for (const s of [...t.sinks]) s.write(line);
}

/**
 * runSession 이벤트 스트림에 얹는 기록 훅 — session.ts 의 봉투 기록 지점이 부른다
 * (배선은 api.ts createApi 의 setEnvelopeTap(tapSessionEvent) — session→client-wire 직접
 * import 는 순환이라 조립점이 주입한다).
 * wire 가 모르는 턴(a2a dispatch·자동 제목 등 runSession 직접 호출)의 이벤트는 여기 와도
 * 활성 턴이 없어 버려진다 — 그 턴들의 관찰 창은 신 wire 밖이다.
 */
export function tapSessionEvent(pkg: string, slot: string, ev: EnvelopeEvent): void {
  const t = activeTurn(pkg, slot);
  if (!t || t.status !== "running") return;
  appendTurnEvent(t, ev);
}

function settleTurn(t: TurnRecord, ok: boolean): void {
  if (t.status === "settled") return;
  t.status = "settled";
  t.ok = ok;
  // 수명주기 settled(§6-36) — 스트림의 마지막 이벤트. 장부에도 앉아 재생이 같은 종결을 본다
  appendTurnEvent(t, { event: "turn", status: "settled", turn: t.id, ok });
  const key = sessionKey(t.pkg, t.session);
  const q = sessionQueues.get(key);
  if (q) {
    const i = q.indexOf(t);
    if (i >= 0) q.splice(i, 1);
    if (!q.length) {
      sessionQueues.delete(key);
      sessionChains.delete(key);
    }
  }
  // settled 후 서버가 스트림을 닫는다(§5.2-20)
  for (const s of [...t.sinks]) s.end();
  t.sinks.clear();
  // 종결한 턴은 메모리에서 내려간다 — 재생의 원천은 디스크 장부(findTurnFile)라 stream 은
  // 그대로 성립한다. 이 삭제가 없으면 데몬 수명 동안 턴 레코드가 무한 누적된다
  turns.delete(t.id);
}

async function runTurn(deps: ClientWireDeps, t: TurnRecord, body: any): Promise<void> {
  if (t.status === "settled") return; // 대기 중 interrupt 로 이미 종결된 턴
  t.status = "running";
  // 수명주기 started(§6-36) — 관찰이 어느 턴에 붙었는지의 에코. 장부 첫 줄이라 attach 재생에서도 맨 앞
  appendTurnEvent(t, { event: "turn", status: "started", turn: t.id, session: t.session });
  let ok = false;
  try {
    const r = await runSession({
      ledger: deps.getLedger(),
      pkg: t.pkg,
      authority: deps.authority,
      prompt: String(body.message ?? ""),
      slot: t.session,
      // agent 미지정 개설은 runSession 이 슬롯의 agent 메타로 폴백한다 — 위임 대화에
      // 문법 모르는 소비자가 열어도 착지 에이전트로 새지 않는다
      agent: body.agent ? String(body.agent) : undefined,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
      scene: body.scene ? String(body.scene) : undefined,
    });
    // 무대 산출물 고지 — 구 wire 는 이것을 응답의 files 로 실어 보냈다(구 POST /chat).
    // 신 wire 의 자리는 봉투 어휘의 file 이벤트다(§6-35): stage diff 로만 발견된 파일은
    // 어댑터가 알린 적이 없으므로 여기서 알린다. settled 앞이라 재생에서도 같은 자리에 온다
    for (const f of r.files ?? []) {
      if (!t.announcedFiles.has(f.path)) appendTurnEvent(t, { event: "file", path: f.path });
    }
    // 봉투 reply 가 훅(tapSessionEvent)으로 이미 지나갔으면 합성하지 않는다 — 이중 종결 방지.
    // 지나지 않은 경우(훅 미배선·구형 통짜 어댑터)는 runSession 결과로 종결 봉투를 세운다
    if (!t.settledEnvelope) {
      appendTurnEvent(t, { event: "reply", text: r.reply, model: r.model ?? null, usage: r.usage ?? null, context: r.context ?? null });
    }
    ok = true;
  } catch (e) {
    if (!t.settledEnvelope) {
      appendTurnEvent(t, { event: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
  settleTurn(t, ok);
  // 첫 교환이 완결된 무명 세션의 자동 제목 — 구 /chat 관용구 유지(fire-and-forget)
  void autoTitleSession(deps.getLedger(), t.pkg, t.session).catch(() => { /* 제목 실패는 무시 */ });
}

function pruneTurnLedgers(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
  if (files.length <= TURN_LEDGER_KEEP) return;
  const dated = files
    .map((e) => {
      const p = path.join(dir, e.name);
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch { /* 경합 삭제 */ }
      return { p, mt };
    })
    .sort((a, b) => a.mt - b.mt);
  for (const f of dated.slice(0, dated.length - TURN_LEDGER_KEEP)) fs.rmSync(f.p, { force: true });
}

function enqueueTurn(deps: ClientWireDeps, pkg: string, session: string, body: any): TurnRecord {
  const dir = path.join(sessionDir(pkg, session), TURNS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  pruneTurnLedgers(dir);
  const id = crypto.randomUUID();
  const t: TurnRecord = {
    id,
    pkg,
    session,
    status: "queued",
    ok: null,
    file: path.join(dir, id + ".jsonl"),
    sinks: new Set(),
    settledEnvelope: false,
    announcedFiles: new Set(),
  };
  fs.writeFileSync(t.file, "");
  turns.set(id, t);
  const key = sessionKey(pkg, session);
  const q = sessionQueues.get(key) ?? [];
  q.push(t);
  sessionQueues.set(key, q);
  // 같은 세션의 진행 중 턴 뒤에 도착순으로 직렬화한다(§5.1-12) — 클라이언트 큐는 은퇴
  const chain = (sessionChains.get(key) ?? Promise.resolve()).then(() => runTurn(deps, t, body));
  sessionChains.set(key, chain.catch(() => { /* runTurn 은 던지지 않는다 — 사슬 보존 그물 */ }));
  return t;
}

// 턴 id 는 서버 발급(randomUUID)이라 이 문법이 전부다 — 경로 인자의 탈출 방지 검증
const TURN_ID_RE = /^[A-Za-z0-9-]{1,80}$/;

/** 디스크의 종결 턴 장부 찾기 — 데몬 재기동 후에도 stream 재생(§5.1-13)이 성립하는 근거 */
function findTurnFile(pkg: string, id: string): string | null {
  if (!TURN_ID_RE.test(id)) return null;
  const root = path.join(RELAY_HOME, "sessions", pkg);
  if (!fs.existsSync(root)) return null;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = path.join(root, e.name, TURNS_DIR, id + ".jsonl");
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function ledgerLines(file: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      JSON.parse(l); // 부서진 줄(기록 중 사망)은 재생하지 않는다 — data: 는 JSON 한 덩이어야 한다
      out.push(l);
    } catch { /* skip */ }
  }
  return out;
}

/** 진행 중(또는 방금 종결된 메모리 내) 턴에 관찰을 붙인다 — 장부 재생 후 라이브(§5.1-13/14) */
function openLiveStream(t: TurnRecord, req: http.IncomingMessage, res: http.ServerResponse): void {
  const sse = openSse(req, res);
  // 재생→구독 사이에 await 가 없어야 한다 — 동기 한 틱 안이라 이벤트가 새지 않는다
  for (const line of ledgerLines(t.file)) sse.send(line);
  if (t.status === "settled") return void sse.close();
  const sink: TurnSink = {
    write: (line) => sse.send(line),
    end: () => sse.close(),
  };
  t.sinks.add(sink);
  // 클라이언트 절단은 관찰만 사라진다 — 턴은 계속 돌고, 복귀는 attach(§5.2-20)
  sse.onClose(() => t.sinks.delete(sink));
}

/** 디스크 장부만 남은 종결 턴 — 재생 후 즉시 종결·EOF. settled 없는 장부(데몬 사망 턴)는
 *  영원히 종결되지 않을 턴이므로 합성 settled(ok:false)로 정직하게 닫는다 */
function replaySettledFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, id: string): void {
  const sse = openSse(req, res);
  let settled = false;
  for (const line of ledgerLines(file)) {
    sse.send(line);
    try {
      const ev = JSON.parse(line);
      if (ev.event === "turn" && ev.status === "settled") settled = true;
    } catch { /* ledgerLines 가 걸렀다 */ }
  }
  if (!settled) sse.send(JSON.stringify({ t: Date.now(), event: "turn", status: "settled", turn: id, ok: false }));
  sse.close();
}

// ── capabilities(§3·§7) — 미구현은 목록에서 뺀다, 선언해 놓고 실패는 위반 ────

// effort capability 는 하네스 어댑터 capability 의 투영(§7)이다. 어댑터 info 는 프로세스
// 1회 비용이라 entry mtime 캐시로 어댑터당 한 번만 돈다(session.ts serveCache 와 같은 결)
const capsCache = new Map<string, { mtime: number; caps: string[] }>();

function harnessAdapterCaps(deps: ClientWireDeps, pkg: string): string[] | null {
  const rec = deps.getLedger().packages[pkg];
  if (!rec) return null;
  let m: Manifest;
  try {
    m = loadManifest(rec.path);
  } catch {
    return null;
  }
  const v = activeHarness(m, rec.harness);
  if (!v) return null; // 하네스 미동봉 — harness 조회 동사 자체가 없다
  const entry = path.join(rec.path, v.source, v.entry);
  let mtime: number;
  try {
    mtime = fs.statSync(entry).mtimeMs;
  } catch {
    return null;
  }
  const hit = capsCache.get(entry);
  if (hit && hit.mtime === mtime) return hit.caps;
  let caps: string[] = [];
  try {
    const r = harnessVerb(deps.getLedger(), pkg, "info");
    const j = JSON.parse(r.out || "{}");
    if (Array.isArray(j.capabilities)) caps = j.capabilities.filter((c: unknown): c is string => typeof c === "string");
  } catch { /* info 불달 — 어댑터 capability 없음으로 판정(선언 못 하는 것이 정직) */ }
  capsCache.set(entry, { mtime, caps });
  return caps;
}

// ── 세션·이력 조회 — api.ts 구 라우트와 같은 정본(디스크)을 읽되 계약 shape 로 ─

function sessionsRoot(pkg: string): string {
  return path.join(RELAY_HOME, "sessions", pkg);
}

/** §5.3-21 — 고정 우선, 그 안에서 최근순. 라벨 우선순위(label > auto-label > 첫 발화)는 기판 내부 규칙 */
function listSessionRows(pkg: string): { session: string; label: string; updated: number; archived: boolean; pinned: boolean; agent?: string; param?: string }[] {
  const root = sessionsRoot(pkg);
  if (!fs.existsSync(root)) return [];
  const rows: { session: string; label: string; updated: number; archived: boolean; pinned: boolean; agent?: string; param?: string }[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    // "_" 접두 슬롯은 기판 내부용(자동 제목 등의 임시 세션) — 목록에 내지 않는다
    if (!e.isDirectory() || !SLOT_RE.test(e.name) || e.name.startsWith("_")) continue;
    const dir = path.join(root, e.name);
    const hist = path.join(dir, "history.jsonl");
    let label = "";
    for (const f of ["label", "auto-label"]) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) label = fs.readFileSync(p, "utf8").trim();
      if (label) break;
    }
    if (!label && fs.existsSync(hist)) {
      try {
        label = String(JSON.parse(fs.readFileSync(hist, "utf8").split("\n", 1)[0]).text ?? "").slice(0, 40);
      } catch {
        label = "";
      }
    }
    const updated = fs.statSync(fs.existsSync(hist) ? hist : dir).mtimeMs;
    // agent 메타(위임 세션의 정체성) — §5.3-24 additive. 화면이 이 값으로 대화의 에이전트
    // 칩을 세우고, 없으면 종전(착지) 그대로다
    let rowAgent = "";
    let rowParam = "";
    try {
      rowAgent = fs.readFileSync(path.join(dir, "agent"), "utf8").trim();
    } catch { /* 메타 없음 */ }
    try {
      rowParam = fs.readFileSync(path.join(dir, "param"), "utf8").trim();
    } catch { /* 메타 없음 */ }
    rows.push({
      session: e.name,
      ...(rowAgent ? { agent: rowAgent } : {}),
      ...(rowParam ? { param: rowParam } : {}),
      label: label || e.name,
      updated,
      archived: fs.existsSync(path.join(dir, "archived")),
      pinned: fs.existsSync(path.join(dir, "pinned")),
    });
  }
  rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
  return rows;
}

/** history.jsonl → 계약 message shape(§5.3-24: role·text·files?·usage?·context?·model?) */
function historyMessages(pkg: string, slot: string, limit: number): Record<string, unknown>[] {
  const file = path.join(sessionsRoot(pkg), slot, "history.jsonl");
  if (!fs.existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const l of fs.readFileSync(file, "utf8").trim().split("\n").slice(-limit)) {
    let rec: any;
    try {
      rec = JSON.parse(l);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    out.push({
      role: String(rec.role ?? ""),
      text: String(rec.text ?? ""),
      ...(rec.files ? { files: rec.files } : {}),
      ...(rec.usage ? { usage: rec.usage } : {}),
      ...(rec.context ? { context: rec.context } : {}),
      ...(rec.model ? { model: rec.model } : {}),
    });
  }
  return out;
}

/** 착지 에이전트의 패키지 커맨드 — harness.commands 병합의 기판 반쪽(api.ts pkgCommands 사본, 컷에서 단일화) */
function pkgCommandRows(ledger: Ledger, pkg: string): { name: string; description: string; tty: boolean }[] {
  const rec = ledger.packages[pkg];
  if (!rec) return [];
  const m = loadManifest(rec.path);
  const landing = landingAgentName(m);
  const decl = (m.agents ?? []).find((a) => a.name === landing);
  if (!decl?.commands) return [];
  const dir = path.join(rec.path, decl.commands);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    const desc = body.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    return { name: f.replace(/\.md$/, ""), description: desc, tty: false };
  });
}

// ── 라우팅 테이블 — 경로 패턴(base/root 상대) → 핸들러 ──────────────────────
// {base}=/pkg/<pkg> · {root}=/ 는 기판의 마운트 지점이지 계약이 아니다(§2-6).
// 클라이언트는 base 주입으로 이 좌표를 받는다 — 마운트 문법을 아는 쪽은 이 파일뿐이다.

export interface WireCtx {
  deps: ClientWireDeps;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** base 스코프의 마운트 키(패키지 이름). root 스코프는 빈 문자열 */
  pkg: string;
  m: RegExpMatchArray;
}

export interface WireRoute {
  methods: string[];
  scope: "base" | "root";
  pattern: RegExp;
  handler: (ctx: WireCtx) => void | Promise<void>;
}

const MAX_UPLOAD = 100 * 1024 * 1024;

export const WIRE_ROUTES: WireRoute[] = [
  // ── 개막(§3-7): {protocol, capabilities}. push·state 는 OSS 미구현 — 목록에서 뺀다(§3-8) ──
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/capabilities$/,
    handler: ({ deps, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      // enumerate: /registry 재포장으로 구현(§5.6-32) · upload-progress: 업로드가 전 구간
      // 스트리밍이라 진행률이 실제를 반영한다(§5.4-28, 아래 upload 핸들러가 그 구현)
      const caps = ["enumerate", "upload-progress"];
      const adapter = harnessAdapterCaps(deps, pkg);
      if (adapter) {
        // 하네스 조회 3동사는 어댑터 필수 동사(info/models/commands)의 중계라 하네스가 있으면 산다
        caps.push("harness-info", "harness-models", "harness-commands");
        if (adapter.includes("effort")) caps.push("effort"); // 어댑터 capability 의 투영(§7)
        // 변형 선택은 자격 행위가 아니라 설정이다(§5.5-30-a) — 매니페스트가 후보를 선언하고
        // 장부가 활성 하나를 든다. 후보가 둘 이상일 때만 고를 것이 있다.
        try {
          const man = loadManifest(deps.getLedger().packages[pkg].path);
          if ((man.harness?.variants ?? []).length > 1) caps.push("harness-variants");
        } catch { /* 판정 실패 설치본 — 선언 못 하는 것이 정직 */ }
      }
      json(res, 200, { protocol: CLIENT_PROTOCOL, capabilities: caps });
    },
  },

  // ── 턴(§5.1): 비블로킹 시작 + SSE 관찰 ──────────────────────────────────
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/turns$/,
    handler: async ({ deps, req, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const b = await readBody(req);
      const session = String(b.session ?? "");
      if (!SLOT_RE.test(session)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${session}`);
      const t = enqueueTurn(deps, pkg, session, b);
      // 202 — 턴 종결을 붙들지 않는다(§5.1-12). 관찰은 stream/attach 로 몇 번이든 다시 연다
      json(res, 202, { turn: t.id, session });
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/turns\/attach$/,
    handler: ({ deps, req, res, url, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const session = String(url.searchParams.get("session") ?? "");
      if (!SLOT_RE.test(session)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${session}`);
      // wire 가 개설한 턴만 attach 대상이다 — runSession 직접 호출(a2a 등)의 busy 는
      // 신 wire 의 관찰 창 밖이므로 E_NO_TURN 이 맞다(§5.1-14)
      const t = activeTurn(pkg, session);
      if (!t) throw new WireError(404, "E_NO_TURN", `진행 중 턴 없음: ${session}`);
      openLiveStream(t, req, res);
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/turns\/([A-Za-z0-9-]{1,80})\/stream$/,
    handler: ({ deps, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const id = m[1];
      const t = turns.get(id);
      if (t && t.pkg === pkg) return void openLiveStream(t, req, res);
      const file = findTurnFile(pkg, id); // 데몬 재기동 이전의 종결 턴 — 디스크 장부 재생
      if (!file) throw new WireError(404, "E_NO_TURN", `없는 턴: ${id}`);
      replaySettledFile(req, res, file, id);
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/turns\/([A-Za-z0-9-]{1,80})\/interrupt$/,
    handler: ({ deps, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const t = turns.get(m[1]);
      // 종결과 함께 메모리에서 내려간 턴 — 장부가 남아 있으면 "있었지만 끝난 턴"이라
      // ok:false 로 답한다(애초에 없는 턴의 404 와 구별한다)
      if (!t || t.pkg !== pkg) {
        if (findTurnFile(pkg, m[1])) return void json(res, 200, { ok: false });
        throw new WireError(404, "E_NO_TURN", `없는 턴: ${m[1]}`);
      }
      if (t.status === "queued") {
        // 시작 전 턴 — 봉투 제어가 닿을 프로세스가 없으므로 여기서 종결한다
        appendTurnEvent(t, { event: "error", message: "시작 전에 중단되었습니다" });
        settleTurn(t, false);
        return void json(res, 200, { ok: true });
      }
      // 봉투 cancel 제어(§5.1-15) — 종결은 봉투 error 이벤트가 가져온다
      json(res, 200, { ok: cancelSession(pkg, t.session) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/turns\/([A-Za-z0-9-]{1,80})\/respond$/,
    handler: async ({ deps, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const t = turns.get(m[1]);
      // 종결한 턴에는 회송할 ask 가 없다 — interrupt 와 같은 판정(장부 있음 = ok:false)
      if (!t || t.pkg !== pkg) {
        if (findTurnFile(pkg, m[1])) return void json(res, 200, { ok: false });
        throw new WireError(404, "E_NO_TURN", `없는 턴: ${m[1]}`);
      }
      const b = await readBody(req);
      // 봉투 ask 회송(§5.1-16) — 빈 answers = 사용자 취소
      json(res, 200, { ok: deliverAnswer(pkg, t.session, String(b.ask ?? ""), Array.isArray(b.answers) ? b.answers : []) });
    },
  },

  // ── 세션(§5.3): 서버 발급 불투명 id + 부속 동사 ─────────────────────────
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/sessions$/,
    handler: ({ deps, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      json(res, 200, { sessions: listSessionRows(pkg) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/sessions$/,
    handler: async ({ deps, req, res, pkg }) => {
      const ledger = deps.getLedger();
      requirePkg(ledger, pkg);
      // 대화 바인딩(§5.3-22 additive) — 화면 스레드 문법의 param 축은 기판 발급 id 에 실을 수
      // 없으므로 민팅 순간이 바인딩이 wire 에 닿는 유일한 자리다. 판정은 선언이다(agents[] 밖 =
      // 400). 기록된 메타는 §5.3-21 행으로 되돌아가고, runSession 이 페르소나 문맥으로 주입한다
      const b = await readBody(req);
      const agent = String(b.agent ?? "").trim();
      const param = String(b.param ?? "").trim();
      if (agent && !(loadManifest(ledger.packages[pkg].path).agents ?? []).some((a) => a.name === agent)) {
        throw new WireError(400, "E_BAD_AGENT", `agents[] 선언 밖 에이전트: ${agent}`);
      }
      if (param && !agent) throw new WireError(400, "E_BAD_PARAM", "param 은 agent 없이 설 수 없다");
      if (param.length > 256) throw new WireError(400, "E_BAD_PARAM", "param 이 너무 길다(≤256)");
      // 세션 id 는 기판 발급 불투명 문자열(§5.3-22) — SLOT_RE 는 내부 문법일 뿐 계약이 아니다
      const id = "s-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
      const dir = sessionDir(pkg, id); // 즉시 영속 — 발급한 세션이 목록·이력 조회에 곧장 실재한다
      if (agent) fs.writeFileSync(path.join(dir, "agent"), agent);
      if (param) fs.writeFileSync(path.join(dir, "param"), param);
      json(res, 200, { session: id });
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/sessions\/([^/]+)\/history$/,
    handler: ({ deps, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const slot = m[1];
      if (!SLOT_RE.test(slot)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${slot}`);
      // busy+turn(§5.3-24) — 새로고침 복구가 폴링 없이 한 왕복으로 끝나는 근거.
      // turn 은 wire 가 개설한 턴만 안다(attach 가능한 턴만 싣는 것이 정직하다)
      const t = activeTurn(pkg, slot);
      const busy = t != null || isSessionBusy(pkg, slot);
      json(res, 200, { messages: historyMessages(pkg, slot, 200), busy, ...(t ? { turn: t.id } : {}) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/sessions\/([^/]+)\/(rename|archive|pin|delete|reset)$/,
    handler: async ({ deps, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const slot = m[1];
      const op = m[2];
      if (!SLOT_RE.test(slot)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${slot}`);
      const dir = path.join(sessionsRoot(pkg), slot);
      if (op === "rename") {
        if (!fs.existsSync(dir)) throw new WireError(404, "E_NO_SESSION", `없는 세션: ${slot}`);
        const b = await readBody(req);
        const label = String(b.label ?? "").trim().slice(0, 80);
        if (label) fs.writeFileSync(path.join(dir, "label"), label);
        else fs.rmSync(path.join(dir, "label"), { force: true }); // 빈 문자열 = 자동 라벨 복귀(§5.3-23)
        return void json(res, 200, { ok: true });
      }
      if (op === "archive" || op === "pin") {
        if (!fs.existsSync(dir)) throw new WireError(404, "E_NO_SESSION", `없는 세션: ${slot}`);
        const b = await readBody(req);
        // marker 파일 하나가 상태의 전부 — 이력은 그대로 두고 목록의 자리만 옮긴다(§5.3-23)
        const marker = path.join(dir, op === "archive" ? "archived" : "pinned");
        const on = op === "archive" ? !!b.archived : !!b.pinned;
        if (on) fs.writeFileSync(marker, "");
        else fs.rmSync(marker, { force: true });
        return void json(res, 200, { ok: true, ...(op === "archive" ? { archived: on } : { pinned: on }) });
      }
      if (op === "delete") {
        // 대기 중 wire 턴은 먼저 종결한다 — 지워진 세션 위에서 턴 사슬이 계속 돌면 안 된다
        for (const t of [...(sessionQueues.get(sessionKey(pkg, slot)) ?? [])]) {
          if (t.status === "queued") {
            appendTurnEvent(t, { event: "error", message: "세션이 삭제되었습니다" });
            settleTurn(t, false);
          }
        }
        retireResident(pkg, slot); // 상주가 지워진 번들 경로를 물고 있으면 안 된다
        fs.rmSync(dir, { recursive: true, force: true });
        return void json(res, 200, { ok: true });
      }
      // reset — 이력은 두고 하네스 대화 포인터만 끊는다(§5.3-23). 포인터 파일 이름은 어댑터
      // 소유(claude-session·codex-thread·…)라 기판이 열거할 수 없다 — 종전엔 claude-session
      // 만 하드코딩해서 다른 하네스의 reset 이 무동작이었다. 번들을 통째로 비우는 것이
      // 이름을 모른 채 전부 회전시키는 유일한 방법이고, 다음 턴의 조립이 다시 채운다.
      retireResident(pkg, slot); // 상주가 낡은 대화를 메모리에 물고 있으면 포인터를 지워도 대화가 이어진다
      fs.rmSync(path.join(sessionDir(pkg, slot), "bundle"), { recursive: true, force: true });
      json(res, 200, { ok: true });
    },
  },

  // ── 파일(§5.4): upload 단일 동사(+프로브) · download ────────────────────
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/upload$/,
    handler: ({ deps, req, res, url, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      // 업로드 프로브(§5.4-26) — 바이트 전송 없이 인가·상한을 선판정한다. 2xx = 통과
      if (String(req.headers["x-upload-probe"] ?? "") === "1") {
        const size = Number(req.headers["x-upload-size"] ?? 0);
        if (!Number.isFinite(size) || size < 0) throw new WireError(400, "E_BAD_REQUEST", "X-Upload-Size 가 숫자가 아닙니다");
        if (size > MAX_UPLOAD) throw new WireError(413, "E_TOO_LARGE", `첨부 상한 초과: ${MAX_UPLOAD} bytes`);
        return void json(res, 200, { ok: true });
      }
      // 본문이 곧 바이트다(§5.4-25) — 전 구간 스트리밍(capability upload-progress 의 실체)
      const rawName = String(url.searchParams.get("name") ?? "file");
      const name = (rawName.split(/[\\/]/).pop() ?? "file").replace(/^\.+/, "_").slice(0, 128) || "file";
      const dir = path.join(stageDir(pkg), UPLOADS_DIR);
      fs.mkdirSync(dir, { recursive: true });
      let target = path.join(dir, name);
      if (fs.existsSync(target)) {
        const ext = path.extname(name);
        target = path.join(dir, path.basename(name, ext) + "-" + Date.now().toString(36) + ext);
      }
      let size = 0;
      let failed = false;
      const ws = fs.createWriteStream(target);
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD && !failed) {
          failed = true;
          ws.destroy();
          fs.rmSync(target, { force: true });
          fail(res, 413, "E_TOO_LARGE", `첨부 상한 초과: ${MAX_UPLOAD} bytes`);
          req.destroy();
        }
      });
      req.pipe(ws);
      ws.on("finish", () => {
        // 반환 path 는 클라이언트에게 불투명 참조다(§5.4-25) — UPLOADS_PREFIX 는 기판 내부 어휘
        if (!failed) json(res, 200, { path: UPLOADS_PREFIX + path.basename(target), size, name: path.basename(target) });
      });
      ws.on("error", (e) => {
        if (!failed) fail(res, 500, "E_INTERNAL", String(e));
      });
    },
  },
  {
    methods: ["GET", "HEAD"],
    scope: "base",
    pattern: /^\/file\/(.+)$/,
    handler: ({ deps, req, res, url, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      // stage 봉인 아래에서만(§5.4-27). HEAD 는 실재 프로브
      const root = path.normalize(stageDir(pkg));
      const target = path.normalize(path.join(root, decodeURIComponent(m[1])));
      if (target !== root && !target.startsWith(root + path.sep)) throw new WireError(403, "E_FORBIDDEN", "경로 탈출");
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) throw new WireError(404, "E_NO_FILE", "없는 파일");
      const head: Record<string, string> = {
        "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
        "content-length": String(fs.statSync(target).size),
      };
      if (url.searchParams.get("dl") === "1") {
        head["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
      }
      res.writeHead(200, head);
      if (req.method === "HEAD") return void res.end();
      fs.createReadStream(target).pipe(res);
    },
  },

  // ── 하네스 조회·설정(§5.5) — 관리 동사(variants·connect·login)는 계약 밖(§5.5-31) ──
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/harness\/(info|models|commands)$/,
    handler: ({ deps, res, pkg, m }) => {
      const rec = requirePkg(deps.getLedger(), pkg);
      const man = loadManifest(rec.path);
      // capability 미선언(하네스 미동봉) 동사 호출은 404 + 봉투(§3-8) — 코드는 기판 소유 어휘
      if (!activeHarness(man, rec.harness)) throw new WireError(404, "E_NO_HARNESS", `하네스 미동봉 패키지: ${pkg}`);
      const verb = m[1] as "info" | "models" | "commands";
      const r = harnessVerb(deps.getLedger(), pkg, verb);
      let value: unknown;
      try {
        value = JSON.parse(r.out);
      } catch {
        value = r.out;
      }
      if (verb === "commands") {
        // 패키지 커맨드 + 하네스 네이티브 커맨드의 병합 — 병합은 기판 몫(§5.5-29)
        const fromHarness = Array.isArray(value) ? value : [];
        return void json(res, 200, { ok: r.ok, value: [...pkgCommandRows(deps.getLedger(), pkg), ...fromHarness] });
      }
      json(res, 200, { ok: r.ok, value });
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/harness\/variants$/,
    handler: ({ deps, res, pkg }) => {
      const l = deps.getLedger();
      const rec = requirePkg(l, pkg);
      const man = loadManifest(rec.path);
      const variants = (man.harness?.variants ?? []).map((v) => ({
        name: v.name,
        ...(v.llm?.provider ? { provider: v.llm.provider } : {}),
      }));
      // 준비 상태(도구 실재·로그인)는 이 문의 소관이 아니다(§5.5-30-a) — 프로브는 프로세스
      // 전수 스폰이라 채팅 문이 감당할 비용이 아니고, 기판 소유 콘솔에 그 표면이 이미 있다.
      json(res, 200, { ok: true, value: { active: rec.harness ?? variants[0]?.name ?? null, variants } });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/model$/,
    handler: async ({ deps, req, res, pkg }) => {
      const l = deps.getLedger();
      const rec = requirePkg(l, pkg) as { model?: string; effort?: string; harness?: string };
      const b = await readBody(req);
      // 변형 전환이 먼저다 — setHarness 가 모델 오버라이드를 지우므로(모델 어휘는 하네스
      // 소속), 같은 요청의 model 이 그 뒤에 앉아야 지워지지 않는다. 미선언 이름은 거부된다.
      // 전환은 setup 을 이미 돌린다(installer.setHarness) — 그 판정을 버리지 않는다.
      // 준비 안 된 하네스로 바꾼 사람에게 아무 말도 안 하면, 다음 턴이 실패할 때까지
      // "왜 안 되지" 가 남는다. 실사고: 네이티브 바이너리가 빠진 codex 로 전환 → 무신호.
      let ready: { ok: boolean; note: string } | null = null;
      if (b.harness) {
        const { setHarness } = await import("./installer.ts");
        const { retireResidents } = await import("./session.ts");
        retireResidents(pkg); // 상주는 이전 하네스로 떠 있다 — 콘솔 전환 라우트(api.ts)와 같은 동반 조치
        try {
          const r = setHarness(l, pkg, String(b.harness));
          ready = { ok: r.setup.ok, note: r.setup.out.split("\n").slice(0, 2).join(" · ") };
        } catch (e) {
          throw new WireError(400, "E_BAD_REQUEST", String(e instanceof Error ? e.message : e));
        }
      }
      if ("model" in b) rec.model = b.model ? String(b.model) : undefined;
      if ("effort" in b) rec.effort = b.effort ? String(b.effort) : undefined;
      saveLedger(l);
      // known 은 경고가 아니라 판정 정보다(§5.5-30) — 저장은 되고, 어댑터가 세션에서 거부하면 그 턴이 실패한다
      let known: boolean | null = null;
      if (rec.model) {
        try {
          const r = harnessVerb(l, pkg, "models");
          const arr = JSON.parse(r.out);
          if (Array.isArray(arr)) known = arr.includes(rec.model);
        } catch { /* models 불달 — 판정 불가 */ }
      }
      json(res, 200, { ok: true, model: rec.model ?? null, effort: rec.effort ?? null, harness: rec.harness ?? null, known, ...(ready ? { ready } : {}) });
    },
  },

  // ── 열거(§5.6) — root 소속, /registry 데이터의 닫힌 shape 재포장 ─────────
  {
    methods: ["GET"],
    scope: "root",
    pattern: /^\/instances$/,
    handler: ({ deps, res }) => {
      const l = deps.getLedger();
      const instances: Record<string, unknown>[] = [];
      for (const [name, rec] of Object.entries(l.packages)) {
        let man: Manifest;
        try {
          man = loadManifest(rec.path);
        } catch {
          // 판정 실패 설치본 — 닫힌 shape 로 표현할 수 없다. 결함 표면은 기판 소유 콘솔(/registry)이다
          continue;
        }
        const greeting = man.surfaces?.chat?.greeting;
        instances.push({
          id: name, // base 마운트의 키 — 클라이언트는 이 id 로 base URL 을 얻는 기판 제공 함수를 쓴다(§2-6)
          display_name: man.display_name ?? name,
          ...(man.icon ? { icon: `/pkg/${encodeURIComponent(name)}/asset/${man.icon}` } : {}),
          ...(man.surfaces?.chat ? { chat: { ...(greeting ? { greeting } : {}) } } : {}),
          agents: (man.agents ?? []).map((a) => a.name),
          // 착지 에이전트 판정 결과 — 정본은 manifest.landingAgentName, 클라 재구현 금지(§8-42)
          agent: landingAgentName(man),
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.effort ? { effort: rec.effort } : {}),
        });
      }
      json(res, 200, { instances });
    },
  },
];

// ── 부착 함수 — Phase 2 가 api.ts 에 한 줄로 마운트한다 ──────────────────────

/**
 * 신 wire dispatch. 매치되면 응답까지 책임지고 true, 아니면 손대지 않고 false 를 돌려
 * 호출측(api.ts)의 나머지 라우팅이 이어진다. base 마운트 문법(/pkg/<pkg>)은 기판 소유이며
 * 이 함수 안에서만 해석된다 — 클라이언트에는 base URL 주입으로 전달된다(§2-6).
 */
export async function handleClientWire(
  deps: ClientWireDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const p = url.pathname;

  const run = async (route: WireRoute, pkg: string, m: RegExpMatchArray): Promise<boolean> => {
    try {
      await route.handler({ deps, req, res, url, pkg, m });
    } catch (e) {
      if (e instanceof WireError) fail(res, e.status, e.code, e.message);
      else fail(res, 500, "E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
    return true;
  };

  for (const r of WIRE_ROUTES) {
    if (r.scope !== "root" || !r.methods.includes(method)) continue;
    const m = p.match(r.pattern);
    if (m) return run(r, "", m);
  }

  const base = p.match(/^\/pkg\/([^/]+)(\/.*)?$/);
  if (!base) return false;
  const pkg = decodeURIComponent(base[1]);
  const rest = base[2] ?? "/";
  for (const r of WIRE_ROUTES) {
    if (r.scope !== "base" || !r.methods.includes(method)) continue;
    const m = rest.match(r.pattern);
    if (m) return run(r, pkg, m);
  }
  return false;
}

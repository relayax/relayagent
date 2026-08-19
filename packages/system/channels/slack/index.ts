// Slack 채널 어댑터 — surfaces.channels 계약의 참조 구현 (Socket Mode, 의존성 0).
//
// 자격: relay connect <패키지> slack — Socket Mode 는 자격이 둘이다(앱 레벨 xapp- 토큰으로
//       소켓을 열고, 봇 xoxb- 토큰으로 발화한다). JSON {"app":"xapp-…","bot":"xoxb-…",
//       "allow":["U…"]} 으로 붙여넣는다 → RELAY_CRED_SLACK. 콘솔 채널 다이얼로그는 매니페스트의
//       credential 선언대로 칸을 그려 이 JSON 을 대신 조립한다. 공백 구분 한 줄도 계속 받는다.
// 게이트: 기본 닫힘 — 자격의 allow(사용자 id 목록)에 있는 발화자만 착신. 게이트가 자격에 사는
//        이유: 데몬 env 로만 열면 화면에서 열 길이 없어 GUI 로 연결한 채널이 영영 닫혀 있다.
//        RELAY_SLACK_ALLOW env 는 하위호환 폴백으로 남는다.
//        채널(그룹)에서는 앱 멘션이 있어야 응답 범위에 든다(DM 은 불요).
// session: slack-<채널id>[-<스레드ts>] — 스레드는 자기 세션으로 이어진다.
// 발신:  stdin JSON {"type":"post","conversation":"<채널id>[:<스레드ts>]","text","files"?}.
// 검사:  RELAY_CONFORM=1 이면 외부 연결 없이 자기 서술 한 줄 + exit 0.
import readline from "node:readline";

const NAME = process.env.RELAY_NAME ?? "";
const CHANNEL = process.env.RELAY_CHANNEL ?? "slack";
const API = process.env.RELAY_API ?? "";
const TOKEN = process.env.RELAY_TOKEN ?? "";
const idList = (v: unknown): string[] =>
  (Array.isArray(v) ? v.map(String) : String(v ?? "").split(",")).map((s) => s.trim()).filter(Boolean);

if (process.env.RELAY_CONFORM === "1") {
  console.log(JSON.stringify({ name: "slack", protocol: 1, capabilities: ["post", "files"] }));
  process.exit(0);
}

function parseCred(raw: string): { app: string; bot: string; allow: string[] } | null {
  try {
    const j = JSON.parse(raw);
    if (j?.app && j?.bot) return { app: String(j.app), bot: String(j.bot), allow: idList(j.allow) };
  } catch { /* JSON 아님 — 공백 구분 시도 */ }
  const parts = raw.split(/\s+/).filter(Boolean);
  const app = parts.find((p) => p.startsWith("xapp-"));
  const bot = parts.find((p) => p.startsWith("xoxb-"));
  return app && bot ? { app, bot, allow: [] } : null;
}
const cred = parseCred(process.env.RELAY_CRED_SLACK ?? "");
const ALLOW = new Set([...(cred?.allow ?? []), ...idList(process.env.RELAY_SLACK_ALLOW)]);
if (!cred) {
  console.log(`slack: 자격 없음/형식 위반 — relay connect ${NAME} ${CHANNEL} 에 "xapp-... xoxb-..." 를 붙여넣으세요 (종료)`);
  process.exit(0);
}

const S_API = "https://slack.com/api";
const relayHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function log(o: Record<string, unknown>): void {
  console.log(JSON.stringify(o));
}

async function slackCall(method: string, body: Record<string, unknown>, token = cred!.bot): Promise<any> {
  const res = await fetch(`${S_API}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!(j as any).ok) log({ method, error: (j as any).error });
  return j;
}

// ── 기판 왕복 (discord 어댑터와 동형 — 어댑터는 자기 완결이 계약이라 공유하지 않는다) ──
const sessionQueues = new Map<string, Promise<void>>();
function enqueue(session: string, job: () => Promise<void>): void {
  const prev = sessionQueues.get(session) ?? Promise.resolve();
  sessionQueues.set(session, prev.then(job).catch((e) => log({ session, error: String(e) })));
}

async function relayChat(session: string, message: string, attachments?: string[]): Promise<{ reply: string; files: { path: string; name: string }[] }> {
  const open = await fetch(`${API}/pkg/${encodeURIComponent(NAME)}/turns`, {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify({ message, session, ...(attachments?.length ? { attachments } : {}) }),
  });
  const started = (await open.json()) as { turn?: string; error?: { code?: string; message?: string } };
  if (!open.ok || !started.turn) throw new Error(started.error?.message ?? `turn ${open.status}`);
  return observeTurn(started.turn);
}

/** 관찰 — data: 줄 하나가 봉투 이벤트 JSON 하나다(§5.2-18). 어휘는 하네스 봉투 protocol 3
 *  그대로(§6-35): 무대 산출물은 file, 종결은 reply/error. 스트림의 끝은 수명주기 settled 다
 *  — 종결 이벤트로 끊지 않고 settled 를 기다려야 뒤따르는 file 고지를 놓치지 않는다. */
async function observeTurn(turn: string): Promise<{ reply: string; files: { path: string; name: string }[] }> {
  const res = await fetch(`${API}/pkg/${encodeURIComponent(NAME)}/turns/${encodeURIComponent(turn)}/stream`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  let reply = "";
  let failure = "";
  const seen = new Set<string>();
  const files: { path: string; name: string }[] = [];
  const dec = new TextDecoder();
  let buf = "";
  let settled = false;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += dec.decode(chunk, { stream: true });
    let cut: number;
    // 프레임 경계는 빈 줄. 하트비트(:hb)처럼 data: 아닌 줄은 버린다
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev: Record<string, unknown>;
        try {
          ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        } catch {
          continue; // 부서진 줄 하나가 턴을 죽이지 않는다
        }
        if (ev.event === "file" && typeof ev.path === "string" && !seen.has(ev.path)) {
          seen.add(ev.path);
          files.push({ path: ev.path, name: ev.path.split("/").pop() ?? ev.path });
        } else if (ev.event === "reply") reply = String(ev.text ?? "");
        else if (ev.event === "error") failure = String(ev.message ?? "턴 실패");
        else if (ev.event === "turn" && ev.status === "settled") settled = true;
      }
    }
    if (settled) break;
  }
  if (failure) throw new Error(failure);
  // settled 없이 끊긴 스트림 = 종결이 아니라 절단이다(§5.2-20) — 빈 답으로 위장하지 않는다
  if (!settled) throw new Error("스트림이 종결 없이 끊겼습니다");
  return { reply, files };
}

async function stageUpload(name: string, bytes: ArrayBuffer): Promise<string | null> {
  const res = await fetch(`${API}/pkg/${encodeURIComponent(NAME)}/upload?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: Buffer.from(bytes),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { path?: string }).path ?? null;
}

// ── 발화 (마크다운 방언 번역은 최소 — 코드펜스·굵게 정도는 Slack 이 이해한다) ──────────
async function post(conversation: string, text: string, files?: string[]): Promise<void> {
  const [channelId, threadTs] = conversation.split(":");
  const base: Record<string, unknown> = { channel: channelId, ...(threadTs ? { thread_ts: threadTs } : {}) };
  for (let i = 0; i < text.length; i += 3800) {
    await slackCall("chat.postMessage", { ...base, text: text.slice(i, i + 3800) });
  }
  for (const p of files ?? []) {
    try {
      const r = await fetch(`${API}/pkg/${encodeURIComponent(NAME)}/file/${p.split("/").map(encodeURIComponent).join("/")}`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const fname = p.split("/").pop() ?? "file";
      // files.upload v2: 업로드 URL 발급 → 바이트 POST → complete 로 대화에 공유
      const up = await slackCall("files.getUploadURLExternal", { filename: fname, length: buf.byteLength });
      if (!up.ok) continue;
      await fetch(up.upload_url, { method: "POST", body: Buffer.from(buf) });
      await slackCall("files.completeUploadExternal", {
        files: [{ id: up.file_id, title: fname }],
        channel_id: channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (e) {
      log({ file: p, error: String(e) });
    }
  }
}

// ── 착신 ─────────────────────────────────────────────────────────────────
let selfId = "";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function onEvent(ev: any): Promise<void> {
  if (ev?.type !== "message" && ev?.type !== "app_mention") return;
  if (ev.subtype != null || ev.bot_id != null) return; // 편집·봇 발화 등은 착신하지 않는다
  const user = String(ev.user ?? "");
  if (!user || user === selfId) return;
  if (!ALLOW.has(user)) {
    log({ denied: user, channel: ev.channel });
    return;
  }
  const isDm = String(ev.channel_type ?? "") === "im";
  const mentioned = ev.type === "app_mention" || String(ev.text ?? "").includes(`<@${selfId}>`);
  if (!isDm && !mentioned) return;
  if (ev.type === "app_mention" && isDm) return; // message 이벤트와 이중 착신 방지

  const threadTs = ev.thread_ts && ev.thread_ts !== ev.ts ? String(ev.thread_ts) : "";
  const conversation = threadTs ? `${ev.channel}:${threadTs}` : String(ev.channel);
  const session = `${CHANNEL}-${ev.channel}${threadTs ? "-" + threadTs : ""}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  const text = String(ev.text ?? "").replace(new RegExp(`<@${selfId}>`, "g"), "").trim();

  const refs: string[] = [];
  for (const f of Array.isArray(ev.files) ? ev.files : []) {
    try {
      const r = await fetch(String(f.url_private_download ?? f.url_private), { headers: { authorization: `Bearer ${cred!.bot}` } });
      if (!r.ok) continue;
      const p = await stageUpload(String(f.name ?? "file"), await r.arrayBuffer());
      if (p) refs.push(p);
    } catch (e) {
      log({ attachment: String(f.name), error: String(e) });
    }
  }
  // user = 발화자 안정 식별자 — org 기판의 principal 결부 축(개인 기판은 게이트에만 쓴다)
  const envelope = `<channel source="${CHANNEL}" user="${escapeXml(user)}" nick="${escapeXml(user)}" conversation="${escapeXml(conversation)}" ts="${ev.ts}">${escapeXml(text)}</channel>`;

  enqueue(session, async () => {
    try {
      const r = await relayChat(session, envelope, refs);
      await post(conversation, r.reply, r.files.map((x) => x.path));
    } catch (e) {
      log({ session, error: String(e) });
      await post(conversation, "요청을 처리하지 못했습니다 — 잠시 후 다시 시도해 주세요.").catch(() => {});
    }
  });
}

// ── Socket Mode (재접속은 어댑터 소유) ────────────────────────────────────
let backoff = 1000;

async function connect(): Promise<void> {
  try {
    const open = await slackCall("apps.connections.open", {}, cred!.app);
    if (!open.ok) throw new Error(String(open.error));
    if (!selfId) {
      const auth = await slackCall("auth.test", {});
      selfId = String(auth.user_id ?? "");
      log({ ready: auth.user ?? "", allow: [...ALLOW] });
    }
    const ws = new WebSocket(String(open.url));
    ws.addEventListener("message", (msg) => {
      const p = JSON.parse(String(msg.data));
      if (p.type === "hello") {
        backoff = 1000;
        return;
      }
      if (p.envelope_id) ws.send(JSON.stringify({ envelope_id: p.envelope_id })); // 3초 내 ack — 응답은 비동기로
      if (p.type === "events_api") void onEvent(p.payload?.event);
      if (p.type === "disconnect") ws.close();
    });
    const reopen = () => {
      const wait = backoff;
      backoff = Math.min(backoff * 2, 60_000);
      setTimeout(() => void connect(), wait);
    };
    ws.addEventListener("close", reopen);
    ws.addEventListener("error", () => ws.close());
  } catch (e) {
    log({ connect: String(e) });
    const wait = backoff;
    backoff = Math.min(backoff * 2, 60_000);
    setTimeout(() => void connect(), wait);
  }
}
void connect();

// ── 발신 제어 채널 (stdin) ────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const cmd = JSON.parse(line);
    if (cmd?.type === "post" && cmd.conversation) {
      void post(String(cmd.conversation), String(cmd.text ?? ""), Array.isArray(cmd.files) ? cmd.files : undefined);
    }
  } catch (e) {
    log({ stdin: line.slice(0, 100), error: String(e) });
  }
});

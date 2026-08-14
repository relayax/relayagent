// Slack 채널 어댑터 — surfaces.channels 계약의 참조 구현 (Socket Mode, 의존성 0).
//
// 자격: relay connect <패키지> slack — Socket Mode 는 자격이 둘이다(앱 레벨 xapp- 토큰으로
//       소켓을 열고, 봇 xoxb- 토큰으로 발화한다). 한 줄에 공백 구분으로 붙여넣거나
//       JSON {"app":"xapp-...","bot":"xoxb-..."} 으로 붙여넣는다 → RELAY_CRED_SLACK.
// 게이트: 기본 닫힘 — RELAY_SLACK_ALLOW(쉼표 구분 사용자 id)의 발화자만 착신.
//        채널(그룹)에서는 앱 멘션이 있어야 응답 범위에 든다(DM 은 불요).
// slot:  slack-<채널id>[-<스레드ts>] — 스레드는 자기 slot 으로 이어진다.
// 발신:  stdin JSON {"type":"post","conversation":"<채널id>[:<스레드ts>]","text","files"?}.
// 검사:  RELAY_CONFORM=1 이면 외부 연결 없이 자기 서술 한 줄 + exit 0.
import readline from "node:readline";

const NAME = process.env.RELAY_NAME ?? "";
const CHANNEL = process.env.RELAY_CHANNEL ?? "slack";
const API = process.env.RELAY_API ?? "";
const TOKEN = process.env.RELAY_TOKEN ?? "";
const ALLOW = new Set((process.env.RELAY_SLACK_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean));

if (process.env.RELAY_CONFORM === "1") {
  console.log(JSON.stringify({ name: "slack", protocol: 1, capabilities: ["post", "files"] }));
  process.exit(0);
}

function parseCred(raw: string): { app: string; bot: string } | null {
  try {
    const j = JSON.parse(raw);
    if (j?.app && j?.bot) return { app: String(j.app), bot: String(j.bot) };
  } catch { /* JSON 아님 — 공백 구분 시도 */ }
  const parts = raw.split(/\s+/).filter(Boolean);
  const app = parts.find((p) => p.startsWith("xapp-"));
  const bot = parts.find((p) => p.startsWith("xoxb-"));
  return app && bot ? { app, bot } : null;
}
const cred = parseCred(process.env.RELAY_CRED_SLACK ?? "");
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
const slotQueues = new Map<string, Promise<void>>();
function enqueue(slot: string, job: () => Promise<void>): void {
  const prev = slotQueues.get(slot) ?? Promise.resolve();
  slotQueues.set(slot, prev.then(job).catch((e) => log({ slot, error: String(e) })));
}

async function relayChat(slot: string, message: string, attachments?: string[]): Promise<{ reply: string; files: { path: string; name: string }[] }> {
  const res = await fetch(`${API}/pkg/${encodeURIComponent(NAME)}/chat`, {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify({ message, slot, ...(attachments?.length ? { attachments } : {}) }),
  });
  const j = (await res.json()) as { reply?: string; files?: { path: string; name: string }[]; error?: string };
  if (!res.ok || j.error) throw new Error(j.error ?? `chat ${res.status}`);
  return { reply: j.reply ?? "", files: j.files ?? [] };
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
  const slot = `${CHANNEL}-${ev.channel}${threadTs ? "-" + threadTs : ""}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
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

  enqueue(slot, async () => {
    try {
      const r = await relayChat(slot, envelope, refs);
      await post(conversation, r.reply, r.files.map((x) => x.path));
    } catch (e) {
      log({ slot, error: String(e) });
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

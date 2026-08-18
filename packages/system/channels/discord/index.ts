// Discord 채널 어댑터 — surfaces.channels 계약(relay.manifest.yaml)의 참조 구현.
// 의존성 0: Node 22 네이티브 WebSocket(게이트웨이) + fetch(REST) 만 쓴다 — 어댑터는 글루다.
//
// 자격: relay connect <패키지> discord 로 봇 토큰을 vault 에 앉힌다 → RELAY_CRED_DISCORD.
// 게이트: 기본 닫힘 — RELAY_DISCORD_ALLOW(쉼표 구분 사용자 id)에 있는 발화자만 착신한다.
//        판정 대상은 방이 아니라 발화자다(그룹에서 방 게이트는 전원 통과가 된다).
//        그룹 채널에서는 멘션이 있을 때만 응답 범위를 좁힌다(DM 은 멘션 불요).
// session: discord-<채널id> — 같은 대화 = 같은 세션. 직렬화는 기판 소유(client-protocol
//        §5.1-12)이고, 어댑터 큐는 발신 순서를 지키기 위한 자기 몫이다.
// 발신:  stdin 줄 단위 JSON {"type":"post","conversation":"<채널id>","text","files"?} —
//        트리거 선톡(then.delivery)이 이 길로 온다.
// 검사:  RELAY_CONFORM=1 이면 외부 연결 없이 자기 서술 한 줄을 내고 0 으로 종료.
import readline from "node:readline";

const NAME = process.env.RELAY_NAME ?? "";
const CHANNEL = process.env.RELAY_CHANNEL ?? "discord";
const API = process.env.RELAY_API ?? "";
const TOKEN = process.env.RELAY_TOKEN ?? "";
const BOT = process.env.RELAY_CRED_DISCORD ?? "";
const ALLOW = new Set((process.env.RELAY_DISCORD_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean));

if (process.env.RELAY_CONFORM === "1") {
  console.log(JSON.stringify({ name: "discord", protocol: 1, capabilities: ["post", "files"] }));
  process.exit(0);
}
if (!BOT) {
  console.log(`discord: 자격 없음 — relay connect ${NAME} ${CHANNEL} 로 봇 토큰을 연결하세요 (대기하지 않고 종료)`);
  process.exit(0);
}

const D_API = "https://discord.com/api/v10";
const dHeaders = { authorization: `Bot ${BOT}`, "content-type": "application/json" };
const relayHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function log(o: Record<string, unknown>): void {
  console.log(JSON.stringify(o));
}

// ── 기판 왕복 ────────────────────────────────────────────────────────────
const sessionQueues = new Map<string, Promise<void>>();

/** 발신 순서 보존용 세션 큐 — 착신 직렬화 자체는 기판이 소유한다(§5.1-12). */
function enqueue(session: string, job: () => Promise<void>): void {
  const prev = sessionQueues.get(session) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => log({ session, error: String(e) }));
  sessionQueues.set(session, next);
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

// ── Discord REST ─────────────────────────────────────────────────────────
const MAX_MSG = 2000;

function chunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_MSG) out.push(text.slice(i, i + MAX_MSG));
  return out.length ? out : [""];
}

async function post(channelId: string, text: string, files?: string[]): Promise<void> {
  const parts = chunks(text);
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    if (last && files?.length) {
      // 마지막 조각에 stage 파일을 네이티브 첨부로 싣는다 (25MB 봇 상한 — 초과는 안내로 강등)
      const form = new FormData();
      const meta: { id: number; filename: string }[] = [];
      let fi = 0;
      for (const p of files) {
        const r = await fetch(`${API}/pkg/${encodeURIComponent(NAME)}/file/${p.split("/").map(encodeURIComponent).join("/")}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const fname = p.split("/").pop() ?? "file";
        if (buf.byteLength > 25 * 1024 * 1024) {
          await post(channelId, `(첨부 ${fname} 은 25MB 를 넘어 웹 채팅에서 받아야 합니다)`);
          continue;
        }
        form.append(`files[${fi}]`, new Blob([buf]), fname);
        meta.push({ id: fi, filename: fname });
        fi++;
      }
      form.append("payload_json", JSON.stringify({ content: parts[i], attachments: meta }));
      const res = await fetch(`${D_API}/channels/${channelId}/messages`, { method: "POST", headers: { authorization: `Bot ${BOT}` }, body: form });
      if (!res.ok) log({ post: channelId, status: res.status, body: (await res.text()).slice(0, 200) });
    } else {
      const res = await fetch(`${D_API}/channels/${channelId}/messages`, { method: "POST", headers: dHeaders, body: JSON.stringify({ content: parts[i] }) });
      if (!res.ok) log({ post: channelId, status: res.status, body: (await res.text()).slice(0, 200) });
    }
  }
}

/** 긴 턴의 생존 신호 — 타이핑 표시를 주기 갱신(Discord 는 ~10초 지속) */
function typingLoop(channelId: string): () => void {
  const tick = () => void fetch(`${D_API}/channels/${channelId}/typing`, { method: "POST", headers: dHeaders }).catch(() => {});
  tick();
  const t = setInterval(tick, 8000);
  return () => clearInterval(t);
}

// ── 착신 처리 ────────────────────────────────────────────────────────────
let selfId = "";

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function onMessage(msg: any): Promise<void> {
  const author = msg.author ?? {};
  if (author.bot || author.id === selfId) return;
  // 게이트: 발화자 기준 기본 닫힘. 그룹(guild)에서는 허용된 발화자라도 멘션이 있어야 응답한다
  if (!ALLOW.has(String(author.id))) {
    log({ denied: String(author.id), channel: msg.channel_id });
    return;
  }
  const isGuild = msg.guild_id != null;
  const mentioned = Array.isArray(msg.mentions) && msg.mentions.some((u: any) => u?.id === selfId);
  if (isGuild && !mentioned) return;

  const channelId = String(msg.channel_id);
  const session = `${CHANNEL}-${channelId}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  const nick = String(author.global_name ?? author.username ?? "unknown");
  const text = String(msg.content ?? "").replace(new RegExp(`<@!?${selfId}>`, "g"), "").trim();

  // 인바운드 첨부 → stage 에 앉혀 참조로 넘긴다
  const refs: string[] = [];
  for (const a of Array.isArray(msg.attachments) ? msg.attachments : []) {
    try {
      const r = await fetch(String(a.url));
      if (!r.ok) continue;
      const p = await stageUpload(String(a.filename ?? "file"), await r.arrayBuffer());
      if (p) refs.push(p);
    } catch (e) {
      log({ attachment: String(a.filename), error: String(e) });
    }
  }
  // user = 발화자 안정 식별자 — org 기판의 principal 결부 축(개인 기판은 게이트에만 쓴다)
  const envelope = `<channel source="${CHANNEL}" user="${escapeXml(String(author.id))}" nick="${escapeXml(nick)}" conversation="${channelId}" ts="${msg.timestamp ?? ""}">${escapeXml(text)}</channel>`;

  enqueue(session, async () => {
    const stopTyping = typingLoop(channelId);
    try {
      const r = await relayChat(session, envelope, refs);
      await post(channelId, r.reply, r.files.map((f) => f.path));
    } catch (e) {
      log({ session, error: String(e) });
      await post(channelId, "요청을 처리하지 못했습니다 — 잠시 후 다시 시도해 주세요.").catch(() => {});
    } finally {
      stopTyping();
    }
  });
}

// ── 게이트웨이 (재접속은 어댑터 소유 — 크래시로 답하지 않는다) ─────────────
const INTENTS = 512 + 4096 + 32768; // GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT
let seq: number | null = null;
let sessionId = "";
let resumeUrl = "";
let backoff = 1000;

function connect(url: string, resume: boolean): void {
  const ws = new WebSocket(url + "/?v=10&encoding=json");
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  ws.addEventListener("message", (ev) => {
    const p = JSON.parse(String(ev.data));
    if (p.s != null) seq = p.s;
    switch (p.op) {
      case 10: // hello
        heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), p.d.heartbeat_interval);
        ws.send(
          resume && sessionId
            ? JSON.stringify({ op: 6, d: { token: BOT, session_id: sessionId, seq } })
            : JSON.stringify({ op: 2, d: { token: BOT, intents: INTENTS, properties: { os: "linux", browser: "relay", device: "relay" } } }),
        );
        break;
      case 1:
        ws.send(JSON.stringify({ op: 1, d: seq }));
        break;
      case 7: // reconnect 요청
        ws.close(4000);
        break;
      case 9: // invalid session — resume 불가면 재식별
        sessionId = "";
        ws.close(4000);
        break;
      case 0:
        backoff = 1000;
        if (p.t === "READY") {
          selfId = String(p.d.user?.id ?? "");
          sessionId = String(p.d.session_id ?? "");
          resumeUrl = String(p.d.resume_gateway_url ?? "");
          log({ ready: p.d.user?.username, allow: [...ALLOW] });
        } else if (p.t === "MESSAGE_CREATE") {
          void onMessage(p.d);
        }
        break;
    }
  });
  const reopen = () => {
    if (heartbeat) clearInterval(heartbeat);
    const wait = backoff;
    backoff = Math.min(backoff * 2, 60_000);
    setTimeout(() => connect(sessionId && resumeUrl ? resumeUrl : "wss://gateway.discord.gg", !!sessionId), wait);
  };
  ws.addEventListener("close", reopen);
  ws.addEventListener("error", () => ws.close());
}

connect("wss://gateway.discord.gg", false);

// ── 발신 제어 채널 (stdin) — 트리거 선톡이 이 길로 온다 ────────────────────
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

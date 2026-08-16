// slack 채널 어댑터 — 참조 구현. 계약 전문은 relay.manifest.yaml surfaces.channels,
// 저작 지침은 ../SKILL.md. 소켓모드(공개 URL 불요)로 붙고 의존성이 없다:
// Node 22+ 전역 fetch/WebSocket 만 쓰며, import 가 없어 CJS/ESM 판별과 무관하게
// --experimental-strip-types 로 그대로 돈다.
//
// Slack 앱 요건: socket_mode_enabled, 이벤트 message.im + app_mention,
// 봇 스코프 chat:write · im:history · users:read · app_mentions:read · files:read · files:write
//
// 자격(RELAY_CRED_<채널이름>): JSON 한 줄 —
//   {"app_token":"xapp-…","bot_token":"xoxb-…","allow":["U…"]}
//   app_token  소켓모드 연결(connections:write) · bot_token  회신·조회 · allow  착신 허용 사용자 ID

// ── 검사 문 — 자격·네트워크보다 먼저. 설치의 conform 게이트가 이 문으로 계약을 판정한다 ──
if (process.env.RELAY_CONFORM === "1") {
  console.log(JSON.stringify({ name: "slack", protocol: 1 }));
  process.exit(0);
}

const NAME = process.env.RELAY_NAME ?? "";
const API = process.env.RELAY_API ?? "";
const TOKEN = process.env.RELAY_TOKEN ?? "";
const CHANNEL = process.env.RELAY_CHANNEL ?? "slack";

interface Cred { app_token: string; bot_token: string; allow?: string[] }

function loadCred(): Cred {
  const raw = process.env["RELAY_CRED_" + CHANNEL.toUpperCase().replace(/-/g, "_")];
  if (!raw) throw new Error('자격 없음 — relay connect <패키지> ' + CHANNEL + ' 으로 {"app_token":"xapp-…","bot_token":"xoxb-…","allow":["U…"]} JSON 을 넣으세요');
  const c = JSON.parse(raw) as Cred;
  if (!c.app_token || !c.bot_token) throw new Error("자격 불완전: app_token(xapp-)과 bot_token(xoxb-)이 모두 필요합니다");
  return c;
}

async function slack(method: string, token: string, body?: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body ?? {}),
  });
  const data = (await res.json()) as Record<string, any>;
  if (!data.ok) throw new Error(`${method}: ${data.error}`);
  return data;
}

// ── 검증 문 — 자격이 실제로 먹히는지만 본다("저장됨 ≠ 유효"). 소켓·상주 없이 auth.test
// 한 번만 돌려 판정 JSON 한 줄을 내고 종료한다. 상주 프로세스는 건드리지 않는다 ──
if (process.env.RELAY_VERIFY === "1") {
  (async () => {
    try {
      const cred = loadCred();
      const a = await slack("auth.test", cred.bot_token);
      console.log(JSON.stringify({ ok: true, note: `${a.user} @ ${a.team}` }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, note: String((e as Error)?.message ?? e).slice(0, 200) }));
    }
    process.exit(0);
  })();
}

// ── 기판 문 — 착신·라벨·파일. 모든 대화가 이 문을 통과한다 ─────────────────────
const relayHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const pkgUrl = (p: string) => `${API}/pkg/${encodeURIComponent(NAME)}/${p}`;

async function relayChat(message: string, slot: string, attachments?: string[]): Promise<{ reply?: string; files?: { path: string; name?: string }[] }> {
  const res = await fetch(pkgUrl("chat"), {
    method: "POST",
    headers: relayHeaders,
    body: JSON.stringify({ message, slot, ...(attachments?.length ? { attachments } : {}) }),
  });
  if (!res.ok) throw new Error(`chat ${res.status}: ${await res.text()}`);
  return (await res.json()) as { reply?: string; files?: { path: string; name?: string }[] };
}

/** 인바운드 첨부 → stage. 반환된 상대경로가 chat body 의 attachments 참조가 된다 */
async function uploadToStage(name: string, bytes: ArrayBuffer): Promise<string | null> {
  const res = await fetch(pkgUrl(`upload?name=${encodeURIComponent(name)}`), {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: bytes,
  });
  if (!res.ok) return null;
  return ((await res.json()) as { path?: string }).path ?? null;
}

const labeled = new Set<string>();
async function labelOnce(slot: string, label: string): Promise<void> {
  if (labeled.has(slot)) return;
  labeled.add(slot);
  try {
    await fetch(pkgUrl(`session/${encodeURIComponent(slot)}/label`), { method: "POST", headers: relayHeaders, body: JSON.stringify({ label }) });
  } catch { /* 라벨은 편의다 — 실패해도 대화는 계속된다 */ }
}

// ── 직렬화 — 한 slot 에 동시 착신 금지. slot 별 프라미스 사슬이 순서를 보존한다 ──
const queues = new Map<string, Promise<void>>();
function enqueue(slot: string, job: () => Promise<void>): void {
  const prev = queues.get(slot) ?? Promise.resolve();
  const next = prev.then(job).catch((e) => console.error(`[${slot}] 턴 실패: ${e}`));
  queues.set(slot, next);
}

// ── dedup — 소켓모드는 at-least-once 다. ack 는 즉시 하고 여기서 중복을 버린다 ──
const seen: string[] = [];
const seenSet = new Set<string>();
function isDup(id: string): boolean {
  if (seenSet.has(id)) return true;
  seenSet.add(id);
  seen.push(id);
  if (seen.length > 2000) seenSet.delete(seen.shift()!);
  return false;
}

const names = new Map<string, string>();
async function nickname(cred: Cred, user: string): Promise<string> {
  const hit = names.get(user);
  if (hit) return hit;
  try {
    const r = await slack("users.info", cred.bot_token, { user });
    const n = String(r.user?.profile?.display_name || r.user?.real_name || user);
    names.set(user, n);
    return n;
  } catch {
    return user; // 이름 조회 실패는 착신을 막을 사유가 아니다
  }
}

/** 회신 텍스트 — Slack 메시지 상한(~4000자) 아래로 줄 경계 우선 분할 */
async function postText(cred: Cred, channel: string, text: string): Promise<void> {
  for (let rest = text; rest.length > 0; ) {
    let cut = rest.length <= 3800 ? rest.length : rest.lastIndexOf("\n", 3800);
    if (cut <= 0) cut = 3800;
    await slack("chat.postMessage", cred.bot_token, { channel, text: rest.slice(0, cut) });
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
}

/** 회신 파일 — stage 에서 받아(GET …/file/<경로>) Slack 외부 업로드 3단으로 내보낸다 */
async function postFile(cred: Cred, channel: string, stagePath: string, name?: string): Promise<void> {
  const got = await fetch(pkgUrl(`file/${stagePath}`), { headers: { authorization: `Bearer ${TOKEN}` } });
  if (!got.ok) throw new Error(`stage 파일 없음: ${stagePath}`);
  const bytes = await got.arrayBuffer();
  const filename = name ?? stagePath.split("/").pop() ?? "file";
  // files.getUploadURLExternal 은 form 인코딩만 받는다 (JSON 미지원 — Slack API 의 예외)
  const ticket = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: { authorization: `Bearer ${cred.bot_token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ filename, length: String(bytes.byteLength) }),
  }).then((r) => r.json()) as Record<string, any>;
  if (!ticket.ok) throw new Error(`files.getUploadURLExternal: ${ticket.error}`);
  const put = await fetch(String(ticket.upload_url), { method: "POST", body: bytes });
  if (!put.ok) throw new Error(`업로드 실패: ${put.status}`);
  await slack("files.completeUploadExternal", cred.bot_token, { files: [{ id: ticket.file_id, title: filename }], channel_id: channel });
}

async function deliver(cred: Cred, channel: string, text?: string, files?: { path: string; name?: string }[]): Promise<void> {
  if (text) await postText(cred, channel, text);
  for (const f of files ?? []) {
    try {
      await postFile(cred, channel, f.path, f.name);
    } catch (e) {
      console.error(`파일 발신 실패(${f.path}): ${e}`);
      await postText(cred, channel, `(첨부 전달 실패: ${f.name ?? f.path.split("/").pop()})`); // 내부 사정 없이 사실만
    }
  }
}

function handleEvent(cred: Cred, ev: Record<string, any>): void {
  const isDM = ev.type === "message" && ev.channel_type === "im";
  const isMention = ev.type === "app_mention";
  if (!isDM && !isMention) return;
  if (ev.bot_id || ev.subtype) return; // 봇 발화·수정/시스템 메시지는 착신이 아니다
  const user = String(ev.user ?? "");
  // 게이트: 기본 닫힘, 발화자 단위 — 착신은 기판 주인의 권한으로 돈다
  if (!(cred.allow ?? []).includes(user)) {
    console.error(`게이트 차단: ${user || "(무명)"} — allow 목록 밖`);
    return;
  }
  let text = String(ev.text ?? "");
  if (isMention) text = text.replace(/<@[^>]+>\s*/g, "").trim();
  if (!text && !(ev.files?.length)) return;
  const slot = `${CHANNEL}-${String(ev.channel)}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64);
  enqueue(slot, async () => {
    // 인바운드 첨부 → stage. url_private 는 봇 토큰 인증이 필요하다 (files:read)
    const attachments: string[] = [];
    for (const f of ev.files ?? []) {
      try {
        const got = await fetch(String(f.url_private), { headers: { authorization: `Bearer ${cred.bot_token}` } });
        if (!got.ok) continue;
        const p = await uploadToStage(String(f.name ?? "file"), await got.arrayBuffer());
        if (p) attachments.push(p);
      } catch (e) {
        console.error(`첨부 수신 실패(${f.name}): ${e}`);
      }
    }
    const nick = await nickname(cred, user);
    // user = 플랫폼 안정 식별자(필수), 닉네임은 매 착신마다 — 그룹은 한 slot 에 발화자가 여럿이다
    const message = `<channel source="${CHANNEL}" user="${user}" nickname="${nick}" ts="${String(ev.ts)}">${text}</channel>`;
    try {
      const r = await relayChat(message, slot, attachments);
      await labelOnce(slot, isDM ? `Slack DM — ${nick}` : `Slack — ${nick}`);
      await deliver(cred, String(ev.channel), r.reply, r.files);
    } catch (e) {
      console.error(`착신 실패[${slot}]: ${e}`); // 상세는 기판 로그로
      await postText(cred, String(ev.channel), "⚠️ 메시지를 처리하지 못했습니다. 잠시 후 다시 시도해주세요.").catch(() => { /* 이중 실패는 로그만 */ });
    }
  });
}

// ── 발신 — stdin 은 기판의 발신 제어 채널이다. 트리거 선톡(then.delivery)이 이 길로 온다 ──
function listenStdin(cred: Cred): void {
  let buf = "";
  process.stdin.on("data", (d) => {
    buf += String(d);
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as { type?: string; conversation?: string; text?: string; files?: string[] };
        if (msg.type !== "post" || !msg.conversation) continue; // 미지 형은 조용히 무시 — 전방 호환
        void deliver(cred, msg.conversation, msg.text, msg.files?.map((p) => ({ path: p })))
          .catch((e) => console.error(`발신 실패(${msg.conversation}): ${e}`));
      } catch {
        console.error(`발신 파싱 실패: ${line.slice(0, 120)}`);
      }
    }
  });
}

function runSocket(cred: Cred, url: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const ws = new WebSocket(url);
    ws.addEventListener("open", () => console.log("socket 연결"));
    ws.addEventListener("close", (e) => { console.log(`socket 종료 (${e.code})`); resolve(); });
    ws.addEventListener("error", () => { /* close 가 뒤따른다 */ });
    ws.addEventListener("message", (e) => {
      let msg: Record<string, any>;
      try { msg = JSON.parse(String(e.data)); } catch { return; }
      // ack 는 즉시 — 처리를 기다리면 Slack 이 재전송해 중복이 쌓인다
      if (msg.envelope_id) ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      if (msg.type === "disconnect") { ws.close(); return; } // Slack 의 재접속 지시
      if (msg.type !== "events_api") return;
      const id = String(msg.payload?.event_id ?? msg.envelope_id ?? "");
      if (!id || isDup(id)) return;
      const ev = msg.payload?.event;
      if (ev) handleEvent(cred, ev);
    });
  });
}

async function main(): Promise<void> {
  if (!NAME || !API || !TOKEN) throw new Error("RELAY_NAME/RELAY_API/RELAY_TOKEN 미주입 — 기판이 스폰해야 한다");
  const cred = loadCred();
  const auth = await slack("auth.test", cred.bot_token); // fail-loud: 토큰 검증 겸 봇 정체 확인
  console.log(`slack 어댑터 기동: ${auth.user} @ ${auth.team} (allow ${cred.allow?.length ?? 0}명)`);
  listenStdin(cred);
  // 연결 유지·재접속은 어댑터 소유 — 네트워크 단절에 크래시로 답하지 않는다.
  // 진행 표시(타이핑 류)는 선택 축이라 이 참조 구현은 생략했다 — …/session/<slot>/events 폴링으로 얹는다
  let backoff = 1000;
  for (;;) {
    try {
      const open = await slack("apps.connections.open", cred.app_token);
      await runSocket(cred, String(open.url));
      backoff = 1000; // 정상 왕복 뒤의 끊김은 즉시 재접속 축
    } catch (e) {
      console.error(`연결 실패: ${e}`);
      backoff = Math.min(backoff * 2, 30_000);
    }
    await new Promise((r) => setTimeout(r, backoff));
  }
}

// 검증 문(RELAY_VERIFY)은 위에서 async 로 갈라져 스스로 종료한다 — 상주로 흐르지 않게 가드
if (process.env.RELAY_VERIFY !== "1") {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1); // 프로세스 종료 = 실패 — 기판 로그에 남는 것이 계약이다
  });
}

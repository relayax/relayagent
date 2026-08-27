// observe.test.mjs — 관찰 커넥션 예산(client-protocol §5.2)의 두 길.
//
// 이 파일이 생긴 이유(2026-08-27 실사고): 다중 세션 작업 중 메인 대화가 "응답이 끊겼어요 —
// 관찰을 클라이언트가 닫음" 으로 잘렸다. transport 가 관찰 슬롯을 인스턴스당 **하나**로 접어,
// 위임 탭의 attach 가 메인의 stream 을 닫고 메인의 재접속이 위임 탭을 닫는 핑퐁이 REATTACH_MAX
// 를 소진했다(탭 셸은 pane 을 전부 살려 두고 세션마다 관찰을 연다). 못박는 것:
//
//  직접 관찰(observe 미선언 기판 — 구 기판·relayos):
//   1. 다른 세션의 관찰은 서로를 닫지 않는다.
//   2. 같은 세션의 새 관찰은 이전 관찰을 대체한다(§5.2 ③·④).
//   3. 상한(OBSERVE_MAX)에 닿으면 attach 는 대기하고 stream 은 가장 오래된 관찰을 양보시킨다 —
//      양보된 쪽의 재접속(attach)은 대기열에 서므로 순환하지 않는다.
//  다중화(capability observe — §5.2-20-a):
//   4. 세션 몇 개를 보든 커넥션은 한 줄기고, 이벤트는 자기 세션·턴의 핸들로만 간다.
//   5. 늦게 붙은 관찰은 줄기가 받아 둔 장부를 먼저 받는다 — 서버 재생을 다시 청하지 않는다.
//   6. 창 밖의 턴(이미 종결)은 직접 stream 으로 장부를 재생한다(§5.1-13).
//   7. 줄기가 끊기면 모든 관찰이 절단(§5.2-20)이고, 다음 관찰이 새 줄기를 연다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const { createTransport, OBSERVE_MAX } = await loadModule("transport.ts");

/** 가짜 기판. observe=true 면 줄기(/observe)와 구독 편집(POST)을 흉내 낸다. 직접 관찰은 URL 마다
 *  SSE 손잡이를 내주고, signal 중단은 실제 fetch 처럼 본문 오류로 돌려준다. */
function fakeServer({ observe = false } = {}) {
  const enc = new TextEncoder();
  const streams = []; // 열린 SSE 전부(직접 관찰 + 줄기)
  const posts = []; // 구독 편집 요청
  const sessions = new Map(); // session → { turns: [{ id, ledger }] } — 관찰 창
  let muxStream = null;
  const openSse = (url, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
      let controller;
      const body = new ReadableStream({ start(c) { controller = c; } });
      const s = {
        url,
        closed: false,
        send(ev) { if (!s.closed) controller.enqueue(enc.encode("data: " + JSON.stringify(ev) + "\n\n")); },
        end() { if (!s.closed) { s.closed = true; controller.close(); } },
      };
      signal?.addEventListener("abort", () => {
        if (!s.closed) { s.closed = true; controller.error(new DOMException("aborted", "AbortError")); }
      });
      streams.push(s);
      resolve(new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }));
    });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetch = async (url, init) => {
    const u = new URL(url);
    if (u.pathname.endsWith("/capabilities")) return json(200, { protocol: 1, capabilities: observe ? ["observe"] : [] });
    if (observe && u.pathname.endsWith("/observe")) {
      const r = await openSse(url, init?.signal);
      muxStream = streams[streams.length - 1];
      muxStream.id = u.searchParams.get("id");
      muxStream.subs = new Set();
      muxStream.send({ event: "observe", status: "ready", id: muxStream.id });
      return r;
    }
    const m = observe ? u.pathname.match(/\/observe\/([^/]+)\/sessions$/) : null;
    if (m) {
      const body = JSON.parse(init.body);
      posts.push({ id: m[1], ...body });
      if (!muxStream || muxStream.id !== m[1] || muxStream.closed) return json(404, { error: { code: "E_NO_OBSERVER", message: "" } });
      for (const s of body.remove ?? []) muxStream.subs.delete(s);
      for (const s of body.add ?? []) {
        muxStream.subs.add(s);
        const turns = sessions.get(s)?.turns ?? [];
        muxStream.send({ event: "observe", status: "session", session: s, turns: turns.map((t) => t.id) });
        for (const t of turns) for (const ev of t.ledger) muxStream.send({ turn: t.id, session: s, ...ev });
      }
      return json(200, { ok: true });
    }
    return openSse(url, init?.signal); // 직접 관찰 — /turns/<id>/stream · /turns/attach
  };
  /** 서버 쪽 턴 개설 — 관찰 창에 서고, 구독 중이면 줄기에 알린다 */
  const openTurn = (session, id) => {
    const rec = sessions.get(session) ?? { turns: [] };
    rec.turns.push({ id, ledger: [] });
    sessions.set(session, rec);
    if (muxStream && !muxStream.closed && muxStream.subs.has(session)) muxStream.send({ event: "observe", status: "turn", session, turn: id });
  };
  /** 서버 쪽 이벤트 — 장부에 적고 구독 줄기에 흘린다. settled 면 창에서 내린다 */
  const emit = (session, id, ev) => {
    const rec = sessions.get(session);
    const t = rec?.turns.find((x) => x.id === id);
    if (!t) throw new Error("no turn " + id);
    t.ledger.push(ev);
    if (muxStream && !muxStream.closed && muxStream.subs.has(session)) muxStream.send({ turn: id, session, ...ev });
    if (ev.event === "turn" && ev.status === "settled") rec.turns = rec.turns.filter((x) => x !== t);
  };
  return { fetch, streams, posts, openTurn, emit, mux: () => muxStream };
}
const settle = () => new Promise((r) => setTimeout(r, 15));
const settledEv = (turn) => ({ event: "turn", status: "settled", turn, ok: true });
const transportOn = (srv) => createTransport({ base: "http://x/b", root: "http://x", fetch: srv.fetch });

// ── 직접 관찰 ────────────────────────────────────────────────────────────────

test("직접: 다른 세션의 관찰은 서로를 닫지 않는다 — 메인 stream 과 위임 탭 attach 가 나란히 흐른다", async () => {
  const srv = fakeServer();
  const t = transportOn(srv);
  const a = [], b = [];
  const ha = t.turn.stream("t1", "s-main", (e) => a.push(e));
  const hb = t.turn.attach("s-delegate", (e) => b.push(e));
  await settle();
  assert.equal(srv.streams.length, 2);
  srv.streams[0].send({ event: "delta", text: "A" });
  srv.streams[1].send({ event: "delta", text: "B" });
  await settle();
  assert.deepEqual(a.map((e) => e.text), ["A"]);
  assert.deepEqual(b.map((e) => e.text), ["B"]);
  srv.streams[0].send(settledEv("t1")); srv.streams[0].end();
  srv.streams[1].send(settledEv("t2")); srv.streams[1].end();
  assert.deepEqual(await ha.settled, { turn: "t1", ok: true });
  assert.deepEqual(await hb.settled, { turn: "t2", ok: true });
});

test("직접: 같은 세션의 새 관찰은 이전 관찰을 대체한다(§5.2 ③) — 커넥션이 늘지 않는다", async () => {
  const srv = fakeServer();
  const t = transportOn(srv);
  const h1 = t.turn.stream("t1", "s1", () => {});
  await settle();
  const h2 = t.turn.attach("s1", () => {});
  const r1 = await h1.settled;
  assert.equal(r1.error?.code, "E_DISCONNECTED");
  await settle();
  assert.equal(srv.streams.length, 2);
  assert.ok(srv.streams[0].closed, "이전 관찰의 fetch 는 끊긴다");
  assert.ok(!srv.streams[1].closed, "새 관찰은 산다");
  h2.close();
  assert.equal((await h2.settled).error?.code, "E_DISCONNECTED");
});

test("직접: 상한에서 attach 는 대기하고 stream 은 가장 오래된 관찰을 양보시킨다 — 양보가 양보를 부르지 않는다", async () => {
  const srv = fakeServer();
  const t = transportOn(srv);
  const live = [];
  for (let i = 0; i < OBSERVE_MAX; i++) live.push(t.turn.stream("t" + i, "s" + i, () => {}));
  await settle();
  assert.equal(srv.streams.length, OBSERVE_MAX);

  const hw = t.turn.attach("s-wait", () => {});
  await settle();
  assert.equal(srv.streams.length, OBSERVE_MAX, "대기 중인 attach 는 커넥션을 쓰지 않는다");

  const hn = t.turn.stream("t-new", "s-new", () => {});
  const r0 = await live[0].settled;
  assert.equal(r0.error?.code, "E_DISCONNECTED");
  await settle();
  assert.equal(srv.streams.length, OBSERVE_MAX + 1);
  assert.match(srv.streams[OBSERVE_MAX].url, /\/turns\/t-new\/stream$/);

  const h0 = t.turn.attach("s0", () => {});
  await settle();
  assert.equal(srv.streams.length, OBSERVE_MAX + 1, "재접속은 순환을 만들지 않는다");

  srv.streams[1].send(settledEv("t1")); srv.streams[1].end();
  await live[1].settled; await settle();
  assert.equal(srv.streams.length, OBSERVE_MAX + 2);
  assert.match(srv.streams[OBSERVE_MAX + 1].url, /attach\?session=s-wait$/);
  srv.streams[2].send(settledEv("t2")); srv.streams[2].end();
  await live[2].settled; await settle();
  assert.equal(srv.streams.length, OBSERVE_MAX + 3);
  assert.match(srv.streams[OBSERVE_MAX + 2].url, /attach\?session=s0$/);

  const hq = t.turn.attach("s-q", () => {});
  hq.close();
  assert.equal((await hq.settled).error?.code, "E_DISCONNECTED");
  await settle();
  assert.equal(srv.streams.length, OBSERVE_MAX + 3, "열리기 전에 닫힌 대기 관찰은 커넥션 없이 정리된다");

  for (const h of [hw, hn, h0]) h.close();
});

// ── 다중화 ───────────────────────────────────────────────────────────────────

test("다중화: 세션 몇 개를 보든 커넥션은 한 줄기 — 이벤트는 자기 세션·턴의 핸들로만 간다", async () => {
  const srv = fakeServer({ observe: true });
  const t = transportOn(srv);
  srv.openTurn("s-main", "t1");
  srv.openTurn("s-delegate", "t2");
  const a = [], b = [];
  const ha = t.turn.stream("t1", "s-main", (e) => a.push(e));
  const hb = t.turn.attach("s-delegate", (e) => b.push(e));
  await settle();
  assert.equal(srv.streams.length, 1, "줄기 하나");
  assert.deepEqual(srv.posts.map((p) => p.add?.[0]), ["s-main", "s-delegate"]);
  srv.emit("s-main", "t1", { event: "delta", text: "A" });
  srv.emit("s-delegate", "t2", { event: "delta", text: "B" });
  await settle();
  assert.deepEqual(a.map((e) => e.text), ["A"]);
  assert.deepEqual(b.map((e) => e.text), ["B"]);
  srv.emit("s-main", "t1", settledEv("t1"));
  assert.deepEqual(await ha.settled, { turn: "t1", ok: true });
  await settle();
  assert.ok(!srv.mux().closed, "다른 세션이 남아 있으면 줄기는 산다");
  assert.ok(srv.posts.some((p) => p.remove?.[0] === "s-main"), "핸들이 없어진 세션은 구독을 걷는다");
  srv.emit("s-delegate", "t2", settledEv("t2"));
  assert.deepEqual(await hb.settled, { turn: "t2", ok: true });
  await settle();
  assert.ok(srv.mux().closed, "볼 것이 없으면 줄기를 닫는다");
  assert.equal(srv.streams.length, 1, "직접 커넥션은 하나도 열리지 않았다");
});

test("다중화: 늦게 붙은 관찰은 줄기가 받아 둔 장부를 먼저 받는다 — 서버 재생을 다시 청하지 않는다", async () => {
  const srv = fakeServer({ observe: true });
  const t = transportOn(srv);
  srv.openTurn("s1", "t1");
  srv.emit("s1", "t1", { event: "turn", status: "started", turn: "t1", session: "s1" });
  srv.emit("s1", "t1", { event: "delta", text: "앞" });
  const first = [];
  const h1 = t.turn.attach("s1", (e) => first.push(e));
  await settle();
  assert.equal(first.length, 2, "구독 시 서버가 장부를 재생한다");
  const posts = srv.posts.length;
  const second = [];
  const h2 = t.turn.stream("t1", "s1", (e) => second.push(e)); // 같은 세션 — 이전 관찰 대체
  assert.equal((await h1.settled).error?.code, "E_DISCONNECTED");
  await settle();
  assert.equal(srv.posts.length, posts, "구독 편집 없음");
  assert.deepEqual(second.map((e) => e.event), ["turn", "delta"]);
  srv.emit("s1", "t1", { event: "delta", text: "뒤" });
  await settle();
  assert.equal(second.length, 3);
  h2.close();
});

test("다중화: 창 밖의 턴(이미 종결)은 직접 stream 으로 장부를 재생한다(§5.1-13)", async () => {
  const srv = fakeServer({ observe: true });
  const t = transportOn(srv);
  const got = [];
  const h = t.turn.stream("t-old", "s1", (e) => got.push(e));
  await settle();
  const direct = srv.streams.find((s) => /\/turns\/t-old\/stream$/.test(s.url));
  assert.ok(direct, "직접 재생 커넥션이 열린다");
  direct.send({ event: "turn", status: "started", turn: "t-old", session: "s1" });
  direct.send(settledEv("t-old")); direct.end();
  assert.deepEqual(await h.settled, { turn: "t-old", ok: true });
  assert.equal(got.length, 2);
});

test("다중화: 줄기가 끊기면 모든 관찰이 절단이고, 다음 관찰이 새 줄기를 연다", async () => {
  const srv = fakeServer({ observe: true });
  const t = transportOn(srv);
  srv.openTurn("s1", "t1"); srv.openTurn("s2", "t2");
  const h1 = t.turn.attach("s1", () => {});
  const h2 = t.turn.attach("s2", () => {});
  await settle();
  const m1 = srv.mux();
  m1.end(); // 서버가 settled 없이 줄기를 닫음
  assert.equal((await h1.settled).error?.code, "E_DISCONNECTED");
  assert.equal((await h2.settled).error?.code, "E_DISCONNECTED");
  const h3 = t.turn.attach("s1", () => {});
  await settle();
  assert.notEqual(srv.mux(), m1);
  assert.notEqual(srv.mux().id, m1.id);
  h3.close();
});

// steer.test.mjs — 얹기 파트(client-protocol §5.1-16-a)가 화면 모델에 서는가.
//
// 못박는 것 셋:
//  1. 얹힌 말은 **그 자리**에 선다 — 앞뒤 텍스트 사이, 정산보다 앞. 순서가 곧 뜻이라
//     (이 말이 들어간 지점이 이후 도구 호출들이 갈린 이유) 뒤로 밀리면 화면이 거짓말을 한다.
//  2. 라이브와 재생이 **같은 파트**를 만든다 — 리듀서가 하나라는 판정의 실제 근거.
//     id 를 봉투가 주지 않고 장부 순서에서 세므로, 이 등가가 깨지면 재생이 파트를 잃는다.
//  3. 얹기는 **정산이 아니다** — 얹은 뒤에도 턴은 미종결이고 replyText 를 납치하지 않는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const { EnvelopeReducer, reduceEnvelope, STEER_TOOL } = await loadModule("envelope-reducer.ts");

/** 도구 하나를 돌던 중에 사용자가 말을 얹고, 그 뒤 방향이 바뀐 한 턴 */
const STREAM = [
  { event: "turn", status: "started", turn: "t1", session: "s1", t: 1000 },
  { event: "delta", text: "하나부터 해볼게요." },
  { event: "tool", status: "start", id: "c1", name: "Bash", args: '{"command":"sleep 8"}' },
  { event: "tool", status: "end", id: "c1", name: "Bash", ok: true, result: "ONE" },
  { event: "steer", text: "그만하고 요약만 주세요" },
  { event: "delta", text: "알겠습니다 — 요약입니다." },
  { event: "reply", text: "알겠습니다 — 요약입니다.", model: "m", t: 4000 },
  { event: "turn", status: "settled", turn: "t1", ok: true, t: 4000 },
];

test("얹힌 말은 파트 열의 제 자리에 선다 — 도구 뒤, 방향이 바뀐 텍스트 앞", () => {
  const { parts, meta } = reduceEnvelope(STREAM);
  const kinds = parts.map((p) => (p.type === "tool-call" ? p.toolName : p.type));
  assert.deepEqual(kinds, ["text", "Bash", STEER_TOOL, "text"]);
  const steer = parts[2];
  assert.equal(steer.args.text, "그만하고 요약만 주세요");
  // 카드 본문은 args 와 argsText 둘 다에 선다 — 렌더가 어느 쪽을 읽어도 같은 말이다
  assert.equal(steer.argsText, "그만하고 요약만 주세요");
  assert.equal(meta.ended, "ok");
});

test("라이브와 재생이 같은 파트를 만든다 — id 를 장부 순서에서 세는 근거", () => {
  const live = new EnvelopeReducer();
  for (const ev of STREAM) live.push(ev);
  assert.deepEqual(live.snapshot(), reduceEnvelope(STREAM).parts);
});

test("여러 번 얹어도 각각 자기 카드다 — 순번이 겹치면 뒤엣것이 앞엣것을 덮는다", () => {
  const { parts } = reduceEnvelope([
    { event: "turn", status: "started", turn: "t2", session: "s1", t: 0 },
    { event: "steer", text: "먼저" },
    { event: "steer", text: "그리고" },
    { event: "reply", text: "네", t: 10 },
  ]);
  const steers = parts.filter((p) => p.type === "tool-call" && p.toolName === STEER_TOOL);
  assert.equal(steers.length, 2);
  assert.deepEqual(steers.map((p) => p.args.text), ["먼저", "그리고"]);
  assert.notEqual(steers[0].toolCallId, steers[1].toolCallId);
});

test("얹기는 정산이 아니다 — 얹은 뒤에도 턴은 미종결이고 종결 본문을 납치하지 않는다", () => {
  const r = new EnvelopeReducer();
  r.push({ event: "turn", status: "started", turn: "t3", session: "s1", t: 0 });
  r.push({ event: "delta", text: "진행 중" });
  r.push({ event: "steer", text: "얹은 말" });
  assert.equal(r.settled, false);
  assert.equal(r.meta.ended, undefined);
  // 얹은 말은 사용자 발화지 어시스턴트의 답이 아니다 — 이력에 앉을 본문에 섞이면 안 된다
  assert.equal(r.replyText, "진행 중");
});

test("본문 없는 steer 는 카드를 열지 않는다 — 빈 카드가 흐름을 끊으면 안 된다", () => {
  const { parts } = reduceEnvelope([
    { event: "delta", text: "가" },
    { event: "steer" },
    { event: "steer", text: "" },
    { event: "delta", text: "나" },
  ]);
  // 카드가 없으므로 텍스트 런도 끊기지 않는다 — 한 덩이 그대로다
  assert.deepEqual(parts, [{ type: "text", text: "가나" }]);
});

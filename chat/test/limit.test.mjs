import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvelopeReducer } from "../src/chat/envelope-reducer.ts";

test("limit 이벤트가 계정 상태로 남는다 — 턴이 끝나도 지워지지 않는다", () => {
  const r = new EnvelopeReducer();
  r.push({ event: "limit", status: "warn", scope: "five_hour", resets_at: 1788090600 });
  r.push({ event: "delta", text: "hi" });
  r.push({ event: "reply", text: "hi", usage: { input: 1, output: 1 } });
  assert.equal(r.meta.limit?.status, "warn");
  assert.equal(r.meta.limit?.scope, "five_hour");
  assert.equal(r.meta.limit?.resetsAt, 1788090600);
});

test("모르는 status 는 ok 로 떨어진다 — 거짓 경보가 거짓 안심보다 비싸다", () => {
  const r = new EnvelopeReducer();
  r.push({ event: "limit", status: "some_new_tool_word" });
  assert.equal(r.meta.limit?.status, "ok");
});

test("blocked 는 사유와 초과분 여부를 싣는다", () => {
  const r = new EnvelopeReducer();
  r.push({ event: "limit", status: "rejected" });
  assert.equal(r.meta.limit?.status, "ok", "rejected 는 어댑터가 blocked 로 좁혀 보낸다 — 리듀서는 기판 어휘만 안다");
  const r2 = new EnvelopeReducer();
  r2.push({ event: "limit", status: "blocked", overage: true, note: "out_of_credits" });
  assert.equal(r2.meta.limit?.status, "blocked");
  assert.equal(r2.meta.limit?.overage, true);
  assert.equal(r2.meta.limit?.note, "out_of_credits");
});

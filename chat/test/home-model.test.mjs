// home-model.test.mjs — 홈 런처의 순수 판정: 카드 선별·예시 순환·문구
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const m = await loadModule("home-model.ts");
const item = (o) => ({ pkg: "p", label: "P", description: "", version: "1", icon: null, face: "view", faces: ["view"], href: "/", view: null, detail: "/", resident: false, ring0: false, error: null, update: null, editing: false, ...o });

test("todoOf — 수정 중·새 판·오류만 남고 멀쩡한 앱은 빠진다", () => {
  const items = [item({ pkg: "ok" }), item({ pkg: "ed", editing: true }), item({ pkg: "up", update: "2.0" }), item({ pkg: "er", error: "x" })];
  assert.deepEqual(m.todoOf(items).map((i) => i.pkg), ["ed", "up", "er"]);
  assert.equal(m.updateCount(items), 1);
});

test("examplesAt — 묶음이 끝에서 처음으로 돌고 음수도 안전", () => {
  const n = m.EXAMPLES.length;
  assert.deepEqual(m.examplesAt(n), m.EXAMPLES[0]);
  assert.deepEqual(m.examplesAt(n + 1), m.EXAMPLES[1]);
  assert.deepEqual(m.examplesAt(-1), m.EXAMPLES[n - 1]);
  for (const set of m.EXAMPLES) for (const [name, sentence] of set) { assert.ok(name && sentence); }
});

test("문구 — 아바타 글자·초안 한 줄·빈 상태", () => {
  assert.equal(m.initialOf("  relay"), "R");
  assert.equal(m.initialOf(""), "?");
  assert.equal(m.draftLine(0), "아직 발행하지 않은 초안");
  assert.equal(m.draftLine(4), "아직 발행하지 않은 초안 — 바뀐 파일 4개");
  assert.equal(m.isEmptyNav({ items: [], drafts: [] }), true);
  assert.equal(m.isEmptyNav({ items: [], drafts: [{ name: "a", version: null, changes: 0, href: "/" }] }), false);
});

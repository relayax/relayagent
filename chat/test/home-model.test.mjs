// home-model.test.mjs — 홈 런처의 순수 판정: 카드 선별·예시 순환·문구
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

const m = await loadModule("home-model.ts");
const item = (o) => ({ pkg: "p", label: "P", description: "", version: "1", icon: null, face: "view", faces: ["view"], href: "/", view: null, detail: "/", resident: false, ring0: false, error: null, update: null, editing: false, ...o });

test("todoOf — 수정 중·새 버전·오류만 남고 멀쩡한 앱은 빠진다", () => {
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
  assert.equal(m.draftLine(0), "첫 버전 만듦 · 아직 적용 전");
  assert.equal(m.draftLine(4), "바뀐 파일 4개");
  assert.equal(m.describe("설명을 적어 주세요."), null);
  assert.equal(m.describe("  "), null);
  assert.equal(m.describe("가계부"), "가계부");
  assert.equal(m.isEmptyNav({ items: [], drafts: [] }), true);
  assert.equal(m.isEmptyNav({ items: [], drafts: [{ name: "a", version: null, changes: 0, empty: true, href: "/" }] }), false);
});

test("splitDrafts — 바뀐 파일 0 인 초안은 빈 초안으로 따로", () => {
  const d = (name, changes, empty) => ({ name, version: "0.1.0", changes, empty, href: "/" });
  const r = m.splitDrafts([d("a", 0, true), d("b", 3, false), d("c", 0, true), d("k", 0, false)]);
  assert.deepEqual(r.live.map((x) => x.name), ["b", "k"]);
  assert.deepEqual(r.empty.map((x) => x.name), ["a", "c"]);
});

test("cardAction — 오류 > 새 버전 > 수정 중 순으로 칩·버튼·목적지가 하나씩(수정 중은 칩 없음)", () => {
  assert.deepEqual(m.cardAction(item({ editing: true, detail: "/d" }), null), { status: "editing", chip: null, label: "수정", href: "/d" });
  assert.deepEqual(m.cardAction(item({ editing: true, update: "2.0", detail: "/d" }), "/lib"), { status: "update", chip: "새 버전 2.0", label: "업데이트", href: "/lib" });
  assert.equal(m.cardAction(item({ update: "2.0", detail: "/d" }), null).href, "/d");
  assert.equal(m.cardAction(item({ error: "x", update: "2.0", detail: "/d" }), "/lib").status, "error");
});

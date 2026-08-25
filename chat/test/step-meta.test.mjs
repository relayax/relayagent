// step-meta.test.mjs — 도구 이름의 **표시 목적 분해**(client-protocol §8-41).
//
// 못박는 것 하나: 분해가 짐작보다 먼저다. 순서가 뒤집히면 부분일치가 접두 분기를 가리고
// (mcp__ 분기가 죽은 코드였다), 서비스 이름이 라벨을 납치한다(spreadsheets 안의 read).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "./_load.mjs";

globalThis.window = {};
globalThis.document = { currentScript: null, querySelector: () => null };

const { stepMeta } = await loadModule("runtime.ts");

test("폴더 문은 연산과 폴더 이름으로 뜬다 — 어느 폴더인지가 사용자에게 보이는 유일한 축이다", () => {
  assert.equal(stepMeta("dir__inbox__read", { path: "2026-08/order-1.txt" }).label, "폴더 읽기 · inbox");
  assert.equal(stepMeta("dir__inbox__list", {}).label, "폴더 목록 · inbox");
  assert.equal(stepMeta("dir__inbox__remove", { path: "x" }).label, "폴더 삭제 · inbox");
  assert.equal(stepMeta("dir__inbox__read", { path: "a/b/c.txt" }).target, "c.txt");
});

test("서비스 이름이 라벨을 납치하지 않는다 — spreadsheets 안에 read 가 들어 있다", () => {
  assert.equal(stepMeta("dir__spreadsheets__remove", { path: "x" }).label, "폴더 삭제 · spreadsheets");
});

test("분해가 짐작보다 먼저다 — 접두 분기가 부분일치에 가려지지 않는다", () => {
  assert.equal(stepMeta("mcp__notion__search", {}).label, "notion · search");
  assert.equal(stepMeta("edge__offer-workbook__answers-read", {}).label, "빌린 동사 · offer-workbook · answers-read");
  assert.equal(stepMeta("a2a__devteam__product-context", {}).label, "위임 · devteam · product-context");
});

test("네이티브 도구는 종전대로 짐작으로 뜬다 — 접두가 없으면 분해할 것이 없다", () => {
  assert.equal(stepMeta("Read", { file_path: "/a/b.ts" }).label, "읽기");
  assert.equal(stepMeta("Bash", { command: "ls" }).label, "실행");
  assert.equal(stepMeta("Grep", { pattern: "x" }).label, "검색");
});

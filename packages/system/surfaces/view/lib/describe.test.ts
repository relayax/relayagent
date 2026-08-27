import { test } from "node:test";
import assert from "node:assert/strict";
import { cronToKorean, describe, providerLabel, scriptNamesFromFiles, scriptNamesFromTree, type Row } from "./describe.ts";
import type { Manifest } from "./types";

test("cronToKorean — 스펙의 표", () => {
  assert.equal(cronToKorean("0 22 * * *"), "매일 밤 10시");
  assert.equal(cronToKorean("30 9 * * *"), "매일 오전 9시 30분");
  assert.equal(cronToKorean("0 9 * * 1-5"), "평일 오전 9시");
  assert.equal(cronToKorean("0 14 * * 1"), "매주 월요일 오후 2시");
  assert.equal(cronToKorean("*/15 * * * *"), "15분마다");
  assert.equal(cronToKorean("0 */2 * * *"), "2시간마다");
  assert.equal(cronToKorean("0 0 1 * *"), null); // 매달 — 번역표 밖. 짐작하지 않는다
  assert.equal(cronToKorean("garbage"), null);
});

test("scriptNamesFromTree — scripts.source 바로 아래 *.ts 만", () => {
  const tree = ["relay.yaml", "scripts/", "  save.ts", "  list.ts", "  lib/", "    util.ts", "  README.md", "agents/", "  diary/", "    AGENT.md"];
  assert.deepEqual(scriptNamesFromTree(tree, "scripts"), ["save", "list"]);
  assert.deepEqual(scriptNamesFromTree(tree, "verbs"), []);
});

test("scriptNamesFromFiles — 평평한 목록에서도 같은 답", () => {
  const files = ["relay.yaml", "scripts/save.ts", "scripts/list.ts", "scripts/lib/util.ts", "scripts/README.md"];
  assert.deepEqual(scriptNamesFromFiles(files, "scripts"), ["save", "list"]);
  assert.deepEqual(scriptNamesFromFiles(files, undefined), []);
});

test("providerLabel", () => {
  assert.equal(providerLabel("anthropic"), "Claude");
  assert.equal(providerLabel("openai"), "OpenAI");
  assert.equal(providerLabel("moonshot"), "Kimi");
  assert.equal(providerLabel("acme"), "acme");
});

const byKey = (rows: Row[], key: string) => rows.find((r) => r.key === key)!;
const base = { workspace: "/w", scripts: [] as string[], edges: [], landing: null, activeHarness: null, labelOf: (n: string) => n, files: [] as string[] };

test("describe — 빈 매니페스트도 줄이 선다", () => {
  const rows = describe({}, base);
  assert.deepEqual(rows.map((r) => r.key), ["identity", "verbs", "when", "dirs", "talk", "faces", "links", "missions"]);
  assert.equal(byKey(rows, "verbs").empty, "아직 없음");
  assert.equal(byKey(rows, "when").empty, "아직 없음 — 부르면 움직입니다");
  assert.equal(byKey(rows, "talk").empty, "대화 없음");
  assert.deepEqual(byKey(rows, "dirs").items, [{ text: "작업 폴더", sub: "/w" }]);
});

test("describe — 일기 비서", () => {
  const m: Manifest = {
    name: "@local/diary",
    agents: [{ name: "diary" }],
    scripts: { source: "scripts" },
    triggers: [
      { id: "nudge", when: { cron: "0 22 * * *", tz: "Asia/Seoul" }, then: { agent: "diary" } },
      { id: "odd", when: { cron: "0 0 1 * *" }, then: { agent: "diary" } },
      { id: "onfile", when: { event: "file.changed" }, then: { script: "index" } },
    ],
    services: [
      { name: "diary", dir: "~/Relay/diary" },
      { name: "notion", api: "https://api.notion.com" },
    ],
    surfaces: { channels: [{ name: "slack", source: "ch/slack", entry: "run" }] },
    harness: { variants: [{ name: "claude-code", source: "h/cc", llm: { provider: "anthropic" } }] },
    requires: { binaries: [{ name: "git" }] },
  };
  const rows = describe(m, {
    ...base,
    scripts: ["save", "find", "month"],
    edges: [{ consumer: "diary", provider: "calendar", ref: "@local/calendar", tools: ["list"], granted: true }],
    landing: "diary",
    activeHarness: "claude-code",
    labelOf: (n) => (n === "calendar" ? "달력" : n),
  });
  assert.deepEqual(rows.map((r) => r.key), ["identity", "verbs", "when", "dirs", "talk", "faces", "links", "missions", "engine", "needs"]);
  assert.deepEqual(byKey(rows, "verbs").items.map((i) => i.text), ["save", "find", "month"]);
  assert.deepEqual(byKey(rows, "when").items, [
    { text: "매일 밤 10시", sub: "Asia/Seoul" },
    { text: "0 0 1 * *", sub: undefined },
    { text: "file.changed 이 생기면", sub: undefined },
  ]);
  assert.deepEqual(byKey(rows, "dirs").items, [{ text: "작업 폴더", sub: "/w" }, { text: "diary", sub: "~/Relay/diary" }]);
  assert.deepEqual(byKey(rows, "talk").items.map((i) => i.text), ["이 화면"]);
  assert.deepEqual(byKey(rows, "faces").items, [{ text: "slack", sub: "채널" }]);
  assert.deepEqual(byKey(rows, "links").items, [
    { text: "notion", sub: "https://api.notion.com" },
    { text: "달력의 도구를 빌려 씀", sub: "list" },
  ]);
  assert.deepEqual(byKey(rows, "engine").items, [{ text: "Claude", sub: undefined }]);
  assert.deepEqual(byKey(rows, "needs").items, [{ text: "git", sub: undefined }]);
  assert.equal(byKey(rows, "when").sec, "triggers");
});

test("describe — editing 이면 모든 섹션이 줄을 갖는다", () => {
  const rows = describe({}, base, { editing: true });
  assert.deepEqual(rows.map((r) => r.key), ["identity", "verbs", "when", "dirs", "talk", "faces", "links", "missions", "engine", "needs", "host", "org", "files"]);
  assert.equal(byKey(rows, "identity").items[0].text, "(이름 없음)");
  assert.equal(byKey(rows, "engine").empty, "아직 없음");
  assert.equal(byKey(rows, "host").advanced, true);
});

test("describe — 보기만 할 때는 빈 고급 줄을 생략한다", () => {
  const rows = describe({ name: "@local/x", version: "1.2.0" }, { ...base, files: ["relay.yaml", "notes.txt"] });
  assert.deepEqual(rows.map((r) => r.key), ["identity", "verbs", "when", "dirs", "talk", "faces", "links", "missions", "files"]);
  assert.deepEqual(byKey(rows, "identity").items, [{ text: "@local/x", sub: "1.2.0" }]);
  assert.deepEqual(byKey(rows, "files").items, [{ text: "notes.txt" }]);
});

test("describe — faces 줄과 보조 에이전트", () => {
  const m: Manifest = {
    agents: [{ name: "diary" }, { name: "indexer" }],
    surfaces: { view: { source: "view" }, components: { source: "parts" }, channels: [{ name: "slack", source: "c", entry: "run" }] },
  };
  const rows = describe(m, { ...base, landing: "diary" });
  assert.deepEqual(byKey(rows, "faces").items, [{ text: "화면", sub: "view" }, { text: "부품", sub: "parts" }, { text: "slack", sub: "채널" }]);
  assert.deepEqual(byKey(rows, "talk").items, [{ text: "이 화면" }, { text: "indexer", sub: "보조" }]);
});

test("describe — 동사 서술이 있으면 서술을 크게, 이름을 작게", () => {
  const rows = describe({}, { ...base, scripts: ["save", "list"], verbLabels: { save: "일기 저장" } });
  assert.deepEqual(byKey(rows, "verbs").items, [{ text: "일기 저장", sub: "save" }, { text: "list" }]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { agentSub, buildCron, cronToKorean, describe, engineLabel, parseCron, facts, matchScripts, providerLabel, scriptNamesFromFiles, scriptNamesFromTree, sentences, triggerTarget, type Para, type Row, type Tok } from "./describe.ts";
import type { Manifest } from "./types";

test("cronToKorean — 스펙의 표", () => {
  assert.equal(cronToKorean("0 22 * * *"), "매일 밤 10시");
  assert.equal(cronToKorean("30 9 * * *"), "매일 오전 9시 30분");
  assert.equal(cronToKorean("30 * * * *"), "매시 30분");
  assert.equal(cronToKorean("0 * * * *"), "매시 정각");
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

test("describe — raw 도구까지 빌리는 edge 는 따로 말한다", () => {
  const rows = describe({}, {
    ...base,
    edges: [
      { consumer: "diary", provider: "erp", ref: "@local/erp", tools: ["search"], agent_access: "full", granted: true },
      { consumer: "diary", provider: "calendar", ref: "@local/calendar", tools: ["list"], granted: true },
    ],
  });
  assert.deepEqual(byKey(rows, "links").items, [
    { text: "erp의 도구를 빌려 씀 (raw 도구까지)", sub: "search" },
    { text: "calendar의 도구를 빌려 씀", sub: "list" },
  ]);
});
test("matchScripts — agents[].scripts 의 글로브를 실제 동사에 편다", () => {
  const all = ["set-copy", "set-save", "campaign-list", "offer-use"];
  assert.deepEqual(matchScripts(["set-*"], all), ["set-copy", "set-save"]);
  assert.deepEqual(matchScripts(["offer-use", "campaign-*"], all), ["campaign-list", "offer-use"]);
  assert.deepEqual(matchScripts(undefined, all), []);
  assert.deepEqual(matchScripts(["없는-*"], all), []);
});

test("triggerTarget — 깨움이 실제로 무엇을 부르나", () => {
  assert.equal(triggerTarget({ then: { agent: "organizer" } }), "organizer");
  assert.equal(triggerTarget({ then: { script: "report-weekly" } }), "report-weekly");
  assert.equal(triggerTarget({ then: {} }), null);
});

test("agentSub — 보조 줄은 '무엇의 몇 개' 인지 말한다", () => {
  const all = ["set-copy", "set-save", "offer-use"];
  assert.equal(agentSub({ scripts: ["set-*"], dirs: ["memos"] }, all), "기능 2개 · 폴더 1개");
  assert.equal(agentSub({ dispatch: ["coach"] }, all), "도우미 1명");
  assert.equal(agentSub({}, all), undefined);
});

test("facts — 흐름 순서로, 없는 것은 칩을 내지 않는다", () => {
  const m: Manifest = {
    surfaces: { view: { source: "surfaces/view" }, channels: [{ name: "slack", source: "c/slack", entry: "i.ts" }] },
    triggers: [{ id: "w", when: { cron: "0 9 * * 1" }, then: { agent: "organizer" } }],
    agents: [{ name: "memo" }, { name: "organizer" }],
    services: [{ name: "memos", dir: "memos" }],
  };
  const f = facts(m, { scripts: ["a", "b", "c"], landing: "memo", edges: [] });
  assert.deepEqual(f.map((x) => x.text), [
    "웹 화면",
    "슬랙",
    "매주 월요일 오전 9시 자동",
    "기능 3개",
    "도우미 1명",
    "폴더 1개",
  ]);
  assert.deepEqual(facts({}, { scripts: [], landing: null, edges: [] }), []);
  assert.deepEqual(facts({ agents: [{ name: "a" }] }, { scripts: [], landing: "a", edges: [] }).map((x) => x.text), ["대화만"]);
});

// ── 문장 ────────────────────────────────────────────────────────────────────
const CTX = (over: Partial<Parameters<typeof sentences>[1]> = {}) => ({
  workspace: "/w", scripts: [], edges: [], landing: null, activeHarness: null,
  labelOf: (n: string) => n, files: [], ...over,
});
/** 문단을 사람이 읽는 한 줄로 — 토큰이든 글자든 이어 붙인다 */
const line = (p: Para): string => p.parts.map((x) => (typeof x === "string" ? x : x.t)).join("");
const toks = (p: Para): Tok[] => p.parts.filter((x): x is Tok => typeof x !== "string");

test("sentences — 주간 메모 정리(실물)", () => {
  const m: Manifest = {
    surfaces: { view: { source: "surfaces/view" } },
    triggers: [{ id: "weekly", when: { cron: "0 9 * * 1" }, then: { agent: "organizer" } }],
    harness: { variants: [{ name: "claude-code", source: "harness/claude-code" }] },
    agents: [{ name: "memo-weekly" }, { name: "organizer" }],
    services: [{ name: "memos", dir: "~/Relay/memo" }, { name: "digests", dir: "~/Relay/memo-weekly" }],
  };
  const [meet, doing, using] = sentences(m, CTX({ scripts: ["a", "b", "c", "d", "e"], landing: "memo-weekly" }));
  // 깨움이 문(memo-weekly)이 아니라 organizer 를 직접 부른다 — 그 이름이 문장에 나온다
  assert.equal(line(meet), "웹 화면에서 만나고, 매주 월요일 오전 9시에 organizer 도우미를 깨웁니다.");
  assert.ok(toks(meet).some((t) => t.sec === "agents" && t.item === "organizer"));
  assert.equal(line(doing), "Claude 엔진으로 돌아가고, organizer 도우미와 함께 5가지 일을 합니다.");
  // 폴더는 선언 이름("memos")이 아니라 사람이 파인더에서 여는 그 경로로 부른다
  assert.equal(line(using), "~/Relay/memo · ~/Relay/memo-weekly 폴더를 읽고 씁니다. ");
  // 없는 것만 점선으로 — 있는 것에는 붙지 않는다
  assert.deepEqual(meet.adds, []);
  assert.deepEqual(doing.adds, []);
  assert.deepEqual(using.adds.map((a) => a.sec), ["edges", "missions"]);
});

test("sentences — 낱말마다 갈 곳이 있다", () => {
  const m: Manifest = {
    surfaces: { view: { source: "v" }, channels: [{ name: "slack", source: "s", entry: "e" }] },
    triggers: [{ id: "t1", when: { cron: "0 9 * * 1" }, then: {} }],
  };
  const [meet] = sentences(m, CTX({ landing: "a" }));
  assert.deepEqual(toks(meet).map((t) => [t.sec, t.item]), [
    ["surfaces", "view"], ["surfaces", "channel:slack"], ["triggers", "t1"],
  ]);
  assert.equal(line(meet), "웹 화면 · 슬랙에서 만나고, 매주 월요일 오전 9시에 알아서 움직입니다.");
});

test("sentences — 빈 패키지는 붙일 것만 말한다", () => {
  const [meet, doing, using] = sentences({}, CTX());
  assert.equal(line(meet), "아직 만날 곳이 없습니다.");
  assert.equal(line(doing), "아직 할 수 있는 일이 없습니다.");
  assert.equal(line(using), "쓰는 폴더나 연결이 없습니다.");
  // 빈 패키지에서는 붙일 수 있는 것이 전부 나온다 — 화면이 맨 아래 한 묶음으로 모으므로
  // 문단마다 자를 이유가 없다. 그 묶음이 곧 "무엇을 만들 수 있나" 의 차림표다
  assert.deepEqual([meet, doing, using].flatMap((p) => p.adds).map((a) => a.sec), [
    "surfaces", "triggers", "scripts", "harness", "services", "edges", "missions",
  ]);
});

test("sentences — 조사가 붙는 말은 전부 고정어다", () => {
  // 값 뒤에는 받침을 따지는 조사(로/으로 · 을/를 · 와/과 · 이/가)가 오면 안 된다.
  // "슬랙" 과 "organizer" 는 받침 판정이 서로 다르고, 로마자는 한국어 발음이 따로다
  const m: Manifest = {
    surfaces: { channels: [{ name: "slack", source: "s", entry: "e" }] },
    harness: { variants: [{ name: "codex", source: "h" }] },
    agents: [{ name: "memo" }, { name: "organizer" }],
    services: [{ name: "memos", dir: "~/m" }],
    missions: [{ name: "x" }],
  };
  for (const p of sentences(m, CTX({ scripts: ["a"], landing: "memo" }))) {
    for (let i = 0; i < p.parts.length; i++) {
      const part = p.parts[i];
      if (typeof part === "string") continue;
      const next = p.parts[i + 1];
      if (typeof next !== "string") continue;
      // 붙박이 이름은 내가 쓴 글자 그대로라 받침이 정해져 있다 — 규칙은 **값**에만 건다
      if (part.fixed) continue;
      assert.doesNotMatch(next, /^(으로|로|을|를|와|과|이|가|은|는)\b/, `"${part.t}" 뒤에 "${next}"`);
    }
  }
});

test("sentences — 폴더와 서비스는 이름이 아니라 실체로 부른다", () => {
  const m: Manifest = {
    services: [
      { name: "memos", dir: "~/Relay/memo" },
      { name: "notion", api: "https://api.notion.com/v1" },
      { name: "weird", url: "${NOT_A_URL}" },
    ],
  };
  const [, , using] = sentences(m, CTX());
  // 폴더는 경로, 바깥 서비스는 호스트. 주소가 아니면 그때만 선언 이름으로 물러선다
  assert.equal(line(using), "~/Relay/memo 폴더를 읽고 씁니다. api.notion.com · weird에 연결합니다. ");
  // 낱말이 여는 문은 그대로 선언 이름이다 — 보이는 말만 바뀐다
  assert.deepEqual(toks(using).map((t) => t.item), ["memos", "notion", "weird"]);
});

// ── cron 고르개 ──────────────────────────────────────────────────────────────
test("parseCron · buildCron — 고르개가 다루는 것은 번역표와 같은 집합이다", () => {
  const picks: import("./describe.ts").CronPick[] = [
    { every: "day", hour: 9, min: 0 },
    { every: "day", hour: 22, min: 30 },
    { every: "weekday", hour: 9, min: 0 },
    { every: "week", dow: 1, hour: 9, min: 0 },
    { every: "week", dow: 0, hour: 18, min: 15 },
    { every: "hour", min: 30 },
    { every: "minutes", n: 15 },
    { every: "hours", n: 3 },
  ];
  for (const p of picks) {
    const expr = buildCron(p);
    // 고른 것은 반드시 사람 말이 된다 — 고르개와 읽기가 어긋나면 만든 예약이 목록에서 날식으로 뜬다
    assert.ok(cronToKorean(expr), `번역 못 함: ${expr}`);
    assert.deepEqual(parseCron(expr), p, expr);
  }
});

test("parseCron — 번역표 밖의 식은 고르개를 못 세운다", () => {
  for (const bad of ["0 9 * * 1,3,5", "0 9 1 * *", "0 9 * 3 *", "not a cron", "0 99 * * *"]) {
    assert.equal(parseCron(bad), null, bad);
    assert.equal(cronToKorean(bad), null, bad);
  }
});

test("describe — 사이드바 자리는 결재·선언이 있을 때만 줄에 선다", () => {
  const withParts: Manifest = { surfaces: { components: { source: "parts" } } };
  // 기본(결재 없음·선언 없음)은 늘리지 않는다
  assert.deepEqual(byKey(describe(withParts, base), "faces").items, [{ text: "부품", sub: "parts" }]);
  // 결재로 접힌 것 — 어느 앱 밑인지 표시 이름으로
  const folded = describe(withParts, { ...base, labelOf: (n) => (n === "studio" ? "카드뉴스 스튜디오" : n), mountedIn: ["studio"] });
  assert.deepEqual(byKey(folded, "faces").items[1], { text: "카드뉴스 스튜디오 안에서 쓰임", sub: "사이드바에서 그 밑으로 접힘" });
  // 선언이 결재를 이긴다
  assert.equal(byKey(describe({ ...withParts, shell: { nav: "always" } }, { ...base, mountedIn: ["studio"] }), "faces").items[1].text, "사이드바 늘 최상위");
  assert.equal(byKey(describe({ shell: { nav: "never" } }, base), "faces").items[0].text, "사이드바에 숨김");
});

test("sentences — 사이드바 자리 문단은 접혔거나 숨겼거나 못박았을 때만 선다", () => {
  const withParts: Manifest = { surfaces: { view: { source: "v" }, components: { source: "parts" } } };
  assert.ok(!sentences(withParts, base).some((p) => p.key === "seat"));
  const folded = sentences(withParts, { ...base, labelOf: (n) => (n === "studio" ? "카드뉴스 스튜디오" : n), mountedIn: ["studio"] });
  const seat = folded.find((p) => p.key === "seat")!;
  assert.deepEqual(seat.parts, [{ t: "사이드바", sec: "identity" }, "에서는 카드뉴스 스튜디오 밑에 접혀 있습니다."]);
  assert.equal(sentences({ shell: { nav: "never" } }, base).find((p) => p.key === "seat")!.parts[1], "에는 숨겨져 있습니다 — 상세와 직접 주소로만 엽니다.");
  assert.equal(sentences({ ...withParts, shell: { nav: "always" } }, { ...base, mountedIn: ["studio"] }).find((p) => p.key === "seat")!.parts[1], "에 늘 최상위로 섭니다.");
});

// ── 풀 어댑터: 활성 하네스가 이 매니페스트에 없는 것이 정상이다 ────────────
// 어댑터가 기판 풀에서 오면서(RELAY_HOME/adapters) 활성 이름이 harness.variants 밖인 경우가
// 일상이 됐다. 종전에는 `?? variants[0]` 로 조용히 첫 후보를 그려서, 장부는 kimi 인데 화면은
// claude-code 를 말했다 — 러너에서 은퇴시킨 조용한 폴백이 화면에 살아 있던 자리(2026-08-30).
const poolCtx = {
  workspace: "/w", scripts: [], edges: [], landing: null, files: [],
  labelOf: (n: string) => n,
};
const bundledOnly: Manifest = {
  harness: { variants: [{ name: "claude-code", source: "harness/claude-code", entry: "run", llm: { provider: "anthropic" } }] },
} as Manifest;

test("풀 전용 하네스를 골라도 동봉 첫 후보로 조용히 떨어지지 않는다", () => {
  const rows = describe(bundledOnly, { ...poolCtx, activeHarness: "kimi" } as never);
  const engine = rows.find((r) => r.key === "engine");
  // 이 매니페스트에 kimi 가 없으니 provider 는 모른다 — 그래도 claude 라고 말해선 안 된다
  assert.equal(engine?.items.length, 1);
  assert.equal(engine?.items[0].text, "kimi", "모르면 하네스 이름을 그대로 — 틀린 제공사를 말하지 않는다");
});

test("동봉 변형을 고르면 종전대로 제공사 이름이 선다", () => {
  const rows = describe(bundledOnly, { ...poolCtx, activeHarness: "claude-code" } as never);
  assert.equal(rows.find((r) => r.key === "engine")?.items[0].text, providerLabel("anthropic"));
});

test("문장도 장부의 활성 이름을 따른다 — 동봉 목록으로 거르지 않는다", () => {
  const paras = sentences(bundledOnly, { ...poolCtx, activeHarness: "kimi" } as never);
  const flat = paras.flatMap((p) => p.parts).map((x) => (typeof x === "string" ? x : x.t)).join("");
  assert.ok(flat.includes(engineLabel("kimi")), `kimi 가 문장에 서야 한다: ${flat}`);
  assert.ok(!flat.includes(engineLabel("claude-code")), "동봉 첫 후보가 새어나오면 안 된다");
});

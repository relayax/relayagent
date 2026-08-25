import test from "node:test";
import assert from "node:assert/strict";
import { locateIssues } from "./manifest.ts";

// 판정 문장의 첫 토막이 선언 경로라는 규칙성을 좌표로 되읽는다. 이 시험이 지키는 불변식은
// 하나다: 짚으면 그 줄이 맞고, 못 짚으면 null 이다 — 지어낸 좌표는 없다.

const YAML = `schema: relay/v1
name: "@local/diary"
version: 0.2.0
surfaces:
  view:
    source: surfaces/view
    out: out
agents:
  - name: diary
    greeting: 오늘 하루는 어땠나요?
  - name: helper
    persona: agents/helper/AGENT.md
triggers:
  - id: daily-digest
    when: { cron: "0 9 * * 1-5" }
`;

const at = (line: number) => YAML.split("\n")[line - 1];

test("점 경로를 그 줄로 짚는다", () => {
  const [v] = locateIssues(YAML, ["surfaces.view.source: 상대경로 필수"]);
  assert.equal(v.line, 6);
  assert.match(at(v.line!), /source: surfaces\/view/);
  assert.equal(v.path, "surfaces.view.source");
});

test("이름 첨자는 그 이름을 가진 항목으로 해석된다 — 문서 노드는 이름을 모른다", () => {
  const [v] = locateIssues(YAML, ["agents[helper].persona: 실체 없음: agents/helper/AGENT.md"]);
  assert.equal(v.line, 12);
  assert.match(at(v.line!), /persona: agents\/helper/);
});

test("없는 키를 짚는 판정은 부모에 앉는다 — 무엇이 빠졌는지는 부모를 봐야 안다", () => {
  const [v] = locateIssues(YAML, ["agents[diary].persona: 필수"]);
  assert.equal(v.line, 9); // agents[0] 항목의 첫 줄
  assert.match(at(v.line!), /name: diary/);
  assert.equal(v.path, "agents.diary.persona");
});

test("triggers 는 id 로 짚는다 — 항목의 이름 키가 name 하나가 아니다", () => {
  const [v] = locateIssues(YAML, ["triggers[daily-digest].when.cron 형식 위반: x"]);
  assert.equal(v.line, 15);
  assert.match(at(v.line!), /cron/);
});

test("최상위 키도 짚는다", () => {
  const [v] = locateIssues(YAML, ["version 형식 위반(semver): 0.2"]);
  assert.equal(v.line, 3);
});

test("경로로 읽히지 않는 판정은 좌표 없이 나간다 — 지어내지 않는다", () => {
  const [v] = locateIssues(YAML, ["미지 최상위 키: nonsense"]);
  assert.equal(v.line, null);
  assert.equal(v.path, null);
});

test("문서에 없는 경로는 좌표가 없다", () => {
  const [v] = locateIssues(YAML, ["services[notion].url: 필수"]);
  assert.equal(v.line, null);
  assert.equal(v.path, "services.notion.url");
});

test("문장 수와 좌표 수는 언제나 같다 — 화면이 둘을 나란히 쓴다", () => {
  const issues = ["version 형식 위반(semver): x", "미지 최상위 키: y", "surfaces.view.out: 상대경로 필수"];
  assert.equal(locateIssues(YAML, issues).length, issues.length);
});

test("깨진 YAML 에서도 죽지 않는다 — 판정 중에는 문서가 반쯤 고쳐져 있다", () => {
  const broken = "surfaces:\n  view:\n   source: [unclosed\n";
  const out = locateIssues(broken, ["surfaces.view.source: 상대경로 필수"]);
  assert.equal(out.length, 1);
  assert.equal(typeof out[0].message, "string");
});

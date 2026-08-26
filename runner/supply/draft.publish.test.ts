// 발행의 두 절반 — stageRelease(판정·커밋·태그·스냅샷, 장부 무변)와 landRelease(장부 전환).
// 임베더가 착지를 맡는 기판(Authority.publish)은 앞 절반만 쓰고 발행물을 자기 유통망에 올린다.
// 두 절반의 합이 publishDraft 와 같아야 1인 기판의 동작이 그대로다.
//
//   node --experimental-strip-types --test runner/supply/draft.publish.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-publish-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = mk(path.join(ROOT, "relay-home"));

const { openDraft, stageRelease, landRelease, publishDraft } = await import("./draft.ts");
const { saveLedger, loadLedger } = await import("./ledger.ts");
const { packDir } = await import("./pack.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 픽셔 어댑터 — conform 이 부르는 info/setup/models/commands 에 답한다 */
const ADAPTER = [
  "#!/bin/bash",
  "set -eu",
  'if [ "${1:-}" = "info" ]; then printf \'%s\\n\' \'{"name":"only","provider":"none","protocol":3,"verbs":["session","info","setup","models","commands"],"capabilities":[]}\'; exit 0; fi',
  'if [ "${1:-}" = "models" ]; then printf \'%s\\n\' \'["m"]\'; exit 0; fi',
  'if [ "${1:-}" = "commands" ]; then printf \'%s\\n\' \'[]\'; exit 0; fi',
  'if [ "${1:-}" = "setup" ]; then exit 0; fi',
  'if [ "${1:-}" = "session" ]; then printf \'%s\\n\' \'{"event":"reply","text":"ok"}\'; exit 0; fi',
  'echo "unknown verb: ${1:-}" >&2; exit 2',
].join("\n") + "\n";

const NAME = "pubfix";
saveLedger({ secret: "s", packages: {}, grants: [] });
openDraft(loadLedger(), NAME, {
  files: {
    "relay.yaml": [
      "schema: relay/v1",
      `name: "@local/${NAME}"`,
      "version: 0.1.0",
      `display_name: "${NAME}"`,
      'description: "발행 두 절반 검증용 픽스처"',
      "harness:",
      "  variants:",
      "    - name: only",
      "      source: harness/only",
      "      entry: run",
      "agents:",
      "  - name: a",
      "    default: true",
      "    persona: agents/a/AGENT.md",
      "",
    ].join("\n"),
    "agents/a/AGENT.md": "픽스처.\n",
    "harness/only/run": ADAPTER,
  },
});
// writeDraft 는 내용만 쓴다 — 어댑터 entry 는 실행 비트가 있어야 conform 을 지난다
fs.chmodSync(path.join(process.env.HOME!, "Relay", "packages", NAME, "harness", "only", "run"), 0o755);

test("stageRelease 는 스냅샷을 뜨되 장부를 건드리지 않는다 — 착지는 별 걸음", () => {
  const st = stageRelease(NAME);
  assert.ok(!("published" in st), "판정 통과 → 스냅샷");
  if ("published" in st) return;
  assert.equal(st.version, "0.1.0");
  assert.ok(fs.existsSync(path.join(st.path, "relay.yaml")));
  assert.equal(loadLedger().packages[NAME], undefined, "장부 무변");
  // 임베더가 하는 일 — 스냅샷을 봉투로 굽는다(pack 규율 그대로)
  const env = packDir(st.path, path.join(ROOT, "env.tgz"));
  assert.match(env.digest, /^sha256:/);
  assert.equal(env.ref, `@local/${NAME}`);
});

test("landRelease 가 장부에 앉힌다 — 두 절반의 합 = publishDraft", () => {
  const st = stageRelease(NAME, { version: "0.1.1" });
  assert.ok(!("published" in st));
  if ("published" in st) return;
  const ledger = loadLedger();
  const r = landRelease(ledger, st);
  assert.equal(r.fresh, true);
  assert.equal(loadLedger().packages[NAME].path, st.path);
  // 변경 없음 = 발행할 것 없음(앞 절반이 먼저 답한다)
  const again = publishDraft(loadLedger(), NAME);
  assert.equal(again.published, false);
});

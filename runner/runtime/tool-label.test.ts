// 도구 이름의 뜻은 기판이 붙인다 — 어댑터는 이름만 알고 지나간다.
//
// 두 가지가 조용히 회귀하는 자리다: 캡 밖 동사의 이름까지 실어 보내면 세션이 못 부르는 도구가
// 화면에 서고, 서술 전체를 실으면 카드 한 줄이 문장에 밀려 대상이 사라진다.
//
//   node --experimental-strip-types --test runner/runtime/tool-label.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Ledger } from "../supply/ledger.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-label-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { verbLabels } = await import("./scripts.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const PKG = mk(path.join(ROOT, "orders"));
fs.writeFileSync(
  path.join(PKG, "relay.yaml"),
  [
    "schema: relay/v1",
    'name: "@t/orders"',
    "version: 0.1.0",
    'display_name: "주문"',
    'description: "도구 이름 시험 픽스처"',
    "harness:",
    "  variants:",
    "    - name: shell",
    "      source: harness",
    "      entry: run",
    "agents:",
    "  - name: orders",
    "    persona: AGENT.md",
    "    scripts: [orders-*]",
    "scripts:",
    "  source: scripts",
  ].join("\n") + "\n",
);
fs.writeFileSync(path.join(PKG, "AGENT.md"), "주문 에이전트\n");
fs.writeFileSync(path.join(mk(path.join(PKG, "harness")), "run"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
const S = mk(path.join(PKG, "scripts"));
const verb = (f: string, body: string) => fs.writeFileSync(path.join(S, f), body);
verb("orders-sync.ts", 'export const meta = { description: "주문 동기화 — ERP 의 주문을 받아 내려 오늘 치를 맞춘다." };\nexport default async function () { return {}; }\n');
verb("orders-long.ts", 'export const meta = { description: "이 서술은 한 줄 카드에 서기에는 지나치게 길어서 잘려야 마땅한 문장이다." };\nexport default async function () { return {}; }\n');
verb("orders-bare.ts", "export default async function () { return {}; }\n");
verb("secret-read.ts", 'export const meta = { description: "캡 밖 동사 — 이 이름은 실려 나가면 안 된다." };\nexport default async function () { return {}; }\n');

const ledger: Ledger = { packages: { orders: { path: PKG } }, grants: [] } as unknown as Ledger;

test("서술의 첫 마디가 이름이 된다 — 문장 전체는 대상 자리를 밀어낸다", async () => {
  const labels = await verbLabels(ledger, "orders", "orders");
  assert.equal(labels["orders-sync"], "주문 동기화");
});

test("긴 서술은 잘린다 — 카드 한 줄에 서는 길이", async () => {
  const labels = await verbLabels(ledger, "orders", "orders");
  assert.ok(labels["orders-long"].length <= 24, labels["orders-long"]);
  assert.ok(labels["orders-long"].endsWith("…"));
});

test("meta 없는 동사에는 이름이 없다 — 지어내지 않는다(화면은 원문 슬러그로 떨어진다)", async () => {
  const labels = await verbLabels(ledger, "orders", "orders");
  assert.equal(labels["orders-bare"], undefined);
});

test("캡 밖 동사는 실리지 않는다 — 세션이 못 부르는 도구가 화면에 서면 안 된다", async () => {
  const labels = await verbLabels(ledger, "orders", "orders");
  assert.equal(labels["secret-read"], undefined);
});

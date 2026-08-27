// ServiceIO.workspace — 임베더가 동사의 바닥을 답하면 ctx.workspace 가 그것이고, 안 답하면 장부다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ws-"));
process.env.RELAY_HOME = path.join(ROOT, "home");

const { makeCtx } = await import("./scripts.ts");
const { localAuthority } = await import("../authority.ts");

const pkgDir = path.join(ROOT, "pkg");
fs.mkdirSync(path.join(pkgDir, "scripts"), { recursive: true });
fs.writeFileSync(path.join(pkgDir, "relay.yaml"), 'schema: relay/v1\nname: "@t/ws"\nversion: 0.0.1\ndisplay_name: ws\ndescription: 바닥 시험\nscripts:\n  source: scripts\n');
const ledger = { secret: "s", packages: { "@t/ws": { path: pkgDir, workspace: path.join(ROOT, "shared") } }, grants: [] };
const authority = localAuthority(() => ledger as never);
const caller = { principal: "alice" };

test("임베더가 바닥을 답하면 ctx.workspace 는 그것이고 폴더는 만들어진다", () => {
  const io = { body: () => null, workspace: (pkg: string) => path.join(ROOT, "per", "alice", pkg) };
  const ctx = makeCtx(ledger as never, "@t/ws", caller, null, authority, io);
  assert.equal(ctx.workspace, path.join(ROOT, "per", "alice", "@t/ws"));
  assert.ok(fs.existsSync(ctx.workspace));
});

test("답하지 않으면 장부의 workspace(1인 기판)", () => {
  const ctx = makeCtx(ledger as never, "@t/ws", caller, null, authority, { body: () => null });
  assert.equal(ctx.workspace, path.join(ROOT, "shared"));
});

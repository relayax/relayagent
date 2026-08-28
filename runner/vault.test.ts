import { strict as assert } from "node:assert";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 홈을 갈랐을 때 자격이 실제로 갈리는지 — 파일 vault 로 본다(Keychain 은 사용자 것을
 *  오염시키므로 RELAY_VAULT=file 로 강제한다, hasSecurity 의 계약) */
function run(home: string, body: string): string {
  return execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", body], {
    encoding: "utf8",
    env: { ...process.env, RELAY_HOME: home, RELAY_VAULT: "file" },
    cwd: path.resolve(import.meta.dirname, ".."),
  }).trim();
}

test("홈이 다르면 자격도 다르다", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "relay-vault-"));
  const a = path.join(base, "home-a");
  const b = path.join(base, "home-b");
  const put = (h: string, v: string) =>
    run(h, `import {vaultSet} from "${path.resolve(import.meta.dirname, "vault.ts")}"; vaultSet("pkg/svc", ${JSON.stringify(v)}); console.log("ok")`);
  const get = (h: string) =>
    run(h, `import {vaultGet} from "${path.resolve(import.meta.dirname, "vault.ts")}"; console.log(JSON.stringify(vaultGet("pkg/svc")))`);

  put(a, "AAA");
  assert.equal(get(a), '"AAA"');
  assert.equal(get(b), "null", "다른 홈에서는 보이지 않아야 한다");

  put(b, "BBB");
  assert.equal(get(a), '"AAA"', "서로 덮어쓰지 않는다");
  assert.equal(get(b), '"BBB"');
  fs.rmSync(base, { recursive: true, force: true });
});

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

// "없음"은 캐시해도 되지만, 내 손으로 앉힌 자격까지 가리면 안 된다. 자격이 안 앉은 좌표의
// 조회가 조회마다 동기 스폰 둘을 물어(내 자리 + 옛 자리) 사이드바 배지가 15초마다 기판을
// 0.7초씩 멈추던 자리의 답이다(2026-08-29). 캐시하는 것은 부재뿐 — 값은 담지 않는다.
test("없다고 확인한 좌표도 앉히면 즉시 보이고, 지우면 즉시 사라진다", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-vault-absent-"));
  const v = path.resolve(import.meta.dirname, "vault.ts");
  // 한 프로세스 안에서 — 부재 캐시는 프로세스 것이라 나눠 부르면 축이 사라진다
  const out = run(home, [
    `import {vaultGet, vaultSet, vaultDelete} from "${v}";`,
    'const seen = [];',
    'seen.push(vaultGet("pkg/svc"));',   // 없음 → 캐시에 앉는다
    'seen.push(vaultGet("pkg/svc"));',   // 캐시가 답한다 (여전히 없음)
    'vaultSet("pkg/svc", "V");',
    'seen.push(vaultGet("pkg/svc"));',   // 캐시가 무효화돼 값이 보여야 한다
    'seen.push(vaultGet("other/svc"));', // 다른 좌표는 이 캐시와 무관
    'vaultDelete("pkg/svc");',
    'seen.push(vaultGet("pkg/svc"));',   // 지운 것은 즉시 사라져야 한다
    'console.log(JSON.stringify(seen));',
  ].join("\n"));

  assert.deepEqual(JSON.parse(out), [null, null, "V", null, null]);
  fs.rmSync(home, { recursive: true, force: true });
});

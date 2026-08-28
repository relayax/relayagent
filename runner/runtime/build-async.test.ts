// 빌드는 데몬을 붙들지 않는다 — 발행 한 번의 Next 빌드가 수십 초 도는 동안 이벤트 루프가 멈추면
// 콘솔·위젯의 SSE 가 끊기고 도는 세션의 도구 호출이 걸리고, 데스크톱 앱은 데몬을 죽은 것으로 본다
// (실측 2026-08-28: 앱의 "데몬이 이미 실행 중입니다" 가 빌드 완료 1초 전에 찍혔다 — 사용자에게는
// 기판이 주기적으로 재기동되는 것으로 보였다). 비동기가 되면서 생기는 두 번째 축도 같이 지킨다:
// 같은 디렉토리의 빌드는 겹치지 않는다(산출을 두 손이 동시에 쓰면 반쪽 번들이 된다).
//
//   node --experimental-strip-types --test runner/runtime/build-async.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Manifest } from "../supply/manifest.ts";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-build-async-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { buildComponents } = await import("./view.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

/** 빌드 가능한 최소 프로젝트 — 굽는 데 holdMs 만큼 걸리고, 시작·끝 시각을 산출 옆에 남긴다 */
function project(name: string, build: string): { dir: string; m: Manifest; log: string } {
  const dir = mk(path.join(ROOT, name));
  const src = mk(path.join(dir, "parts"));
  mk(path.join(src, "node_modules")); // 설치 단계는 건너뛴다 — 축은 npm install 이 아니라 굽기다
  fs.writeFileSync(path.join(src, "package.json"), JSON.stringify({ name, private: true, scripts: { build } }));
  fs.writeFileSync(
    path.join(src, "build.mjs"),
    [
      'import fs from "node:fs";',
      "const hold = Number(process.argv[2] ?? 0);",
      'fs.mkdirSync("dist", { recursive: true });',
      'fs.appendFileSync("dist/log", `start ${Date.now()}\\n`);',
      "await new Promise((r) => setTimeout(r, hold));",
      'fs.writeFileSync("dist/index.js", "export const mount = () => {};\\n");',
      'fs.appendFileSync("dist/log", `end ${Date.now()}\\n`);',
    ].join("\n"),
  );
  const m = { surfaces: { components: { source: "parts", out: "dist" } } } as unknown as Manifest;
  return { dir, m, log: path.join(src, "dist", "log") };
}

test("빌드 중에도 이벤트 루프가 돈다 — 타이머가 제때 깨어난다", async () => {
  const p = project("slow", "node build.mjs 1500");
  const build = buildComponents(p.dir, p.m);
  const t = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  const lag = Date.now() - t;
  assert.ok(lag < 500, `빌드가 루프를 붙들었다 — 50ms 타이머가 ${lag}ms 뒤에 깼다`);
  const r = await build;
  assert.ok(r?.ok, r?.out ?? "빌드 결과 없음");
  assert.ok(fs.existsSync(path.join(p.dir, "parts", "dist", "index.js")));
});

test("같은 디렉토리의 빌드 둘은 겹치지 않는다 — 뒤의 것이 앞의 것을 기다린다", async () => {
  const p = project("serial", "node build.mjs 400");
  const [a, b] = await Promise.all([buildComponents(p.dir, p.m), buildComponents(p.dir, p.m)]);
  assert.ok(a?.ok && b?.ok, `${a?.out}\n${b?.out}`);
  const marks = fs.readFileSync(p.log, "utf8").trim().split("\n").map((l) => l.split(" "));
  assert.deepEqual(marks.map((x) => x[0]), ["start", "end", "start", "end"], "시작·끝이 번갈아야 한다 — 겹치면 start start 가 된다");
  assert.ok(Number(marks[2][1]) >= Number(marks[1][1]), "두 번째 시작이 첫 번째 끝보다 앞선다");
});

test("실패는 결과에 남는다 — 종료 코드가 0 이 아니면 ok:false 와 꼬리", async () => {
  const p = project("broken", "node -e \"console.error('부러짐'); process.exit(3)\"");
  const r = await buildComponents(p.dir, p.m);
  assert.equal(r?.ok, false);
  assert.match(r?.out ?? "", /부러짐/);
});

// 작업 폴더 파일 문(GET /pkg/<n>/workspace/<경로>) — 패키지 자기 화면이 자기 산출물을 그리는
// 읽기전용 문이다. 감금은 dir 문과 같은 벌(jail)이고 응답은 재검증형이다: 같은 주소에 덮어쓰인
// 카드가 옛 판으로 남던 것이 이 문이 생긴 이유의 절반이라, 304 와 "바뀌면 200" 을 함께 본다.
// URL 파서의 `..` 정규화에 기대지 않으려고 요청 경로를 날것으로 넘긴다 — 문의 판정은 문의 것이다.
//
//   node --experimental-strip-types --test runner/runtime/workspace-file.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-wsfile-"));
process.env.HOME = mk(path.join(ROOT, "home"));
process.env.USERPROFILE = process.env.HOME;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");

const { serveWorkspaceFile } = await import("./view.ts");

function mk(p: string): string {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

const WS = mk(path.join(ROOT, "ws"));
const OUTSIDE = mk(path.join(ROOT, "outside"));
fs.writeFileSync(path.join(OUTSIDE, "secret.txt"), "남의 것");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
fs.writeFileSync(path.join(mk(path.join(WS, "render")), "card-01.png"), PNG);
fs.writeFileSync(path.join(WS, ".seed.json"), "{}");
fs.writeFileSync(path.join(mk(path.join(WS, "프로젝트")), "카드.svg"), "<svg/>");
fs.symlinkSync(OUTSIDE, path.join(WS, "shortcut"));

// 데몬이 하는 일의 문 안쪽만 — 라우트 매치 뒤 넘어오는 rel 은 이미 디코드된 문자열이다
const server = http.createServer((req, res) => serveWorkspaceFile(WS, decodeURIComponent((req.url ?? "/").slice(1)), req, res));
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const PORT = (server.address() as net.AddressInfo).port;
test.after(() => server.close());

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
const raw = (p: string, headers: Record<string, string> = {}): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path: p, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c as Buffer));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });

test("파일 하나가 그 형식으로, 재검증 헤더를 달고 나온다", async () => {
  const r = await raw("/render/card-01.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/png");
  assert.equal(r.headers["cache-control"], "no-cache");
  assert.ok(r.headers.etag && r.headers["last-modified"], "재검증 헤더가 없다");
  assert.deepEqual(r.body, PNG);
});

test("안 바뀐 파일은 304 한 줄, 덮어쓴 파일은 같은 주소에서 새 판이 온다", async () => {
  const first = await raw("/render/card-01.png");
  const same = await raw("/render/card-01.png", { "if-none-match": String(first.headers.etag) });
  assert.equal(same.status, 304);
  assert.equal(same.body.length, 0);
  const byDate = await raw("/render/card-01.png", { "if-modified-since": String(first.headers["last-modified"]) });
  assert.equal(byDate.status, 304);

  const NEXT = Buffer.concat([PNG, Buffer.from([9, 9, 9])]);
  fs.writeFileSync(path.join(WS, "render", "card-01.png"), NEXT);
  const again = await raw("/render/card-01.png", { "if-none-match": String(first.headers.etag) });
  assert.equal(again.status, 200);
  assert.notEqual(again.headers.etag, first.headers.etag);
  assert.deepEqual(again.body, NEXT);
});

test("폴더 밖으로는 못 나간다 — `..` 등반·절대경로·심링크가 한 판정에서 막힌다", async () => {
  const climb = await raw("/../outside/secret.txt");
  assert.equal(climb.status, 403);
  assert.match(climb.body.toString(), /폴더 밖 경로/);
  const absolute = await raw("//etc/passwd");
  assert.equal(absolute.status, 403);
  assert.match(absolute.body.toString(), /절대경로/);
  const link = await raw("/shortcut/secret.txt");
  assert.equal(link.status, 403);
  assert.match(link.body.toString(), /심링크/);
});

test("숨은 파일·폴더·없는 파일은 404 — 이 문은 파일 하나만 낸다", async () => {
  assert.equal((await raw("/.seed.json")).status, 404);
  assert.equal((await raw("/render")).status, 404);
  assert.equal((await raw("/render/missing.png")).status, 404);
});

test("한글 경로도 디코드된 그대로 닿는다", async () => {
  const r = await raw("/" + encodeURIComponent("프로젝트") + "/" + encodeURIComponent("카드.svg"));
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/svg+xml");
});

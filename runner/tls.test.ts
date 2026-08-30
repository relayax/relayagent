// tls.test.ts — 자가서명 인증서를 기판이 직접 굽는다.
//
// 이 시험이 필요한 이유(2026-08-30): 종전에는 `openssl req -x509` 를 spawn 해서 구웠다. openssl 은
// macOS·리눅스에만 있고 **Windows 에는 없어서** 그 기판에서는 TLS 문이 통째로 안 섰다 — 그리고 그
// 문이 없으면 HTTPS 콜백을 요구하는 제공자(메타 계열)의 OAuth 는 영영 못 잇는다.
//
// 파싱만 확인하면 증명이 안 된다. 여기서 재는 것은 셋이다.
//  1. **진짜 악수.** 구운 인증서로 https 서버를 띄우고 `rejectUnauthorized: true` 로 붙어 성공하는가.
//     자기 자신을 루트로 검증에 통과한다는 것이 이 인증서가 쓸모 있다는 유일한 증거다.
//  2. **외부 실행 파일 0.** PATH 를 비운 채로도 구워지는가 — 의존이 실제로 사라졌음의 실측.
//  3. **낡은 인증서는 다시 굽는다.** 종전 판정은 파일 존재뿐이라 만료된 인증서를 영영 들고 있었고,
//     증상은 "인가가 안 된다" 하나여서 원인이 안 읽혔다.
//
//   node --experimental-strip-types --test runner/tls.test.ts
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import test from "node:test";

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "relay-tls-"));
process.env.HOME = ROOT;
process.env.USERPROFILE = ROOT;
process.env.RELAY_HOME = path.join(ROOT, "relay-home");
process.env.RELAY_PORT = "4759";

const { ensureLocalCert, mintSelfSigned } = await import("./tls.ts");

/** 인증서 하나로 https 문을 열고, 그 문에 붙어 본다 — 검증을 켠 채로 */
function serveOnce(cert: { key: string; cert: string }): Promise<number> {
  return new Promise((resolve) => {
    const server = https.createServer(cert, (_req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    server.unref();
  });
}

function connect(opts: tls.ConnectionOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ ...opts, rejectUnauthorized: true }, () => {
      s.end();
      resolve();
    });
    s.on("error", reject);
  });
}

test("구운 인증서가 서야 할 이름을 전부 채운다 — 문이 loopback 셋에 서기 때문이다", () => {
  const { cert } = mintSelfSigned();
  const x = new crypto.X509Certificate(cert);
  assert.ok(x.checkHost("localhost"), "localhost 를 못 채운다");
  assert.ok(x.checkIP("127.0.0.1"), "127.0.0.1 을 못 채운다");
  assert.ok(x.checkIP("::1"), "::1 을 못 채운다");
  assert.ok(new Date(x.validTo) > new Date(), "이미 만료된 인증서를 구웠다");
  // 시계가 조금 어긋나도 "아직 유효하지 않음"이 안 나야 한다
  assert.ok(new Date(x.validFrom) <= new Date(), "notBefore 가 미래다");
  assert.equal(x.subject, x.issuer, "자가서명이 아니다");
});

test("진짜 악수 — 자기 자신을 루트로 검증에 통과한다(이름으로도, IP 로도)", async () => {
  const cert = mintSelfSigned();
  const port = await serveOnce(cert);
  // ca 에 자기를 넣는다 = 사람이 이 인증서를 신뢰한 상태. rejectUnauthorized 를 끄지 않는 것이 요점이다
  await connect({ port, host: "127.0.0.1", servername: "localhost", ca: [cert.cert] });
  // servername 없이 붙으면 노드가 host 를 이름으로 쓴다 — iPAddress SAN 이 그때 걸린다
  await connect({ port, host: "127.0.0.1", ca: [cert.cert] });
});

test("신뢰하지 않으면 거절된다 — 자가서명이 마법으로 통과하지 않는다", async () => {
  const cert = mintSelfSigned();
  const port = await serveOnce(cert);
  await assert.rejects(() => connect({ port, host: "127.0.0.1", servername: "localhost" }), /self.signed|unable to verify/i);
});

test("외부 실행 파일 없이 굽는다 — PATH 가 비어도 선다(Windows 가 막혀 있던 자리)", async () => {
  const keep = process.env.PATH;
  process.env.PATH = "";
  try {
    const dir = path.join(ROOT, "nopath");
    const made = await ensureLocalCert(dir);
    assert.ok(new crypto.X509Certificate(made.cert).checkHost("localhost"));
    assert.match(made.key, /BEGIN PRIVATE KEY/);
  } finally {
    process.env.PATH = keep;
  }
});

test("쓸 수 있는 인증서는 다시 굽지 않는다 — 다시 구우면 사람이 넣어 둔 신뢰가 끊긴다", async () => {
  const dir = path.join(ROOT, "reuse");
  const first = await ensureLocalCert(dir);
  const again = await ensureLocalCert(dir);
  assert.equal(again.cert, first.cert);
  assert.equal(fs.statSync(path.join(dir, "key.pem")).mode & 0o777, 0o600, "개인키가 0600 이 아니다");
});

test("만료된 인증서는 다시 굽는다 — 파일 존재만 보면 영영 낡은 것을 들고 있다", async () => {
  const dir = path.join(ROOT, "expired");
  fs.mkdirSync(dir, { recursive: true });
  // 3년 전에 구운 것 — 유효기간 825일이라 이미 지났다
  const old = mintSelfSigned(new Date(Date.now() - 3 * 365 * 86400_000));
  fs.writeFileSync(path.join(dir, "cert.pem"), old.cert);
  fs.writeFileSync(path.join(dir, "key.pem"), old.key);
  assert.ok(new Date(new crypto.X509Certificate(old.cert).validTo) < new Date(), "픽스처가 만료되지 않았다");

  const fresh = await ensureLocalCert(dir);
  assert.notEqual(fresh.cert, old.cert, "만료된 인증서를 그대로 돌려줬다");
  assert.ok(new Date(new crypto.X509Certificate(fresh.cert).validTo) > new Date());
});

test("이름을 못 채우는 인증서도 다시 굽는다 — 남의 손이 넣어 둔 사본이 문을 조용히 죽인다", async () => {
  const dir = path.join(ROOT, "wrong-san");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "cert.pem"), "-----BEGIN CERTIFICATE-----\nbm90LWEtY2VydA==\n-----END CERTIFICATE-----\n");
  fs.writeFileSync(path.join(dir, "key.pem"), "not a key\n");
  const fresh = await ensureLocalCert(dir);
  assert.ok(new crypto.X509Certificate(fresh.cert).checkHost("localhost"));
});

// ── 문 ──────────────────────────────────────────────────────────────────────
// 여기서 재는 것은 **왜 조건 없이 여는가**이다. 종전 설계안은 "https 를 요구하는 패키지가 설치돼
// 있으면 연다"였는데, 콜백 주소가 기판에 하나뿐이라 그 판정이 패키지 설치·제거를 **관계없는
// 제공자의 등록 주소를 갈아치우는 행위**로 만들었다. 축을 둘로 나눈 것이 답이다 — 문은 조건 없이,
// 주소는 서비스 선언대로.
const { openTlsDoor, closeTlsDoor, callbackUrlFor, tlsDoor, moveTlsDoor } = await import("./tls.ts");
const { loadLedger, saveLedger, API_PORT } = await import("./supply/ledger.ts");
const noop = (_req: unknown, res: { end(): void }): void => res.end();

test("문은 조건 없이 열린다 — 선언을 훑지 않는다(설치가 남의 주소를 흔들면 안 된다)", async () => {
  const d = await openTlsDoor(noop as never);
  assert.equal(d.open, true, `문이 안 섰다: ${d.error}`);
  assert.ok(d.port && d.port !== API_PORT);
  assert.equal(loadLedger().tls?.port, d.port, "고른 포트를 장부에 안 적었다 — 다음 기동이 다른 자리에 선다");
  closeTlsDoor();
});

test("주소는 서비스 선언이 정한다 — 문이 열려도 http 서비스는 http 를 받는다", async () => {
  const d = await openTlsDoor(noop as never);
  assert.equal(d.open, true);
  // 이 한 줄이 종전 판의 버그다: 주소가 기판에 하나면 이 값도 https 가 되어, 이미 등록해 둔
  // http 콜백이 조용히 무효가 된다
  assert.match(callbackUrlFor(false) ?? "", /^http:\/\/127\.0\.0\.1:\d+\/oauth\/cb$/);
  assert.equal(callbackUrlFor(true), `https://localhost:${d.port}/oauth/cb`);
  closeTlsDoor();
});

test("문이 없으면 HTTPS 요구 서비스에는 주소를 주지 않는다 — 안 되는 주소보다 없음이 낫다", () => {
  closeTlsDoor();
  assert.equal(callbackUrlFor(true), null);
  assert.match(callbackUrlFor(false) ?? "", /^http:/, "http 서비스는 문과 무관하게 언제나 주소가 있다");
});

test("끄는 길은 명시 선택 하나 — RELAY_TLS_PORT=0", async () => {
  process.env.RELAY_TLS_PORT = "0";
  try {
    const d = await openTlsDoor(noop as never);
    assert.equal(d.open, false);
    assert.match(d.error ?? "", /RELAY_TLS_PORT=0/);
    assert.equal(callbackUrlFor(true), null);
  } finally {
    delete process.env.RELAY_TLS_PORT;
    closeTlsDoor();
  }
});

test("기록된 포트는 재기동을 건넌다 — 그 포트가 등록된 콜백 주소의 일부다", async () => {
  const first = await openTlsDoor(noop as never);
  closeTlsDoor();
  const again = await openTlsDoor(noop as never);
  assert.equal(again.port, first.port, "같은 홈인데 다른 자리에 섰다 — 등록해 둔 콜백이 깨진다");
  closeTlsDoor();
});

test("기록된 포트가 점유되면 조용히 옮기지 않는다 — 옮기면 등록해 둔 인가가 전부 깨진다", async () => {
  const taken = (loadLedger().tls?.port ?? API_PORT + 1);
  const squatter = http.createServer(() => {});
  await new Promise<void>((r) => squatter.listen(taken, "127.0.0.1", r));
  try {
    const d = await openTlsDoor(noop as never);
    assert.equal(d.open, false, "점유된 포트에 섰다고 주장한다");
    assert.match(d.error ?? "", new RegExp(`${taken} 포트`));
    assert.match(d.error ?? "", /임의로 옮기지 않습니다/);
    assert.equal(loadLedger().tls?.port, taken, "실패한 김에 기록을 갈아치웠다");
    // 옮기는 것은 사람이 부르는 행위다 — 그때만 기록이 바뀐다
    const moved = await moveTlsDoor(taken + 7, noop as never);
    assert.equal(moved.open, true, `이동에 실패했다: ${moved.error}`);
    assert.equal(loadLedger().tls?.port, taken + 7);
    assert.equal(tlsDoor().port, taken + 7);
  } finally {
    squatter.close();
    closeTlsDoor();
  }
});

test("신뢰 등록은 인증서가 있어야 시작한다 — 없는 파일로 OS 인증 창을 띄우지 않는다", async () => {
  const { trustLocalCert, canTrustLocally } = await import("./tls.ts");
  // 굽지 않은 자리를 준다 — 이 가드가 없으면 security(1) 가 없는 경로로 불려 사유가 엉뚱해진다.
  // (신뢰 등록 자체는 사람의 키체인을 바꾸는 행위라 시험이 실행하지 않는다 — 여기서 재는 것은 가드다)
  await assert.rejects(
    () => trustLocalCert(path.join(ROOT, "no-such-tls")),
    canTrustLocally() ? /구운 인증서가 없습니다/ : /신뢰시킬 길이 없습니다/,
  );
});

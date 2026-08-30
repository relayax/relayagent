// tls.ts — 데몬의 TLS 문이 쓰는 자가서명 인증서. RELAY_HOME/tls/{key,cert}.pem 에 앉고 없으면 굽는다.
//
// 존재 이유는 인가 콜백 하나다: redirect_uri 에 HTTPS 를 요구하는 제공자(메타 계열)가 있어, http 로만
// 듣는 기판은 그 계열의 OAuth 를 영영 못 잇는다. 브라우저가 자가서명을 한 번 경고하는 것은 감수한다 —
// 제공자는 주소 문자열만 대조하지 인증서를 검증하지 않는다.
//
// **굽는 것도 여기서 한다.** 종전에는 `openssl req -x509` 를 spawn 했다 — node 의 crypto 에 X.509 를
// 발급하는 API 가 없고, 의존성 0 규율이 라이브러리보다 먼저였기 때문이다. 그러나 openssl 은 macOS
// (LibreSSL)·리눅스에만 있고 **Windows 에는 없다**: 그 기판에서는 문이 통째로 안 섰다. 그래서 남은
// 조각만 직접 짓는다 — 키 생성·서명·SubjectPublicKeyInfo 는 node 가 이미 주고(generateKeyPairSync ·
// createSign · export spki), 없는 것은 TBSCertificate 의 DER 조립뿐이다. 의존성은 그대로 0 이고,
// 이제 외부 실행 파일도 0 이다.
//
// 짓는 범위는 "이 문이 서는 데 필요한 것"으로 끊는다. subjectKeyIdentifier·authorityKeyIdentifier 는
// 넣지 않는다 — TLS 검증도 macOS 신뢰도 그것을 요구하지 않고, 넣으려면 SPKI 를 되파싱해야 한다.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { API_PORT, API_URL, OAUTH_CALLBACK_PATH, RELAY_HOME, loadLedger, saveLedger } from "./supply/ledger.ts";
import { runCommand } from "./spawn.ts";

export interface LocalCert {
  key: string;
  cert: string;
}

/** 이 인증서가 서 줘야 하는 이름들 — 데몬의 TLS 문이 loopback 셋에만 서기 때문이다(daemon.ts) */
const HOST_NAME = "localhost";
const HOST_IPS: [string, Buffer][] = [
  ["127.0.0.1", Buffer.from([127, 0, 0, 1])],
  ["::1", Buffer.concat([Buffer.alloc(15), Buffer.from([1])])],
];
/** 유효기간 — openssl 판과 같은 825일(브라우저가 받아 주는 상한의 관례) */
const VALID_DAYS = 825;

// ── 최소 DER 라이터 ─────────────────────────────────────────────────────────
// 여기 있는 것은 인증서 하나를 쓰는 데 필요한 태그가 전부다. 범용 ASN.1 라이브러리가 아니다 —
// 넓히면 그 순간 검증도 못 하는 코드가 늘어난다.

const T_BOOL = 0x01, T_INT = 0x02, T_BIT = 0x03, T_OCT = 0x04, T_NULL = 0x05;
const T_OID = 0x06, T_UTF8 = 0x0c, T_IA5 = 0x16, T_UTC = 0x17, T_GEN = 0x18;
const T_SEQ = 0x30, T_SET = 0x31;

function derLen(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(T_SEQ, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(T_SET, Buffer.concat(parts));
const nul = (): Buffer => tlv(T_NULL, Buffer.alloc(0));
const bool = (v: boolean): Buffer => tlv(T_BOOL, Buffer.from([v ? 0xff : 0x00]));
const octets = (b: Buffer): Buffer => tlv(T_OCT, b);
const utf8 = (s: string): Buffer => tlv(T_UTF8, Buffer.from(s, "utf8"));
/** EXPLICIT 문맥 태그 [n] — 내용을 통째로 감싼다 */
const ctx = (n: number, body: Buffer): Buffer => tlv(0xa0 | n, body);

/** 비트열 — 인증서에서 쓰는 자리는 전부 남는 비트가 0 이거나 명시적이다 */
function bitString(content: Buffer, unused = 0): Buffer {
  return tlv(T_BIT, Buffer.concat([Buffer.from([unused]), content]));
}

/** OID — 첫 두 마디는 40*a+b 로 접히고 나머지는 base-128 가변길이 */
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [40 * parts[0] + parts[1]];
  for (const n of parts.slice(2)) {
    const stack: number[] = [];
    for (let v = n; ; v = Math.floor(v / 128)) {
      stack.unshift(v % 128);
      if (v < 128) break;
    }
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    out.push(...stack);
  }
  return tlv(T_OID, Buffer.from(out));
}

/** 양의 정수 — 최상위 비트가 서면 0x00 을 앞에 붙인다(안 그러면 음수로 읽힌다) */
function integer(bytes: Buffer): Buffer {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0 && (bytes[i + 1] & 0x80) === 0) i++;
  const body = bytes.subarray(i);
  return tlv(T_INT, body[0] & 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body);
}

/** 시각 — 2050년 전은 UTCTime(YY), 그 뒤는 GeneralizedTime(YYYY). RFC 5280 §4.1.2.5 */
function asn1Time(d: Date): Buffer {
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  const y = d.getUTCFullYear();
  const rest = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050
    ? tlv(T_UTC, Buffer.from(p(y % 100) + rest, "ascii"))
    : tlv(T_GEN, Buffer.from(p(y, 4) + rest, "ascii"));
}

// ── 인증서 ──────────────────────────────────────────────────────────────────

const OID_SHA256_RSA = "1.2.840.113549.1.1.11";
const OID_CN = "2.5.4.3";
const OID_BASIC_CONSTRAINTS = "2.5.29.19";
const OID_KEY_USAGE = "2.5.29.15";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SAN = "2.5.29.17";
const OID_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";

const sha256WithRsa = (): Buffer => seq(oid(OID_SHA256_RSA), nul());
/** CN=localhost 한 마디. 자가서명이라 issuer 와 subject 가 같은 값이다 */
const nameCN = (cn: string): Buffer => seq(set(seq(oid(OID_CN), utf8(cn))));

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function extensions(): Buffer {
  // CA:TRUE 로 둔다 — openssl req -x509 의 기본값과 같은 모양이어야 한다. 이 인증서는 자기
  // 자신의 루트로 신뢰되는 길(키체인 등록)이 있고, 여기서 모양이 갈리면 "구현만 갈았는데
  // 신뢰 동작이 달라지는" 자리가 생긴다
  const basic = extension(OID_BASIC_CONSTRAINTS, true, seq(bool(true)));
  // digitalSignature(0) · keyEncipherment(2) · keyCertSign(5) → 0b10100100, 뒤 두 비트는 안 쓴다
  const usage = extension(OID_KEY_USAGE, true, bitString(Buffer.from([0xa4]), 2));
  const eku = extension(OID_EXT_KEY_USAGE, false, seq(oid(OID_SERVER_AUTH)));
  // GeneralName 은 IMPLICIT 태그다 — dNSName [2], iPAddress [7]
  const san = extension(OID_SAN, false, seq(
    tlv(0x82, Buffer.from(HOST_NAME, "ascii")),
    ...HOST_IPS.map(([, b]) => tlv(0x87, b)),
  ));
  return seq(basic, usage, eku, san);
}

function pem(label: string, der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${b64.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * 자가서명 인증서 한 벌을 굽는다 — 외부 실행 파일 없이.
 *
 * node 가 주는 조각: 키쌍(RSA-2048, openssl 판과 같은 세기) · SubjectPublicKeyInfo 의 DER
 * (`export spki` 가 이미 그 구조다 — 키를 직접 인코딩할 필요가 없는 것이 이 구현이 짧은 이유다) ·
 * PKCS#1 v1.5 서명(`createSign("sha256")` 이 sha256WithRSAEncryption 과 같은 벌).
 */
export function mintSelfSigned(now = new Date()): LocalCert {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const subject = nameCN(HOST_NAME);
  // notBefore 를 한 시간 당긴다 — 기판과 브라우저의 시계가 조금 어긋나도 "아직 유효하지 않음"이 안 나게
  const notBefore = new Date(now.getTime() - 3600_000);
  const notAfter = new Date(now.getTime() + VALID_DAYS * 86400_000);

  const tbs = seq(
    ctx(0, integer(Buffer.from([2]))), // v3
    integer(crypto.randomBytes(16)),
    sha256WithRsa(),
    subject, // issuer = subject
    seq(asn1Time(notBefore), asn1Time(notAfter)),
    subject,
    spki,
    ctx(3, extensions()),
  );
  const sig = crypto.createSign("sha256").update(tbs).sign(privateKey);
  const cert = seq(tbs, sha256WithRsa(), bitString(sig));

  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    cert: pem("CERTIFICATE", cert),
  };
}

/**
 * 이 인증서를 계속 쓸 수 있는가 — 만료됐거나 서야 할 이름을 못 채우면 아니다.
 *
 * 종전에는 **파일 존재만** 봤다. 그러면 만료된 인증서를 영영 들고 있게 되고, 증상은 인가가
 * 실패하는 것뿐이라 원인이 안 읽힌다(제공자는 "주소 불일치"만 말한다).
 */
function usable(certPem: string, now = new Date()): boolean {
  try {
    const x = new crypto.X509Certificate(certPem);
    if (new Date(x.validTo) <= now) return false;
    if (!x.checkHost(HOST_NAME)) return false;
    return HOST_IPS.every(([ip]) => !!x.checkIP(ip));
  } catch {
    return false; // 못 읽는 인증서는 없는 것과 같다
  }
}

/**
 * 인증서 한 벌 — 쓸 수 있으면 읽고, 아니면 굽는다.
 *
 * 다시 구우면 사람이 키체인에 넣어 둔 신뢰가 끊긴다. 그래서 판정을 **쓸 수 없을 때**로만 좁힌다:
 * 있고 유효하고 이름을 채우면 그대로 쓴다.
 */
export async function ensureLocalCert(dir = path.join(RELAY_HOME, "tls")): Promise<LocalCert> {
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    const have = { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") };
    if (usable(have.cert)) return have;
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = mintSelfSigned();
  fs.writeFileSync(certFile, fresh.cert);
  fs.writeFileSync(keyFile, fresh.key, { mode: 0o600 });
  fs.chmodSync(keyFile, 0o600); // 이미 있던 파일이면 mode 옵션이 안 먹는다
  return fresh;
}

// ── 문 ──────────────────────────────────────────────────────────────────────
//
// 문은 **무조건 연다**. 종전 계획은 "https 를 요구하는 패키지가 설치돼 있으면 연다"였는데 그것은
// 조용한 파괴였다: 콜백 주소가 기판에 하나뿐이라, 패키지 하나를 설치·제거하는 행위가 **관계없는
// 제공자의 등록 주소까지** http↔https 로 갈아치웠다(등록해 둔 앱은 그대로인데 주소가 안 맞게 된다).
// 그래서 축을 둘로 나눈다 — 문은 조건 없이 열고(판정도 스위치도 없다), **주소는 서비스 선언이
// 정한다**(callbackUrlFor). 그러면 무엇을 설치하든 각 서비스의 주소가 흔들리지 않는다.
//
// 끄는 길은 명시 선택 하나뿐이다: `RELAY_TLS_PORT=0`. 그 기판은 HTTPS 콜백을 요구하는 제공자를
// 못 쓴다는 것을 받아들인 것이라 조용한 강등이 아니다.

export interface TlsDoor {
  open: boolean;
  /** 문이 선 포트. 닫혀 있으면 null */
  port: number | null;
  /** 못 연 사유 — 화면이 그대로 보여 준다. 종전에는 데몬 콘솔에만 남아 읽는 사람이 없었다 */
  error: string | null;
  /** 이 기판이 인증서 신뢰를 대신 넣어 줄 수 있는가 — 화면은 이 값으로 버튼을 **안 그린다**.
   *  못 하는 것을 눌리게 두면 사용자는 자기가 뭘 잘못했는지 묻게 된다 */
  canTrust: boolean;
}

/** 신뢰 등록은 macOS 의 security(1) 하나뿐이다 — 다른 판에는 대응물이 없어 그대로 없음이다 */
export function canTrustLocally(): boolean {
  return process.platform === "darwin";
}

let door: TlsDoor = { open: false, port: null, error: null, canTrust: canTrustLocally() };
let servers: https.Server[] = [];

export function tlsDoor(): TlsDoor {
  return { ...door };
}

/**
 * 이 서비스가 제공자 앱에 등록할 콜백 주소 — **선언이 정한다**.
 *
 * `needsHttps`(auth.oauth_client.https)인 서비스만 TLS 문의 주소를 받고, 나머지는 언제나 http 문의
 * 주소를 받는다. 문이 열리고 닫히는 것이 남의 주소를 흔들지 않는 것이 요점이다.
 * https 를 요구하는데 문이 없으면 `null` — 안 되는 주소를 주느니 "지금은 줄 수 없다"가 맞다.
 */
export function callbackUrlFor(needsHttps: boolean): string | null {
  if (!needsHttps) return `${API_URL}${OAUTH_CALLBACK_PATH}`;
  return door.open && door.port != null ? `https://localhost:${door.port}${OAUTH_CALLBACK_PATH}` : null;
}

/** 포트 정책. env 재정의 > 장부 기록 > 첫 기동(찾는다). `scan` 이면 잡히는 자리를 찾아 기록한다 */
function portPolicy(): { port: number | null; scan: boolean; off?: string } {
  const raw = process.env.RELAY_TLS_PORT;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (n === 0) return { port: null, scan: false, off: "RELAY_TLS_PORT=0 — 이 기판은 TLS 문을 열지 않습니다" };
    if (!Number.isInteger(n) || n < 1 || n > 65535 || n === API_PORT) {
      return { port: null, scan: false, off: `RELAY_TLS_PORT: 포트가 아니거나 RELAY_PORT 와 같습니다: ${raw}` };
    }
    return { port: n, scan: false };
  }
  const recorded = loadLedger().tls?.port;
  // 기록된 포트는 **고집한다** — 점유돼 있어도 조용히 옮기지 않는다. 옮기면 등록해 둔 콜백이 깨진다
  if (recorded) return { port: recorded, scan: false };
  return { port: API_PORT + 1, scan: true };
}

/** loopback 이름 하나에 문을 세운다 — 성공/실패를 그대로 돌려준다(로그로 삼키지 않는다) */
function listenOne(host: string, port: number, cert: LocalCert, handle: http.RequestListener): Promise<https.Server> {
  return new Promise((resolve, reject) => {
    const s = https.createServer(cert, handle);
    s.once("error", (e) => { try { s.close(); } catch { /* 이미 닫힘 */ } reject(e); });
    s.listen(port, host, () => resolve(s));
  });
}

/**
 * TLS 문을 연다 — 같은 라우트의 두 번째 문. 인증서 SAN 이 loopback 셋이라 그 이름에만 선다.
 *
 * IPv4 가 판정선이다. `::1` 은 최선을 다하되 실패해도 문은 열린 것으로 본다 — IPv6 가 없는 기판이
 * 실제로 있고, 거기서 문을 통째로 닫으면 콜백은 `localhost` 로 오므로(대개 127.0.0.1) 멀쩡한 길을
 * 잃는다. 종전 구현이 서버마다 error 를 로그로 삼키던 관용을 판정으로 옮긴 것이다.
 */
export async function openTlsDoor(handle: http.RequestListener): Promise<TlsDoor> {
  closeTlsDoor();
  const policy = portPolicy();
  if (policy.port == null) {
    door = { open: false, port: null, error: policy.off ?? "TLS 문이 꺼져 있습니다", canTrust: canTrustLocally() };
    return tlsDoor();
  }
  let cert: LocalCert;
  try {
    cert = await ensureLocalCert();
  } catch (e) {
    door = { open: false, port: null, error: `인증서를 굽지 못했습니다 — ${e instanceof Error ? e.message : String(e)}`, canTrust: canTrustLocally() };
    return tlsDoor();
  }
  // 처음엔 찾고, 그 뒤엔 고집한다 — 기록이 없을 때만 비는 자리를 훑는다(그때는 등록된 주소가 아직 없다)
  const tries = policy.scan ? Array.from({ length: 20 }, (_, i) => policy.port! + i) : [policy.port];
  let last: unknown = null;
  for (const port of tries) {
    try {
      const v4 = await listenOne("127.0.0.1", port, cert, handle);
      servers = [v4];
      try {
        servers.push(await listenOne("::1", port, cert, handle));
      } catch { /* IPv6 없음 — 문은 열린 것이다 */ }
      if (policy.scan) {
        const l = loadLedger();
        saveLedger({ ...l, tls: { port } });
      }
      door = { open: true, port, error: null, canTrust: canTrustLocally() };
      return tlsDoor();
    } catch (e) {
      last = e;
    }
  }
  const why = last instanceof Error ? last.message : String(last);
  door = {
    open: false,
    port: null,
    canTrust: canTrustLocally(),
    error: policy.scan
      ? `열 수 있는 포트를 못 찾았습니다 — ${why}`
      : `${policy.port} 포트를 열지 못했습니다 — ${why}. 이 포트는 등록된 콜백 주소의 일부라 기판이 임의로 옮기지 않습니다`,
  };
  return tlsDoor();
}

/** 문을 닫는다 — 포트 이동과 시험이 쓴다. 기록은 건드리지 않는다 */
export function closeTlsDoor(): void {
  for (const s of servers) { try { s.close(); } catch { /* 이미 닫힘 */ } }
  servers = [];
  door = { open: false, port: null, error: null, canTrust: canTrustLocally() };
}

/**
 * 문을 다른 포트로 옮긴다 — **등록해 둔 콜백 주소를 전부 고쳐야 하는 행위**라 사람이 부르는 것만
 * 이 문을 지난다. 기판은 스스로 옮기지 않는다(위 portPolicy 의 "고집한다").
 */
export async function moveTlsDoor(port: number, handle: http.RequestListener): Promise<TlsDoor> {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === API_PORT) {
    throw new Error(`포트가 아니거나 기판 포트와 같습니다: ${port}`);
  }
  const l = loadLedger();
  saveLedger({ ...l, tls: { port } });
  return await openTlsDoor(handle);
}

/**
 * 이 기기에서 인증서를 신뢰한다 — **사람이 누른 한 번의 행위만** 이 문을 지난다.
 *
 * 안 눌러도 인가는 성립한다: 제공자는 주소 문자열만 대조하고, 사람은 브라우저 경고에서 "계속"을
 * 누르면 된다. 이 문이 있는 이유는 그 경고 화면에서 사용자가 "내가 뭘 잘못했나" 하고 멈추는 것을
 * 없애기 위해서지, 필요해서가 아니다. 그래서 기본은 안 하는 것이고, 조용히 하는 일은 절대 없다 —
 * 남의 기기 신뢰 저장소를 묻지 않고 건드리는 것은 기판의 권한 밖이다.
 *
 * `security add-trusted-cert` 는 OS 인증 창을 띄운다(그 창이 곧 사람의 승인이다). 기본 키체인에
 * 넣는다 — 시스템 키체인은 sudo 가 필요하고, 로그인한 사람 하나면 되는 일에 그것까지 요구하지 않는다.
 */
export async function trustLocalCert(dir = path.join(RELAY_HOME, "tls")): Promise<void> {
  if (!canTrustLocally()) throw new Error(`이 기판(${process.platform})에는 인증서를 신뢰시킬 길이 없습니다 — 브라우저 경고에서 "계속"을 누르세요`);
  const certFile = path.join(dir, "cert.pem");
  if (!fs.existsSync(certFile)) throw new Error("아직 구운 인증서가 없습니다 — 문을 먼저 여세요");
  const r = await runCommand("security", ["add-trusted-cert", "-r", "trustRoot", certFile], { timeout: 120_000 });
  if (r.error) throw new Error(`security 실행 불가 — ${r.error.message}`);
  // 사용자가 인증 창을 취소하면 비0 이다 — 그것도 그대로 사유가 된다(취소는 실패가 아니라 선택이지만,
  // 화면은 "신뢰됨" 이라고 거짓말하면 안 된다)
  if (r.status !== 0) throw new Error(`신뢰 등록 실패 — ${(r.stderr || r.stdout).trim().slice(-200) || "취소되었거나 거부되었습니다"}`);
}

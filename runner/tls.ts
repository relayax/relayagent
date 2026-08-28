// tls.ts — 데몬의 TLS 문이 쓰는 자가서명 인증서. RELAY_HOME/tls/{key,cert}.pem 에 앉고 없으면 굽는다.
//
// 존재 이유는 인가 콜백 하나다: redirect_uri 에 HTTPS 를 요구하는 제공자(메타 계열)가 있어, http 로만
// 듣는 기판은 그 계열의 OAuth 를 영영 못 잇는다. 브라우저가 자가서명을 한 번 경고하는 것은 감수한다 —
// 제공자는 주소 문자열만 대조하지 인증서를 검증하지 않는다.
//
// node 는 X.509 를 굽지 못한다(crypto 에 그 API 가 없다). 의존성 0 규율이 라이브러리보다 먼저라 openssl
// 실행 파일을 부른다 — macOS(LibreSSL)·리눅스 어디에나 있다. 없으면 fail-loud: 없는 문을 연 척하지 않는다.
import fs from "node:fs";
import path from "node:path";
import { RELAY_HOME } from "./supply/ledger.ts";
import { runCommand } from "./spawn.ts";

export interface LocalCert {
  key: string;
  cert: string;
}

/** 인증서 한 벌 — 있으면 읽고, 없으면 openssl 로 굽는다. 실패는 사유(openssl 부재·stderr)를 실어 던진다 */
export async function ensureLocalCert(dir = path.join(RELAY_HOME, "tls")): Promise<LocalCert> {
  const keyFile = path.join(dir, "key.pem");
  const certFile = path.join(dir, "cert.pem");
  if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = await runCommand("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "825",
      "-keyout", keyFile, "-out", certFile,
      "-subj", "/CN=localhost",
      "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1",
    ], { timeout: 60_000 });
    if (r.error) throw new Error(`TLS 문을 열 수 없습니다 — openssl 실행 불가(${r.error.message}). openssl 을 설치하거나 RELAY_TLS_PORT 를 끄세요`);
    if (r.status !== 0) throw new Error(`TLS 문을 열 수 없습니다 — 인증서 굽기 실패: ${r.stderr.trim().slice(-300)}`);
    fs.chmodSync(keyFile, 0o600);
  }
  return { key: fs.readFileSync(keyFile, "utf8"), cert: fs.readFileSync(certFile, "utf8") };
}

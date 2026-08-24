// Ed25519 봉투 서명 — 봉인(sha256)이 "바뀌지 않았나"라면 서명은 "누가 구웠나"다.
// 사인은 봉인값 위에 앉는다(봉투 바이트를 다시 읽지 않는다 — 봉인 검증이 선행 계약).
// 개인 키는 vault(signing/ed25519, PKCS8 PEM), 공개 키는 base64(DER SPKI) 한 줄로 유통한다.
// 검증 기판은 RELAY_PUBKEYS(쉼표 구분 공개 키 목록 — 회전용 키셋)로 발행 키를 고정한다:
// 고정된 기판에서 무서명·미지 키·불일치는 fail-loud, 미고정 기판은 서명을 표시만 한다
// (feed 규율과 동일 — TLS 를 서명 대신 믿지 않는다).
import crypto from "node:crypto";

export interface EnvelopeSignature {
  alg: "ed25519";
  /** 공개 키 — base64(DER SPKI) */
  pub: string;
  /** 서명 — base64, 서명 대상은 digest 문자열("sha256:...")의 utf8 바이트 */
  sig: string;
}

export function keygen(): { privatePem: string; publicB64: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

export function signDigest(privatePem: string, digest: string): EnvelopeSignature {
  const key = crypto.createPrivateKey(privatePem);
  const pub = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).toString("base64");
  const sig = crypto.sign(null, Buffer.from(digest, "utf8"), key).toString("base64");
  return { alg: "ed25519", pub, sig };
}

export function verifyDigest(digest: string, s: EnvelopeSignature): boolean {
  if (s?.alg !== "ed25519" || !s.pub || !s.sig) return false;
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(s.pub, "base64"), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(digest, "utf8"), key, Buffer.from(s.sig, "base64"));
  } catch {
    return false;
  }
}

/** 고정된 발행 키셋 — 미설정 = null(표시 전용 축). 설정 = 서명 필수 축(fail-loud). */
export function pinnedKeys(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.RELAY_PUBKEYS;
  if (raw == null || raw.trim() === "") return null;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export const SIGNING_VAULT_KEY = "signing/ed25519";

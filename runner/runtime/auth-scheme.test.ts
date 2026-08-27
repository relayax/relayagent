// auth.scheme — Authorization 접두는 선언이 정한다(미선언 = Bearer). 이 한 단어가 갈리면 자격이
// 있어도 401 인데(Unsplash 의 Client-ID), 동사는 자격을 쥐지 않으므로 조립할 자리가 기판뿐이다.
// 판정도 함께 본다: 소비자 없는 자리(oauth·llm)의 scheme 은 통과시키지 않는다 — 통과하면
// "Client-ID 로 나간다" 가 사실이 아니라 광고가 된다.
//
//   node --experimental-strip-types --test runner/runtime/auth-scheme.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { serviceAuthHeader } from "./oauth.ts";
import { judge, ManifestError, type Manifest } from "../supply/manifest.ts";
import type { Authority } from "../authority-contract.ts";

/** 자격 하나를 아는 권위 — serviceAuthHeader 가 부르는 문은 credential 뿐이다 */
const holding = (value: string | null) => ({ credential: async () => value }) as unknown as Authority;

test("미선언 = Bearer, 선언하면 그 접두 — 같은 토큰이 접두만 바꿔 나간다", async () => {
  const a = holding("k-1");
  assert.equal(await serviceAuthHeader(a, "photos", "unsplash", { kind: "token" }), "Bearer k-1");
  assert.equal(await serviceAuthHeader(a, "photos", "unsplash", { kind: "token", scheme: "Client-ID" }), "Client-ID k-1");
  // 빈 선언은 미선언과 같다 — 접두 없는 헤더("  k-1")를 조립하지 않는다
  assert.equal(await serviceAuthHeader(a, "photos", "unsplash", { kind: "token", scheme: "  " }), "Bearer k-1");
});

test("자격이 없으면 헤더도 없다 — 접두만 붙은 빈 헤더는 없다", async () => {
  assert.equal(await serviceAuthHeader(holding(null), "photos", "unsplash", { kind: "token", scheme: "Client-ID" }), undefined);
  assert.equal(await serviceAuthHeader(holding("k-1"), "photos", "unsplash", { kind: "none" }), undefined);
});

// ── 판정 ────────────────────────────────────────────────────────────────────
const base = (): Manifest =>
  ({ schema: "relay/v1", name: "@t/photos", version: "0.1.0", display_name: "사진", description: "auth.scheme 판정 픽스처" }) as unknown as Manifest;

const issuesOf = (m: Manifest): string[] => {
  try {
    judge(m);
    return [];
  } catch (e) {
    if (e instanceof ManifestError) return e.issues;
    throw e;
  }
};

test("api 형 token 자격의 scheme 은 통과한다", () => {
  const m = { ...base(), services: [{ name: "unsplash", api: "https://api.unsplash.com", auth: { kind: "token", scheme: "Client-ID" } }] } as Manifest;
  assert.deepEqual(issuesOf(m), []);
});

test("oauth 형의 scheme 은 거부한다 — 번들의 접두는 RFC 가 정한다", () => {
  const m = { ...base(), services: [{ name: "drive", url: "https://drive.example/mcp", auth: { kind: "oauth", scheme: "Client-ID" } }] } as Manifest;
  assert.ok(issuesOf(m).some((i) => i.includes("services[drive].auth.scheme") && i.includes("token 형에서만")), issuesOf(m).join("\n"));
});

test("접두는 한 단어다 — 공백·따옴표가 든 선언은 헤더가 아니다", () => {
  const m = { ...base(), services: [{ name: "x", api: "https://x.example", auth: { kind: "token", scheme: "Client ID" } }] } as Manifest;
  assert.ok(issuesOf(m).some((i) => i.includes("services[x].auth.scheme 형식 위반")), issuesOf(m).join("\n"));
});

test("harness llm.auth 의 scheme 은 거부한다 — 그 자격은 헤더가 아니라 env 로 나간다", () => {
  const m = {
    ...base(),
    harness: { variants: [{ name: "cc", source: "harness/cc", entry: "run", llm: { provider: "anthropic", auth: { kind: "token", scheme: "Client-ID" } } }] },
  } as unknown as Manifest;
  assert.ok(issuesOf(m).some((i) => i.includes("harness.variants[cc].llm.auth.scheme") && i.includes("services[].auth 에서만")), issuesOf(m).join("\n"));
});

// auth.fields · auth.required — 서비스 자격의 입력 칸과 필수·선택. 칸 어휘는 채널 credential.fields 와
// 한 벌이고(manifest.ts judgeFields), 갈리는 축은 header 하나다. 넣는 쪽(assembleCredential)·헤더를
// 붙이는 쪽(tokenOf → serviceAuthHeader)·동사가 읽는 쪽(publicFields)이 같은 규칙을 지나는지 본다.
// 실사고(2026-08-28): 세 패키지가 token 형에 fields 를 적었고 판정은 통과했지만 그 칸을 그리는
// 화면도 읽는 러너도 없었다 — 미지 키를 삼키는 판정이 "판정 통과 · 집행 없음" 을 만들었다.
//
//   node --experimental-strip-types --test runner/runtime/auth-fields.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { judge, ManifestError, type AuthDecl, type Manifest } from "../supply/manifest.ts";
import { serviceAuthHeader } from "./oauth.ts";
import { assembleCredential, publicFields, tokenOf } from "./credential.ts";
import { attentionOf, serviceStatuses } from "./connections.ts";
import type { Authority } from "../authority-contract.ts";

const base = (): Manifest =>
  ({ schema: "relay/v1", name: "@t/photos", version: "0.1.0", display_name: "사진", description: "auth.fields 판정 픽스처" }) as unknown as Manifest;

const issuesOf = (m: Manifest): string[] => {
  try {
    judge(m);
    return [];
  } catch (e) {
    if (e instanceof ManifestError) return e.issues;
    throw e;
  }
};

const withAuth = (auth: unknown): Manifest => ({ ...base(), services: [{ name: "unsplash", api: "https://api.unsplash.com", auth }] }) as Manifest;
const KEYED: AuthDecl = {
  kind: "token",
  scheme: "Client-ID",
  required: false,
  fields: [
    { key: "access_key", label: "Access Key", header: true },
    { key: "app_id", label: "Application ID" },
    { key: "secret_key", label: "Secret Key", secret: true },
  ],
  help: { url: "https://unsplash.com/oauth/applications", note: "없어도 무료 저장소로 동작합니다" },
};

// ── 판정 ────────────────────────────────────────────────────────────────────
test("key 있는 칸들 + header 하나 + required — 통과한다", () => {
  assert.deepEqual(issuesOf(withAuth(KEYED)), []);
});

test("key 없는 칸 하나(문자열 자격)도 통과한다 — header 표시는 필요 없다", () => {
  assert.deepEqual(issuesOf(withAuth({ kind: "token", fields: [{ label: "토큰", secret: true }] })), []);
  const bad = issuesOf(withAuth({ kind: "token", fields: [{ label: "토큰", header: true }] }));
  assert.ok(bad.some((i) => i.includes("key 없는 칸 하나면 그 값이 곧 토큰")), bad.join("\n"));
});

test("key 있는 칸에 header 가 없거나 둘이면 거부 — 기판이 무엇을 헤더에 넣을지 모른다", () => {
  const none = issuesOf(withAuth({ kind: "token", fields: [{ key: "a", label: "A" }, { key: "b", label: "B" }] }));
  assert.ok(none.some((i) => i.includes("정확히 하나에 header: true") && i.includes("지금 0개")), none.join("\n"));
  const two = issuesOf(withAuth({ kind: "token", fields: [{ key: "a", label: "A", header: true }, { key: "b", label: "B", header: true }] }));
  assert.ok(two.some((i) => i.includes("지금 2개")), two.join("\n"));
});

test("칸의 note 는 거부하고 갈 곳(auth.help.note)을 말한다 — 실사고의 모양 그대로", () => {
  const r = issuesOf(withAuth({ kind: "token", fields: [{ key: "access_key", label: "Access Key", header: true, note: "검색에 쓰입니다" }] }));
  assert.ok(r.some((i) => i.includes("칸에는 note 가 없습니다") && i.includes("auth.help.note")), r.join("\n"));
});

test("auth 의 미지 키는 거부한다 — fields 는 token 형에서만, oauth 에는 인가 흐름이 있다", () => {
  const r = issuesOf(withAuth({ kind: "oauth", fields: KEYED.fields }));
  assert.ok(r.some((i) => i.includes("services[unsplash].auth.fields") && i.includes("token 형에서만")), r.join("\n"));
  const unknown = issuesOf(withAuth({ kind: "token", token_field: "x" }));
  assert.ok(unknown.some((i) => i.includes("미지 services[unsplash].auth 키(token 형): token_field")), unknown.join("\n"));
  assert.ok(issuesOf(withAuth({ kind: "none", required: false })).some((i) => i.includes("미지") && i.includes("required")));
});

test("required 는 boolean 만, 그리고 서비스 자격에서만", () => {
  const r = issuesOf(withAuth({ kind: "token", required: "yes" }));
  assert.ok(r.some((i) => i.includes("services[unsplash].auth.required: true | false")), r.join("\n"));
  const llm = {
    ...base(),
    harness: { variants: [{ name: "cc", source: "harness/cc", entry: "run", llm: { provider: "anthropic", auth: { kind: "token", required: false, fields: [{ label: "키" }] } } }] },
  } as unknown as Manifest;
  const li = issuesOf(llm);
  assert.ok(li.some((i) => i.includes("llm.auth.required") && i.includes("services[].auth 에서만")), li.join("\n"));
  assert.ok(li.some((i) => i.includes("llm.auth.fields") && i.includes("services[].auth 에서만")), li.join("\n"));
});

test("채널 칸의 header 는 거부한다 — 어댑터는 자격 전체를 받는다. 나머지 칸 판정은 서비스와 같은 한 벌", () => {
  const ch = (fields: unknown): Manifest =>
    ({ ...base(), surfaces: { channels: [{ name: "slack", source: "channels/slack", entry: "index.ts", credential: { fields } }] } }) as unknown as Manifest;
  const h = issuesOf(ch([{ key: "bot", label: "봇 토큰", header: true }]));
  assert.ok(h.some((i) => i.includes("channels[slack].credential") && i.includes("header 는 services[].auth")), h.join("\n"));
  const mixed = issuesOf(ch([{ key: "bot", label: "봇" }, { label: "생" }]));
  assert.ok(mixed.some((i) => i.includes("channels[slack].credential") && i.includes("섞을 수 없습니다")), mixed.join("\n"));
  // 채널 이름과 서비스 이름이 겹치면 vault 좌표가 충돌한다 — 그 판정은 그대로 산다
  const clash = { ...withAuth(KEYED), surfaces: { channels: [{ name: "unsplash", source: "channels/x", entry: "index.ts" }] } } as unknown as Manifest;
  assert.ok(issuesOf(clash).some((i) => i.includes("channels[unsplash]: services 와 이름 충돌")));
});

// ── 조립·헤더·노출 — 한 벌 ───────────────────────────────────────────────────
test("assemble: key 있는 칸은 JSON — header 칸과 required 칸이 비면 조립하지 않는다", () => {
  const r = assembleCredential(KEYED.fields, { access_key: " ak-1 ", app_id: "app-9" });
  assert.deepEqual(r, { ok: true, value: JSON.stringify({ access_key: "ak-1", app_id: "app-9" }) });
  assert.deepEqual(assembleCredential(KEYED.fields, { app_id: "app-9" }), { ok: false, missing: ["Access Key"] });
  const listed = assembleCredential([{ key: "tok", label: "토큰", header: true }, { key: "allow", label: "허용", list: true, required: true }], { tok: "t", allow: "a, b ,,c" });
  assert.deepEqual(listed, { ok: true, value: JSON.stringify({ tok: "t", allow: ["a", "b", "c"] }) });
});

test("assemble: 칸 미선언·key 없는 칸 하나는 token 문자열 하나", () => {
  assert.deepEqual(assembleCredential(undefined, { token: " raw " }), { ok: true, value: "raw" });
  assert.deepEqual(assembleCredential([{ label: "API 키" }], { token: "" }), { ok: false, missing: ["API 키"] });
});

const holding = (value: string | null) => ({ credential: async () => value }) as unknown as Authority;

test("헤더: JSON 자격의 header 칸만 scheme 과 함께 나간다 — 옛 문자열 자격은 헤더를 지어내지 않는다", async () => {
  const raw = JSON.stringify({ access_key: "ak-1", app_id: "app-9", secret_key: "sk" });
  assert.equal(tokenOf(KEYED, raw), "ak-1");
  assert.equal(await serviceAuthHeader(holding(raw), "photos", "unsplash", KEYED), "Client-ID ak-1");
  // 칸을 선언한 뒤 남은 옛 문자열 — 다시 연결해야 한다. 접두만 붙은 헤더는 없다
  assert.equal(await serviceAuthHeader(holding("ak-old"), "photos", "unsplash", KEYED), undefined);
  // 칸 미선언은 값 그대로
  assert.equal(await serviceAuthHeader(holding("ak-raw"), "photos", "unsplash", { kind: "token" }), "Bearer ak-raw");
});

test("동사에 나가는 칸: header 도 secret 도 아닌 것만", () => {
  const raw = JSON.stringify({ access_key: "ak-1", app_id: "app-9", secret_key: "sk" });
  assert.deepEqual(publicFields(KEYED, raw), { app_id: "app-9" });
  assert.deepEqual(publicFields(KEYED, null), {});
  assert.deepEqual(publicFields({ kind: "token" }, "raw-token"), {});
});

// ── 전경 — 필수·선택이 신경 쓸 수를 가른다 ───────────────────────────────────
test("serviceStatuses/attentionOf: required 미선언 = 필수, false 면 빈 자격이 세지지 않는다", async () => {
  const m = {
    ...base(),
    services: [
      { name: "erp", url: "https://erp.example/mcp", auth: { kind: "token" } },
      { name: "unsplash", api: "https://api.unsplash.com", auth: KEYED },
      { name: "public", api: "https://api.example.com" },
      { name: "inbox", dir: "~/inbox" },
    ],
  } as unknown as Manifest;
  const st = await serviceStatuses("photos", m, async () => null);
  assert.deepEqual(st.map((s) => [s.name, s.form, s.kind, s.required, s.hasCred]), [
    ["erp", "url", "token", true, false],
    ["unsplash", "api", "token", false, false],
    ["public", "api", "none", true, false],
  ]);
  assert.deepEqual(st[1].fields, KEYED.fields);
  assert.equal(attentionOf(st, []), 1); // erp 만 — unsplash 는 선택, public 은 자격 축 none
  const connected = await serviceStatuses("photos", m, async (k) => (k === "photos/erp" ? "t" : null));
  assert.equal(attentionOf(connected, [{ name: "slack", icon: null, running: false, pid: null, hasCred: false, lastError: null, credential: null }]), 1); // 빈 채널 하나
});

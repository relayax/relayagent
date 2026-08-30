// connections.ts — 자격 연결의 전경. 패키지 하나의 채널·서비스 상태(운영 라우트 둘이 읽는다)와
// 전 패키지 집계(연결 화면·사이드바 배지·홈 배너가 읽는다)가 한 벌이다.
//
// 채널과 서비스는 성질이 다른 두 문이라 한 목록으로 섞지 않는다 — 채널은 들어오는 문(어댑터가
// 자격을 쥐고 "연결됨" = 프로세스가 듣고 있다), 서비스는 나가는 문(기판이 자격을 쥐고 "연결됨" =
// 자격이 먹힌다). 같은 응답 안에 두 축으로 싣고, 화면이 두 섹션으로 그린다.
// 자격 값은 어느 응답에도 실리지 않는다 — hasCred 뿐이다. 칸 선언(fields)은 형태라 그대로 나간다.
import fs from "node:fs";
import path from "node:path";
import { OAUTH_CALLBACK_URL, RELAY_HOME, consoleInstall, type Ledger } from "../supply/ledger.ts";
import { loadManifest, outwardService, type CredentialDecl, type CredentialField, type Manifest } from "../supply/manifest.ts";
import { credKey } from "../vault.ts";
import { channelPid } from "./services.ts";
import { serviceOAuthStatus } from "./oauth.ts";
import { poolNames, poolVariant } from "./harness-entry.ts";
import type { HarnessVariant } from "../supply/manifest.ts";
import { listAccounts } from "./credential.ts";

/** 자격의 있음/없음만 묻는 문 — 권위 이음새(authority.credential)의 형이다 */
export type Credential = (scope: string) => Promise<string | null>;

export interface ServiceStatus {
  name: string;
  url: string;
  /** 문의 말 — url = MCP 문, api = REST 베이스. 도구 열이 빈 이유를 화면이 말할 수 있어야 한다 */
  form: "url" | "api";
  kind: "none" | "token" | "oauth";
  /** 없으면 주 기능이 서지 않는가(auth.required, 미선언 = true). 연결 화면이 "필요"와 "선택"을 가른다 */
  required: boolean;
  /** 입력 칸 형태(auth.fields) — null 이면 토큰 문자열 한 칸 */
  fields: CredentialField[] | null;
  help: { url?: string; note?: string } | null;
  client: string | null;
  /** oauth 의 선언된 공개 client_id(oauth_client.client_id) — 있으면 화면이 묻지 않는다 */
  clientId: string | null;
  /** oauth 콜백에 HTTPS 를 요구하는 제공자(oauth_client.https) */
  https: boolean;
  /** 이 기판의 인가 콜백 주소 — 등록형 앱(client: registered)의 redirect_uri 로 제공자에 적는 값. oauth 형만 */
  callback: string | null;
  /** 자격이 실리는 자리(auth.inject) — 미선언 = 헤더 */
  inject: "header" | "query" | "form";
  /** 계정 축(auth.accounts) — null 이면 축 없음. 있으면 색인의 계정들과 각각의 인가 진행(oauth 형) */
  accounts: { name: string; oauth: (ReturnType<typeof serviceOAuthStatus>) | null }[] | null;
  verifiable: boolean;
  tools: string[];
  /** 자격이 앉아 있는가 — 계정 축이 있으면 "계정이 하나라도" */
  hasCred: boolean;
  oauth: (ReturnType<typeof serviceOAuthStatus>) | null;
}

export interface ChannelStatus {
  name: string;
  icon: string | null;
  running: boolean;
  pid: number | null;
  hasCred: boolean;
  lastError: string | null;
  /** null = 선언 없음 → 화면은 원시 붙여넣기로 물러난다(제3자 어댑터) */
  credential: CredentialDecl | null;
}

/** 자격 축이 있는 서비스(url·api)의 상태 — source(몸)·dir(폴더)에는 auth 자리가 없어 빠진다 */
export async function serviceStatuses(pkg: string, m: Manifest, credential: Credential): Promise<ServiceStatus[]> {
  const out: ServiceStatus[] = [];
  for (const sv of m.services ?? []) {
    const o = outwardService(sv);
    if (!o) continue;
    const a = o.auth;
    const multi = a?.accounts === true;
    const accounts = multi
      ? (await listAccounts(credential, pkg, sv.name)).map((name) => ({ name, oauth: a?.kind === "oauth" ? serviceOAuthStatus(pkg, sv.name, name) : null }))
      : null;
    out.push({
      name: sv.name,
      url: o.base,
      form: "url" in sv ? "url" : "api",
      kind: a?.kind ?? "none",
      required: a?.required !== false,
      fields: a?.fields ?? null,
      help: a?.help ?? null,
      client: a?.client ?? null,
      clientId: a?.oauth_client?.client_id ?? null,
      https: a?.oauth_client?.https === true,
      callback: a?.kind === "oauth" ? OAUTH_CALLBACK_URL : null,
      inject: a?.inject && "query" in a.inject ? "query" : a?.inject && "form" in a.inject ? "form" : "header",
      accounts,
      verifiable: a?.verify?.url != null,
      tools: "tools" in sv ? sv.tools ?? [] : [],
      hasCred: multi ? (accounts?.length ?? 0) > 0 : (await credential(credKey(pkg, sv.name))) != null,
      oauth: a?.kind === "oauth" && !multi ? serviceOAuthStatus(pkg, sv.name) : null,
    });
  }
  return out;
}

export async function channelStatuses(pkg: string, m: Manifest, credential: Credential): Promise<ChannelStatus[]> {
  const out: ChannelStatus[] = [];
  for (const c of m.surfaces?.channels ?? []) {
    const pid = channelPid(pkg, c.name);
    out.push({
      name: c.name,
      icon: c.icon ?? null,
      running: pid != null,
      pid,
      hasCred: (await credential(credKey(pkg, c.name))) != null,
      lastError: channelLastError(pkg, c.name),
      credential: c.credential ?? null,
    });
  }
  return out;
}

/** 신경 쓸 것의 수 — 필수인데 빈 서비스 자격 + 빈 채널 자격. 선택 자격의 빔은 세지 않는다 */
export function attentionOf(services: ServiceStatus[], channels: ChannelStatus[]): number {
  return (
    services.filter((s) => s.kind !== "none" && s.required && !s.hasCred).length +
    channels.filter((c) => !c.hasCred).length
  );
}

export interface ConnectionsOverview {
  /** AI 제공사 — 패키지 소속이 아니라 최상위다(자격 좌표가 llm/<provider> 로 앱 간 공유되므로) */
  providers: ProviderStatus[];
  /** 제공사 로그인을 발화할 좌표. login 동사는 어댑터의 것이고 어댑터는 패키지 env 로 돈다 —
   *  콘솔 패키지가 풀의 어댑터를 다 후보로 가지므로 어느 제공사든 여기로 발화하면 된다 */
  consolePkg: string;
  packages: {
    pkg: string;
    label: string;
    icon: string | null;
    /** 판정 실패한 설치 — 목록에서 지우지 않고 사유를 싣는다 */
    error: string | null;
    services: ServiceStatus[];
    channels: ChannelStatus[];
  }[];
  attention: number;
}

/** 전 패키지의 자격 전경 — 사이드바 배지와 연결 화면이 같은 답을 읽는다 */
export async function connectionsOverview(ledger: Ledger, credential: Credential): Promise<ConnectionsOverview> {
  const packages: ConnectionsOverview["packages"] = [];
  let attention = 0;
  for (const [pkg, rec] of Object.entries(ledger.packages)) {
    let m: Manifest;
    try {
      m = loadManifest(rec.path);
    } catch (e) {
      packages.push({ pkg, label: pkg, icon: null, error: String(e), services: [], channels: [] });
      continue;
    }
    const services = await serviceStatuses(pkg, m, credential);
    const channels = await channelStatuses(pkg, m, credential);
    if (!services.length && !channels.length) continue;
    attention += attentionOf(services, channels);
    packages.push({
      pkg,
      label: m.display_name || pkg,
      icon: m.icon ? `/pkg/${encodeURIComponent(pkg)}/asset/${m.icon}` : null,
      error: null,
      services,
      channels,
    });
  }
  const providers = await providerStatuses(ledger, credential);
  // 연결 안 된 제공사는 "신경 쓸 것" 이다 — 하나도 없으면 어떤 앱도 대화를 못 연다. 다만
  // 하나라도 연결돼 있으면 나머지는 선택이므로 세지 않는다(배지가 상시 켜지면 무의미해진다)
  if (providers.length && !providers.some((p) => p.hasCred)) attention += 1;
  return { providers, consolePkg: consoleInstall(ledger), packages, attention };
}

// 채널 로그에서 밖으로 나갈 문자열의 비밀을 지운다 — 토큰과 사용자 절대경로. fail-loud 하되
// 자격은 외부에 노출하지 않는다는 계약(schema surfaces.channels '실패' 절)의 집행이다
function scrubSecrets(s: string): string {
  return s
    .replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "xox•-…")
    .replace(/xapp-[A-Za-z0-9-]+/gi, "xapp-…")
    .replace(/xoxe[.-][A-Za-z0-9.-]+/gi, "xoxe-…")
    .replace(/\/(Users|home)\/[^\s"']+/g, "…");
}

// 채널 상태의 '최근 오류' — channels.jsonl 을 뒤에서부터 훑어 이 채널의 가장 최근 사건을 본다.
// err(경고 제외) 또는 비정상 exit 이 최근이면 그 사연을, out/정상 exit 이 최근이면 건강(null)
export function channelLastError(pkg: string, channel: string): string | null {
  const file = path.join(RELAY_HOME, "logs", "channels.jsonl");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let j: { pkg?: string; channel?: string; err?: string; out?: string; exit?: number | null };
    try {
      j = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (j.pkg !== pkg || j.channel !== channel) continue;
    if (j.err && !/ExperimentalWarning|trace-warnings/.test(j.err)) return scrubSecrets(j.err);
    if (j.exit != null && j.exit !== 0) return `프로세스 종료 (exit ${j.exit})`;
    if (j.out || j.exit === 0) return null; // 최근 사건이 건강하면 오류 없음
  }
  return null;
}

// ── AI 제공사(하네스) 축 ────────────────────────────────────────────────────
// 연결 센터의 세 번째 축. 서비스·채널과 달리 **패키지 소속이 아니다** — 자격 좌표가
// `llm/<provider>` 라 앱을 가리지 않고 공유된다(스키마 harness.variants[].llm 절).
// 그래서 이 목록은 packages[] 안이 아니라 최상위에 선다.
//
// 목록의 출처는 기판이 아니라 **어댑터들**이다. 기판은 어떤 provider 가 있는지 모르고, 알면
// 안 된다 — 새 하네스가 들어올 때마다 기판을 고쳐야 하는 형이 되고, 그것이 하네스 중립을
// 정확히 뒤집는다. 어댑터가 자기를 말하고(info.provider·auth 선언) 기판은 그것을 모을 뿐이다.

export interface ProviderStatus {
  provider: string;
  /** 이 provider 를 대는 하네스 이름들 — 한 provider 를 여러 어댑터가 쓸 수 있다 */
  harnesses: string[];
  /** 자격형 — oauth = 도구 자신의 로그인(구독) · token = 금고에 키 · null = 선언 없음 */
  kind: "oauth" | "token" | null;
  /** 금고에 자격이 앉아 있는가. **값은 절대 싣지 않는다** */
  hasCred: boolean;
  /** 자격을 어디서 얻는지 — 화면이 링크와 안내로 보여준다 */
  help: { url?: string; note?: string } | null;
  /** provider 아이콘 주소 — 풀 어댑터면 /harness/<name>/asset/<file> */
  icon: string | null;
  /** 기판 풀이 대는 어댑터인가(아니면 어느 패키지가 동봉한 것인가) */
  origin: "pool" | "bundled";
}

/**
 * 이 기판에서 연결할 수 있는 AI 제공사 전부.
 *
 * 후보는 **풀 ∪ 설치 패키지가 동봉한 것**이다. 풀만으로도 목록이 서므로 앱을 하나도 안 깔아도
 * 화면이 빈 채로 뜨지 않는다 — 종전에는 provider 를 설치 패키지에서 역산할 수밖에 없어서,
 * 아무것도 안 깔면 아무것도 안 보이고 깔아도 한 줄만 나왔다(온보딩이 거꾸로 서 있었다).
 */
export async function providerStatuses(ledger: Ledger, credential: Credential): Promise<ProviderStatus[]> {
  const seen = new Map<string, ProviderStatus>();
  const add = (v: HarnessVariant, origin: "pool" | "bundled", assetBase: string | null): void => {
    const llm = v.llm;
    if (!llm?.provider) return; // provider 를 말하지 않는 어댑터 — 연결할 것이 없다
    const cur = seen.get(llm.provider);
    if (cur) {
      if (!cur.harnesses.includes(v.name)) cur.harnesses.push(v.name);
      // 풀이 이긴다 — 사본의 낡은 선언이 화면의 정본이 되지 않게
      if (origin === "pool" && cur.origin !== "pool") cur.origin = "pool";
      return;
    }
    seen.set(llm.provider, {
      provider: llm.provider,
      harnesses: [v.name],
      kind: llm.auth?.kind === "oauth" || llm.auth?.kind === "token" ? llm.auth.kind : null,
      hasCred: false,
      help: llm.auth?.help ?? null,
      icon: llm.icon && assetBase ? `${assetBase}/${llm.icon}` : null,
      origin,
    });
  };

  for (const name of poolNames()) {
    const v = poolVariant(name);
    if (v) add(v, "pool", `/harness/${encodeURIComponent(name)}/asset`);
  }
  for (const [pkg, rec] of Object.entries(ledger.packages)) {
    let m: Manifest;
    try {
      m = loadManifest(rec.path);
    } catch {
      continue; // 판정 실패한 설치 — 패키지 축에서 사유가 이미 선다
    }
    for (const v of m.harness?.variants ?? []) {
      if (poolNames().includes(v.name)) continue; // 풀이 정본
      add(v, "bundled", `/pkg/${encodeURIComponent(pkg)}/asset`);
    }
  }

  const out = [...seen.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  for (const p of out) p.hasCred = (await credential(`llm/${p.provider}`)) != null;
  return out;
}

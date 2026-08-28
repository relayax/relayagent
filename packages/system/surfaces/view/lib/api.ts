import type { Face } from "./faces";
import type { EdgeView, Grant, Registry } from "./types";

// 화면은 /pkg/<이름>/view/ 아래에 있지만 기판 API 는 루트에 있다. 같은 오리진이라 절대경로로 부른다
async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  // 에러 응답의 본문(need_key 등)을 버리지 않는다 — 호출부가 처방을 고르는 근거다
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `${res.status} ${path}`), { data, status: res.status });
  return data;
}

export async function fetchRegistry(): Promise<Registry> {
  const res = await fetch("/registry", { cache: "no-store" });
  if (!res.ok) throw new Error(`registry ${res.status}`);
  return res.json();
}

/**
 * 상주 한 방 — 지금 떠 있는 자식 프로세스 키(<패키지>/<이름>) 목록. 사이드바 상태점과 상주
 * 화면이 같은 응답을 본다. 패키지마다 /pkg/<이름>/channels 를 물으면 항목 수만큼 왕복이 나고,
 * 그 응답의 대부분(자격 형태·최근 오류 로그 꼬리)은 점 하나에 필요 없다.
 */
export async function fetchResidency(): Promise<string[]> {
  const res = await fetch("/residency", { cache: "no-store" });
  if (!res.ok) throw new Error(`residency ${res.status}`);
  const data = (await res.json()) as { running?: string[] };
  return data.running ?? [];
}

/** 키 목록 → 패키지 집합. 사이드바 점은 "이 패키지에 속한 키가 하나라도 있는가" 만 묻는다 */
export function residentPkgs(running: string[]): Set<string> {
  return new Set(running.map((k) => k.split("/")[0]));
}

/** 전역 셸이 그리는 것과 **같은 응답** — 얼굴 판정과 목적지는 기판이 소유한다(runtime/shell.ts).
 *  콘솔이 이걸 함께 읽어야 사이드바와 이 화면의 얼굴이 갈라지지 않는다 */
export interface ShellItem {
  pkg: string;
  label: string;
  description: string;
  version: string;
  icon: string | null;
  face: Face;
  faces: Face[];
  href: string;
  view: string | null;
  detail: string;
  resident: boolean;
  ring0: boolean;
  error: string | null;
  /** 도는 판 위에 적용하지 않은 수정이 있다 — 작업 사본이 앞서 있다 */
  editing: boolean;
  /** 선언된 사이드바 자리(shell.nav) — 판정은 parent·hidden 이 끝냈다 */
  nav: "auto" | "always" | "never";
  /** 이 패키지의 components 를 결재해 마운트하는 설치본들 — 사이드바가 이 항목을 그 밑으로 접는 근거 */
  mounted_in: string[];
  /** 접힐 자리(기판 판정). null = 최상위 */
  parent: string | null;
  /** 목록에 서지 않는다(shell.nav: never) */
  hidden: boolean;
}
export interface ShellNav {
  items: ShellItem[];
  home: string;
  importer: string;
  /** 스튜디오 시작 화면 — 만드는 중인 초안 목록 */
  studio: string;
  /** 발행 전 초안 — 장부에 없어 카드로는 서지 않는 것들 */
  drafts: { name: string; version: string | null; changes: number; href: string }[];
  /** 연결 화면 — 설치된 것 전부의 자격 전경(이 콘솔의 /connections/ 페이지). 주소는 기판이 싣는다 */
  connections: string;
  /** 신경 쓸 수 — 필수인데 빈 서비스 자격 + 빈 채널 자격 */
  attention: { credentials: number };
  /** 사람이 얹은 폴더(묶음) — 설정 화면의 묶음 카드와 사이드바가 같은 응답을 읽는다 */
  suites: Suite[];
}

export async function fetchShellNav(): Promise<ShellNav> {
  const res = await fetch("/shell/nav", { cache: "no-store" });
  if (!res.ok) throw new Error(`shell/nav ${res.status}`);
  return res.json();
}

// ── 묶음(suite) — 사이드바 폴더이자 .relaypackages 봉투의 단위. 기판 상태(runner/supply/suites.ts) ──
export interface Suite {
  name: string;
  label: string;
  members: string[];
  /** 폴더의 문 — 접힌 레일에서 이 앱의 아이콘이 폴더를 대표한다 */
  hub: string | null;
}

/** 묶음 목록. 묶음 문이 없는 기판(구 데몬)은 404 — 호출부가 그 사실을 그대로 보여 준다 */
export function fetchSuites(): Promise<{ suites: Suite[] }> {
  return getJson("/shell/suites");
}

/** 같은 이름이면 갈아 끼운다. 미설치 구성원·허브 불일치는 400 + 사유 */
export function saveSuite(s: Suite): Promise<{ suite: Suite }> {
  return post("/shell/suites", s);
}

export function removeSuite(name: string): Promise<{ removed: boolean }> {
  return post("/shell/suites/remove", { name });
}

/** 묶음 봉투 굽기 — 선반에 <이름>.relaypackages 로 앉고, href 가 받는 문이다 */
export function packSuite(name: string): Promise<{ file: string; href: string; size: number; digest: string; packages: { ref: string; version: string }[] }> {
  return post("/shell/suites/pack", { name });
}

export function short(lineage?: string | null): string {
  return (lineage ?? "").split("/").pop() ?? "";
}

export function resolveProvider(reg: Registry, ref: string): string | null {
  const bare = (ref || "").replace(/@[^/@]+$/, "");
  const hit = reg.packages.find((p) => p.name === ref || p.manifest?.name === ref || p.manifest?.name === bare);
  return hit?.name ?? null;
}

export function edgesData(reg: Registry): EdgeView[] {
  const out: EdgeView[] = [];
  for (const p of reg.packages) {
    for (const e of p.manifest?.edges ?? []) {
      const provider = resolveProvider(reg, e.provider);
      const granted = reg.grants.some(
        (g) => g.consumer === p.name && g.provider === provider && (e.mission ? g.mission === e.mission : true),
      );
      out.push({ consumer: p.name, provider, ref: e.provider, tools: e.tools, mission: e.mission, agent_access: e.agent_access, granted });
    }
  }
  return out;
}

/** 결재는 선언 캡 안에서만 통과한다. 거절 사유를 그대로 올려보낸다 */
export function approveGrant(g: Grant): Promise<{ ok: boolean }> {
  return post("/grants", g);
}


/** 설치 제거 — ring-0 동사(pkg-remove). 역의존(이 앱을 쓰는 앱)은 화면이 제거 앞에 보여 준다 */
export function removePkg(name: string): Promise<{ removed: string }> {
  return callScript("pkg-remove", { name });
}

export async function callScript<T = any>(name: string, input: unknown): Promise<T> {
  const data = await post(`/pkg/system/script/${name}`, { input });
  return (data.result ?? data) as T;
}

async function getJson<T = any>(path: string): Promise<T> {
  const res = await fetch(path, { cache: "no-store" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `${res.status} ${path}`);
  return data as T;
}

// 하네스 설정 표면 — 채팅 위젯 설정 시트와 같은 기판 API 를 그래프에서도 쓴다
export interface HarnessVariantView {
  name: string;
  provider: string | null;
  icon: string | null;
  llm_icon: string | null;
  /** probe=1 일 때만 실린다 — 어댑터를 실제 실행한 결과 */
  ready?: boolean;
  /** 미준비의 축: no-tool = 도구 없음(설치가 처방), no-auth = 자격 없음(로그인·토큰이 처방) */
  reason?: "ok" | "no-tool" | "no-auth";
  note?: string;
  account?: { email?: string | null; plan?: string | null; method?: string | null } | null;
  protocol?: number;
  capabilities?: string[];
  login?: boolean;
  auth?: string | null;
}

export function getHarness(pkg: string, probe = false): Promise<{ active: string | null; variants: HarnessVariantView[] }> {
  return getJson(`/pkg/${encodeURIComponent(pkg)}/harness${probe ? "?probe=1" : ""}`);
}

export function setHarnessActive(pkg: string, name: string): Promise<{ active: string; setup: { ok: boolean; out: string } }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/harness`, { name });
}

/** token 자격형만 웹에서 연결된다. 대화형 로그인은 터미널 처방(relay login)이 정답 */
export function connectHarness(pkg: string, token: string): Promise<{ ok: boolean; setup: { ok: boolean; out: string } }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/harness/connect`, { token });
}

export function harnessModels(pkg: string): Promise<{ ok: boolean; value: string[] }> {
  return getJson(`/pkg/${encodeURIComponent(pkg)}/harness/models`);
}

export function setModel(pkg: string, model: string | null): Promise<{ ok: boolean; model: string | null; known: boolean | null }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/model`, { model: model ?? "" });
}

/** 대화형 로그인 발화 — 기판이 터미널 창을 연다 (인증은 그 창이 소유) */
export function loginHarness(pkg: string, sw = false): Promise<{ launched: boolean; command: string; note: string }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/harness/login`, { switch: sw });
}

// 채널 운영면 — 하네스 설정과 같은 기판 API 패턴. 저작(스튜디오)이 아니라 상태·자격·재기동
/** 자격 입력 칸의 형태 — 값이 아니다. 채널 credential.fields 와 서비스 auth.fields 가 같은 어휘를 쓴다.
 *  header 는 서비스 전용(그 칸의 값이 Authorization 으로 나간다) */
export interface CredentialField {
  key?: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  list?: boolean;
  required?: boolean;
  header?: boolean;
}
export interface CredentialDecl {
  fields: CredentialField[];
  help?: { url?: string; note?: string };
}

export interface ChannelStatusView {
  name: string;
  icon: string | null;
  running: boolean;
  pid: number | null;
  hasCred: boolean;
  lastError: string | null;
  /** null = 선언 없음 → 화면은 원시 붙여넣기로 물러난다(제3자 어댑터) */
  credential: CredentialDecl | null;
}

export function channelStatus(pkg: string): Promise<{ channels: ChannelStatusView[] }> {
  return getJson(`/pkg/${encodeURIComponent(pkg)}/channels`);
}

/** 자격 저장만 — 유효 판정은 verify 소관("저장됨 ≠ 유효") */
export function connectChannel(pkg: string, channel: string, cred: string): Promise<{ ok: boolean }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/channel/${encodeURIComponent(channel)}/connect`, { cred });
}

/** 저장된 자격이 실제로 먹히는지 실왕복 한 번으로 판정 */
export function verifyChannel(pkg: string, channel: string): Promise<{ ok: boolean; note: string }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/channel/${encodeURIComponent(channel)}/verify`, {});
}

/** 채널 하나만 갈아탄다 — 새 자격 반영 */
export function restartChannel(pkg: string, channel: string): Promise<{ ok: boolean; running: boolean; note: string }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/channel/${encodeURIComponent(channel)}/restart`, {});
}

// ── 서비스 자격 — 채널 3동사의 자매. services[].url 의 auth 축(token · oauth) ────────

export interface OAuthRunView {
  running: boolean;
  done: boolean;
  ok: boolean;
  error: string | null;
  started: number;
}

export interface ServiceStatusView {
  name: string;
  url: string;
  /** 문의 말 — url = MCP 문, api = REST 베이스. 도구 열이 빈 이유가 여기에 있다 */
  form: "url" | "api";
  kind: "none" | "token" | "oauth";
  /** 없으면 주 기능이 서지 않는가(auth.required, 미선언 = true). 연결 화면이 "필요"와 "선택"을 가른다 */
  required: boolean;
  /** 입력 칸의 형태(auth.fields) — null 이면 토큰 문자열 한 칸(붙여넣기) */
  fields: CredentialField[] | null;
  /** 선언 그대로의 안내 — 발급처 링크와 한 줄 설명. 화면이 이걸로 안내를 그린다 */
  help: { url?: string; note?: string } | null;
  /** oauth 의 client 축: "registered" 면 사람이 client_id 를 공급해야 한다(DCR 불가) */
  client: string | null;
  /** auth.verify 선언 여부 — 없으면 기판이 유효를 판정할 수 없다(저장만) */
  verifiable: boolean;
  tools: string[];
  hasCred: boolean;
  oauth: OAuthRunView | null;
}

export function serviceStatus(pkg: string): Promise<{ services: ServiceStatusView[]; canDisconnect: boolean }> {
  return getJson(`/pkg/${encodeURIComponent(pkg)}/services`);
}

/** token 형 자격 저장만 — 유효 판정은 verify 소관. 칸 선언(fields)이 있으면 칸별 값을, 없으면 토큰 문자열을 보낸다 —
 *  조립은 기판이 한다(runtime/credential.ts — CLI 와 같은 한 벌). 필수 칸이 비면 400 + missing */
export function connectService(pkg: string, service: string, payload: { token?: string; fields?: Record<string, string> }): Promise<{ ok: boolean }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/service/${encodeURIComponent(service)}/connect`, payload);
}

// ── 자격 전경 — 전 패키지의 바깥 서비스·창구. 사이드바 배지와 같은 집계(/connections) ──────────

export interface ConnectionsOverview {
  packages: {
    pkg: string;
    label: string;
    icon: string | null;
    /** 판정 실패한 설치 — 목록에서 지우지 않고 사유를 싣는다 */
    error: string | null;
    services: ServiceStatusView[];
    channels: ChannelStatusView[];
  }[];
  /** 신경 쓸 수 — 필수인데 빈 서비스 자격 + 빈 채널 자격 */
  attention: number;
}

export function fetchConnections(): Promise<ConnectionsOverview> {
  return getJson("/connections");
}

/** auth.verify 선언대로 실왕복 한 번 */
export function verifyService(pkg: string, service: string): Promise<{ ok: boolean; note: string }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/service/${encodeURIComponent(service)}/verify`, {});
}

export function disconnectService(pkg: string, service: string): Promise<{ ok: boolean }> {
  return post(`/pkg/${encodeURIComponent(pkg)}/service/${encodeURIComponent(service)}/disconnect`, {});
}

/** 인가 흐름을 연다 — 브라우저는 데몬이 띄운다. 즉시 돌아오고 진행은 폴링으로 본다 */
export function startServiceOAuth(pkg: string, service: string, clientId?: string): Promise<OAuthRunView> {
  return post(`/pkg/${encodeURIComponent(pkg)}/service/${encodeURIComponent(service)}/oauth`, clientId ? { client_id: clientId } : {});
}

export function serviceOAuthStatus(pkg: string, service: string): Promise<OAuthRunView> {
  return getJson(`/pkg/${encodeURIComponent(pkg)}/service/${encodeURIComponent(service)}/oauth/status`);
}

// 마켓 화면은 OSS 콘솔에서 걷어냈다 (스토어 UI 는 데스크탑 앱의 몫).
// 설치 2단 관문의 데몬 API(/install/prepare · /install/activate)는 프로토콜로 살아 있다.

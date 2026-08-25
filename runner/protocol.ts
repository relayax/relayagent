// protocol.ts — 클라이언트 계약(docs/client-protocol.md §8)으로 승격된 문자열 어휘의 서버 정본.
// 여기 있는 문법을 runner 다른 파일에서 리터럴로 재정의하면 안 된다 — 생산·집행이 같은
// 상수를 봐야 drift 게이트가 지킬 수 있다(rg 게이트: 직접 정의는 이 모듈 안에서만).
// 클라이언트 쪽 재타이핑 소비분(core.js·widget.js)은 Phase 2 클린 브레이크에서 은퇴한다.

// ── a2a 위임 마커 (client-protocol.md §8-39) ─────────────────────────────────
// 위임 프롬프트의 첫 줄. 수신 대화의 화면이 이 마커를 발신자 카드로 렌더한다.
// ` ← <consumer>` 는 옵셔널 — consumer 미상 위임은 `[미션 수신: <mission>]` 형이다.
// 마커는 이력 원문(프롬프트 원장)에 살아야 하므로 구조 필드가 아니라 문자열로 고정한다.

/** 위임 마커 한 줄을 만든다. 호출부가 `마커 + "\n" + payload` 로 프롬프트를 조립한다. */
export function a2aMissionMarker(mission: string, consumer?: string | null): string {
  return `[미션 수신: ${mission}${consumer ? ` ← ${consumer}` : ""}]`;
}

// ── 업로드 착지 접두 (client-protocol.md §8-40) ──────────────────────────────
// stage 아래 사용자 인바운드 무대의 디렉토리명이자, 업로드 응답 path 의 접두.
// 클라이언트에게 path 는 불투명 참조다(§5.4-25) — 이 접두는 기판 내부 어휘로,
// 아웃바운드 파일 스캔의 인바운드 제외(session.ts)와 업로드 응답 조립(api.ts)이 소비한다.

export const UPLOADS_DIR = "uploads";
export const UPLOADS_PREFIX: string = UPLOADS_DIR + "/";

// ── 툴 이름 문법 (client-protocol.md §8-41) ─────────────────────────────────
// 세 접두(a2a/edge/mcp)와 `__` 구분자는 계약 상수다. 클라이언트는 표시 목적의 분해만
// 허용되고 이름 조립·권한 추론은 금지 — 집행 판정의 정본은 서버 스코프 게이트다.
// mcp 접두는 하네스 어댑터가 서버명 그대로 세운다(harness-protocol.md mcpServers 조항) —
// runner 는 생산하지 않지만 어휘의 정본은 여기 산다.

export const TOOL_SEP = "__";
export const A2A_TOOL_PREFIX: string = "a2a" + TOOL_SEP;
export const EDGE_TOOL_PREFIX: string = "edge" + TOOL_SEP;
export const DIR_TOOL_PREFIX: string = "dir" + TOOL_SEP;
export const MCP_TOOL_PREFIX: string = "mcp" + TOOL_SEP;

/** 툴 이름 세그먼트로 설 수 없는 문자를 `_` 로 접는다 — 미션 이름의 세그먼트화와
 *  집행 시 역대조가 같은 규칙을 봐야 한다(생산과 집행의 왕복 일치). */
export function sanitizeToolSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** a2a 위임 도구 이름: `a2a__<provider>__<mission(세그먼트화)>`. */
export function a2aToolName(provider: string, mission: string): string {
  return A2A_TOOL_PREFIX + provider + TOOL_SEP + sanitizeToolSegment(mission);
}

/** edge 소비 도구 이름: `edge__<provider>__<tool>` (tool 은 이미 동사 이름 문법). */
export function edgeToolName(provider: string, tool: string): string {
  return EDGE_TOOL_PREFIX + provider + TOOL_SEP + tool;
}

/** dir 문 도구 이름: `dir__<서비스>__<연산>` — 폴더 하나가 연산 수만큼 도구로 선다.
 *  연산 어휘의 정본은 runtime/dirs.ts(DIR_OPS)이고 여기는 이름 조립만 안다. */
export function dirToolName(service: string, op: string): string {
  return DIR_TOOL_PREFIX + service + TOOL_SEP + op;
}

// 집행 쪽 파서 — provider 는 패키지 이름 문법([a-z0-9-])만 허용, rest 는 세그먼트화된
// 미션/동사 이름. 생산 함수와 같은 문법의 역방향이어야 한다.
const A2A_TOOL_RE = /^a2a__([a-z0-9-]+)__(.+)$/;
const EDGE_TOOL_RE = /^edge__([a-z0-9-]+)__(.+)$/;
// 서비스 이름은 slug 문법, 연산은 소문자 낱말 하나 — 생산(dirToolName)의 역방향이다
const DIR_TOOL_RE = /^dir__([a-z0-9][a-z0-9-]*)__([a-z]+)$/;

/** `a2a__<provider>__<rest>` 분해 — 아니면 null. */
export function parseA2aToolName(name: string): { provider: string; rest: string } | null {
  const m = name.match(A2A_TOOL_RE);
  return m ? { provider: m[1], rest: m[2] } : null;
}

/** `edge__<provider>__<tool>` 분해 — 아니면 null. */
export function parseEdgeToolName(name: string): { provider: string; tool: string } | null {
  const m = name.match(EDGE_TOOL_RE);
  return m ? { provider: m[1], tool: m[2] } : null;
}

/** `dir__<서비스>__<연산>` 분해 — 아니면 null. */
export function parseDirToolName(name: string): { service: string; op: string } | null {
  const m = name.match(DIR_TOOL_RE);
  return m ? { service: m[1], op: m[2] } : null;
}

// ── 세션 slot 문법 (client-protocol.md §5.3-22) ──────────────────────────────
// 세션 id 는 계약상 기판 발급 불투명 문자열 — 이 정규식은 기판 내부의 발급·수용 판정
// 정본이다. 클라이언트 쪽 검증·발급(widget.js SLOT_OK)은 Phase 2 에서 은퇴한다.

export const SLOT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

// ── 작업 대상 param 축 (client-protocol.md §5.3-21) ──────────────────────────
// org param 축의 쌍둥이 — chat/ routematch.ts SLUG_LIST 와 동형. slug 목록
// ([a-z0-9-] csv)일 때만 목록으로 해석하고, 그 밖의 임의 스레드 키는 쉼표를 품어도
// 통짜 대상 하나다(org "param = 임의 스레드 키" 계약 보존).

export const PARAM_SLUGS_RE = /^[a-z0-9-]+(,[a-z0-9-]+)*$/i;

/** param → 작업 대상 목록. routematch.ts paramTargets 쌍둥이 — 규칙을 바꾸면 동반 점검. */
export function paramTargets(param: string): string[] {
  if (!param) return [];
  return PARAM_SLUGS_RE.test(param) ? param.split(",") : [param];
}

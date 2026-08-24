// routematch.ts — 대화 슬롯의 다중세션 스레드 문법 (순수 함수·의존성 0).
// ⚠ 쌍둥이 계약: control parseAgentSlot 과 동형 — 규칙을 바꾸면 동반 점검.
// (구 Swift AgentSlot.conversationId 쌍둥이는 2026-07-21 Mac 앱 은퇴로 소멸.)
// (구 manifest route 매칭 — matchPath/slotForRoute — 는 2026-07-13 은퇴: 라우트→에이전트
//  매핑의 SoT 가 뷰 소스의 AgentScope 로 이동해 경로 매칭 자체가 사라졌다.)

// ── 다중세션 스레드 문법 (agent-package-layout.md §4 다중세션) ────────────────
// "새 대화" sibling: main 패밀리 = "c-<id16>"(구 SideChatPanel 계약), 도킹 패밀리 =
// param 축에 `~<id8>` 부가 — "agent-<name>:<param>~<id8>", param 이 없으면
// "agent-<name>:~<id8>". `~` 는 반드시 첫 `:` 뒤(param 자리)에 온다 — 서버 parseAgentSlot
// (첫 `:` split)이 에이전트 이름을 그대로 해석하고 param(=thread 키)만 달라져, 서버 무변경으로
// sibling 이 독립 세션이 된다.

/** 슬롯의 스레드 패밀리(헤더 대화 목록이 한 묶음으로 노출하는 단위). main 패밀리는 "main" 으로
 *  수렴("chat-<id>" 레거시 기본 슬롯·"c-<id>" sibling 포함), 도킹 슬롯은 sibling 접미사를 떼고
 *  무param sibling("agent-x:~id")의 잔여 trailing ":" 도 정규화해 seed("agent-x")로 수렴시킨다. */
export function threadFamily(conv: string): string {
  if (!conv || conv === "main" || conv.startsWith("chat-") || conv.startsWith("c-")) return "main";
  if (conv.startsWith("agent-")) {
    const i = conv.indexOf("~");
    const base = i >= 0 ? conv.slice(0, i) : conv;
    return base.endsWith(":") ? base.slice(0, -1) : base;
  }
  return conv;
}

function randHex(n: number): string {
  const bytes = new Uint8Array(Math.ceil(n / 2));
  if (typeof crypto !== "undefined" && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, n);
}

/** 현재 슬롯의 패밀리에서 새 sibling 스레드 슬롯을 민팅한다("새 대화" 버튼).
 *  도킹 패밀리는 `~` 가 param 자리(첫 `:` 뒤)에 오도록 무param 이면 `:` 를 먼저 연다. */
export function siblingThread(conv: string): string {
  const family = threadFamily(conv);
  if (family === "main") return "c-" + randHex(16);
  return family + (family.includes(":") ? "~" : ":~") + randHex(8);
}

// ── 작업 대상 목록 (param 축) ────────────────────────────────────────────────
// param 은 서버에서 권한 축이 아니라 **프롬프트 한 줄**이다(runtime/turn/claudedir.go writePersona
// — "현재 작업 대상"). 도구 게이트는 에이전트 이름이, 파일 접근은 인스턴스 워크스페이스가 쥐므로,
// param 에 대상을 여럿 실어도 서버·스키마는 무변경이다(parseAgentSlot 은 첫 `:` 뒤 전부를 param 으로
// 가져간다). 그래서 "agent-builder 가 task 와 calendar 를 한 대화에서" = `agent-builder:task,calendar`.
// 구분자가 `,` 인 이유: `+` 는 쿼리스트링에서 공백으로 디코드되는 함정이 있어 raw 조립 경로가
// 하나만 생겨도 무음으로 깨진다.
const SLUG_LIST = /^[a-z0-9-]+(,[a-z0-9-]+)*$/i;

/** param → 작업 대상 목록. 워크벤치 slug 축([a-z0-9-])일 때만 목록으로 해석하고, 그 밖의 임의
 *  param(문서상 "임의 스레드 키")은 쉼표를 품고 있어도 통째로 대상 하나로 둔다. */
export function paramTargets(param: string): string[] {
  if (!param) return [];
  return SLUG_LIST.test(param) ? param.split(",") : [param];
}

/** 대화 좌표들에서 한 에이전트의 작업 대상 후보를 모은다 — 지금은 "내가 대화한 적 있는 워크벤치"가
 *  유일한 열거원이다(위젯이 부를 수 있는 메서드에 패키지 열거가 없다: transport 화이트리스트).
 *  exclude(현재 대상)는 빼고, 최근순(입력 순서)을 보존한 중복 없는 목록을 준다. */
export function targetCandidates(convs: string[], agent: string, exclude: string[] = []): string[] {
  if (!agent) return [];
  const out: string[] = [];
  for (const conv of convs) {
    const b = displayBinding(conv);
    if (b.agent !== agent) continue;
    for (const t of paramTargets(b.param)) {
      if (t && !exclude.includes(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

/** 에이전트 + 작업 대상 목록 → 슬롯. 중복·빈 값은 접고, 목록이 비면 param 없는 seed 를 만든다. */
export function withTargets(agent: string, targets: string[]): string {
  const uniq = targets.filter((t, i) => t && targets.indexOf(t) === i);
  return "agent-" + agent + (uniq.length ? ":" + uniq.join(",") : "");
}

/** 슬롯 → 표시용 바인딩 해석(control parseAgentSlot 쌍둥이 + sibling 인지).
 *  main 패밀리는 { agent: "" }, 도킹은 { agent, param(=sibling 접미사 제외 seed) }. */
export function displayBinding(conv: string): { agent: string; param: string; sibling: boolean } {
  const family = threadFamily(conv);
  const sibling = family !== conv;
  if (!family.startsWith("agent-")) return { agent: "", param: "", sibling };
  const body = family.slice("agent-".length);
  const i = body.indexOf(":");
  return i >= 0
    ? { agent: body.slice(0, i), param: body.slice(i + 1), sibling }
    : { agent: body, param: "", sibling };
}

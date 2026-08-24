/*!
 * bridge.tsx — 뷰-채팅 인페이지 브리지의 **뷰 발신 표면** (정본: docs/view-bridge.md).
 *
 * 뷰(패키지 화면)가 같은 문서의 크롬·위젯과 말하는 유일한 표면이다. 전달은 전부 wire
 * (CustomEvent)로 간다: 뷰 번들(npm @relay/relayjs)과 위젯 번들(/assets/chat-app.js)은
 * 별개 산출물이라(view-bridge §1-4 스큐) 모듈 공유가 성립하지 않고, wire 가 곧 경계다.
 * ⚠ 이 파일을 src/chat/(위젯 번들)에서 임포트하지 마라 — 바인딩 스택 싱글턴이 번들마다
 * 한 벌씩 두 벌이 된다. 크롬(main.tsx autoFloat)은 이벤트 리스너로만 수신한다.
 *
 *  - openChat(§4-7) — relay:chat-open 발신: 패널 열기 + prefill/send 주입 + 대상 전환.
 *    prefill/send 의 크롬→위젯 구간(재시도-until-ack, §4-10)은 크롬 소유 — 뷰는 모른다.
 *  - AgentScope / useAgentBinding(§5) — 페이지 정체성 선언. 활성 판정은 max(id)(§5-15:
 *    중첩=안쪽 승, 형제=후승), 변화마다 relay:scope 를 발신한다(§5-16).
 *  - setScene(§6) — relay:scene 발신: latest-wins 화면 맥락. 위젯 발화의 scene 서문이 된다.
 *
 * 슬롯 문자열("main" | "agent-<name>[:<param>]")의 조립은 이 파일의 slotFor 단일 지점이다
 * (§2-5) — 앱 코드에 노출 금지, openChat 의 conversation 에는 useAgentBinding().conversation
 * 등 바인딩 층이 준 값만 싣는다.
 *
 * SSR(Next static export 프리렌더) 안전: window 접근은 전부 dispatch·effect 안에서만.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export interface AgentBinding {
  /** relay.yaml agents: 목록의 에이전트 이름. */
  agent: string;
  /** 스레드 키 — (agent, param) 이 같으면 같은 스레드(서버 SoT). */
  param?: string;
  /** 이 에이전트가 다룰 수 있는 작업 대상 전체(선택) — 채팅 "대상 추가" 후보를 채운다.
   *  서버에는 param 후보의 일반해가 없으므로(param 은 임의 스레드 키) 아는 쪽이 선언하는
   *  것이 정본이다(view-bridge §5-18). 슬롯 문자열에는 들어가지 않는다. */
  targets?: string[];
}

/** 슬롯 문자열 조립 — 유일한 조립 지점(view-bridge §2-5). 문법 정본은 chat/routematch.ts.
 *  export 는 **크롬 전용**이다(relayos ChatPanel 의 고정 바인딩 등 — 바인딩 층의 단일 구현을
 *  크롬이 소비한다). 앱 코드는 이걸 부르지 않는다 — 앱의 슬롯 원천은 useAgentBinding() 뿐.
 *  npm 루트(index.js)에 재수출하지 않는 이유다. */
export function slotFor(binding: AgentBinding | null | undefined): string {
  if (!binding || !binding.agent) return "main";
  return "agent-" + binding.agent + (binding.param ? ":" + binding.param : "");
}

/** wire 발신 공통 — 미배선 환경(크롬 없음)은 무시한다: 브리지는 UX 어포던스이지 데이터
 *  경로가 아니다(view-bridge §4-7). */
function dispatch(name: string, detail: unknown): void {
  if (typeof window === "undefined") return;
  try { window.dispatchEvent(new CustomEvent(name, { detail })); } catch { /* 미배선 — 무시 */ }
}

export interface OpenChatOptions {
  /** 컴포저 프리필 — 사용자가 검토 후 전송. */
  prefill?: string;
  /** 자동 전송 — 컴포저 submit 과 같은 큐 의미론(턴 실행 중=큐잉, view-bridge §4-13). */
  send?: string;
  /** 대상 대화 슬롯 — 바인딩 층이 준 값만(useAgentBinding().conversation 등). 조립 금지. */
  conversation?: string;
  /** 대상 인스턴스 id. 생략 시 크롬 자신의 좌표로 해석된다(view-bridge §4-8). */
  instance?: string;
}

/** 채팅 독 제어(공개 API) — 패널을 열고 위젯에 중계한다. 착지점은 크롬의 relay:chat-open
 *  리스너(OSS: chat/main.tsx autoFloat · relayos: agent.tsx ChatChrome). */
export function openChat(opts: OpenChatOptions = {}): void {
  dispatch("relay:chat-open", opts);
}

/** 화면 맥락 스냅샷(latest-wins) — 위젯의 이후 발화가 turn.send 의 scene 서문으로 싣는다
 *  (view-bridge §6 · client-protocol §5.1-12). null = 해제. 화면 상태가 바뀔 때마다
 *  밀어 둔다 — 발화 시점에 뷰를 기다리지 않는 push 모델이다. */
export function setScene(scene: string | null): void {
  dispatch("relay:scene", { scene });
}

// ── 바인딩 스택 — 활성 판정은 max(id) (view-bridge §5-15) ────────────────────
// effect 는 자식→부모(bottom-up)로 발화하므로 "배열 끝=활성"으로 잡으면 중첩에서 바깥이
// 이겨 스펙(안쪽 승)과 반대가 된다. id 는 렌더 단계(top-down: 부모<자식, 형제는 후마운트가
// 더 큼)에 배정되므로 max(id)가 '안쪽 승 + 형제 후승' 둘 다 만족한다. upsert 는 제자리
// 교체 — param 리바인딩이 id(=우선순위)를 바꾸지 않아야 하기 때문.
type StackEntry = AgentBinding & { id: number };

let scopeSeq = 0;
const stack: StackEntry[] = [];
const bindingListeners = new Set<() => void>();
/** relay:scope 발신 dedupe — 같은 선언의 재발화는 없다(§5-17: 크롬 push 가 사용자의 탭
 *  선택을 빼앗지 않는 근거의 절반. 나머지 절반은 크롬 쪽 dedupe). */
let lastScopeKey: string | null = null;

function activeEntry(): StackEntry | null {
  let top: StackEntry | null = null;
  for (const e of stack) if (!top || e.id > top.id) top = e;
  return top;
}

function broadcast(): void {
  const top = activeEntry();
  const conversation = top ? slotFor(top) : null;
  const targets = top?.targets && top.targets.length ? top.targets : undefined;
  const key = JSON.stringify([conversation, targets ?? null]);
  if (key === lastScopeKey) return;
  lastScopeKey = key;
  for (const fn of [...bindingListeners]) { try { fn(); } catch { /* 구독자 오류 격리 */ } }
  // 선언의 wire(view-bridge §5-16) — conversation: null = 선언 부재(전부 언마운트).
  dispatch("relay:scope", { conversation, ...(targets ? { targets } : {}) });
}

// 부팅 레이스 봉합(view-bridge §5-16-a) — 크롬(위젯 번들, async 로드)이 늦게 떠도 현재
// 선언을 받아 간다. dedupe 를 리셋하고 재방송한다: 내용이 같아도 요청자에게는 첫 수신이다.
// 모듈 로드 1회 등록 — 바인딩 층이 없는 문서(브리지 미임포트)는 이 응답자 자체가 없어
// 크롬이 기본 상태(선언 없음)로 남는다.
if (typeof window !== "undefined") {
  window.addEventListener("relay:scope-request", () => {
    lastScopeKey = null;
    broadcast();
  });
}

function upsertScope(id: number, binding: AgentBinding): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i < 0) stack.push({ id, ...binding });
  else stack[i] = { id, ...binding };
  broadcast();
}

function removeScope(id: number): void {
  const i = stack.findIndex((e) => e.id === id);
  if (i < 0) return;
  stack.splice(i, 1);
  broadcast();
}

export interface AgentScopeProps {
  /** relay.yaml agents: 의 에이전트 이름. "" 이면 등록하지 않는다(조건부 바인딩 관용형). */
  agent: string;
  /** 스레드 키 — 임의 값(라우트 파라미터일 필요 없음). number 는 문자열화된다. */
  param?: string | number;
  /** 이 에이전트가 다룰 수 있는 작업 대상 전체(선택) — 채팅 "대상 추가" 후보. */
  targets?: string[];
  children?: ReactNode;
}

/** 서브트리의 활성 에이전트 선언 — 등록만 하는 투명 래퍼(DOM 추가 없음). 마운트=리바인딩,
 *  언마운트=바깥 복귀. 크롬으로의 전달은 relay:scope wire — context 가 아니다(§5-16:
 *  뷰 번들과 위젯 번들은 분리라 context 가 못 건넌다). */
export function AgentScope({ agent, param, targets, children }: AgentScopeProps) {
  const idRef = useRef(0);
  if (idRef.current === 0) idRef.current = ++scopeSeq;
  const paramStr = param == null ? undefined : String(param);
  // 배열 아이덴티티로 effect 가 매 렌더 재발화하지 않게 내용으로 비교(부모가 인라인 배열을 준다).
  const targetsKey = targets && targets.length ? targets.join(",") : "";
  useEffect(() => {
    if (!agent) {
      removeScope(idRef.current);
      return;
    }
    upsertScope(idRef.current, {
      agent,
      ...(paramStr ? { param: paramStr } : {}),
      ...(targetsKey ? { targets: targetsKey.split(",") } : {}),
    });
  }, [agent, paramStr, targetsKey]);
  useEffect(() => {
    const id = idRef.current;
    return () => removeScope(id);
  }, []);
  return <>{children}</>;
}

/** 현재 활성 바인딩 + 그 슬롯 문자열(읽기 전용 — 앱이 조립할 일 없음). */
export function useAgentBinding(): { agent?: string; param?: string; conversation: string } {
  const [, force] = useState(0);
  useEffect(() => {
    const fn = () => force((n) => n + 1);
    bindingListeners.add(fn);
    return () => { bindingListeners.delete(fn); };
  }, []);
  const active = activeEntry();
  return {
    ...(active ? { agent: active.agent } : {}),
    ...(active?.param ? { param: active.param } : {}),
    conversation: slotFor(active),
  };
}

/*!
 * ctx.tsx — 영역을 가로지르는 컨텍스트·훅: 위젯 ctx(RelayCtxContext/useRelayCtx), 활성 pane 게이트,
 * 탭 셸이 내려주는 대화 열기·대상 고치기 훅(OpenConversationCtx·PaneTargetCtx), 로그아웃 감시.
 */
import { createContext, useContext, useEffect, useMemo } from "react";
import type { RelayCtx } from "./runtime";
import { getCtx } from "./runtime";
import { installAuthWatch } from "../auth-sync";

// ── 위젯 컨텍스트 — 전역 getCtx() 직결 해체 (컴포넌트화 1단계) ────────────────
// RelayChat.mount(el, {instanceId, conversation, …})가 위젯 인스턴스별 ctx 를 내려보내고,
// 슬롯 전환(setConversation·대화 메뉴 onSwitch)도 여기(convId) 반영된다. Provider 는 ChatThread 가 세우며
// 컴포저·셀렉터·질문 카드는 전역 대신 이걸 읽는다 — 턴 귀속·히스토리·오버라이드의 대화 축이
// 항상 화면에 보이는 스레드와 일치한다(브리지 표면에선 값이 기존 getCtx()와 동일).
export const RelayCtxContext = createContext<RelayCtx | null>(null);
export function useRelayCtx(): RelayCtx {
  const c = useContext(RelayCtxContext);
  return useMemo(() => c ?? getCtx(), [c]);
}

// 이 pane 이 "활성 탭"인가 — 탭 셸(ChatTabs)이 keep-alive 로 여러 pane 을 함께 마운트할 때,
// 프리필/자동전송(postMessage 브로드캐스트·모듈 싱글턴)을 활성 pane 하나만 소비하게 게이팅한다.
// 단일 마운트(전용 /chat 문서·비탭)는 항상 true. (탭 없으면 항상 활성.)
export const ActivePaneCtx = createContext<boolean>(true);

// ── 로그아웃 크로스뷰 동기화 ─────────────────────────────────────────────────
// 규약·구현은 @relay/chat auth-sync.ts 단일 소스(뷰 크롬 AuthWatch 와 공유 — 구 쌍둥이 수렴).

// 다중 pane 이 함께 떠도 감시는 1벌 — refcount 싱글턴.
let authWatchRefs = 0;
let authWatchCleanup: (() => void) | null = null;
export function useAuthWatch(): void {
  useEffect(() => {
    if (authWatchRefs++ === 0) authWatchCleanup = installAuthWatch();
    return () => { if (--authWatchRefs === 0) { authWatchCleanup?.(); authWatchCleanup = null; } };
  }, []);
}

/** 탭 셸이 제공하는 "이 대화를 새 탭으로 열기" 훅 — pane 내부 전환(onSwitch)은 탭 strip 과
 *  desync 되므로(탭 key/제목이 옛 대화에 고정), 셸이 있으면 이 경로가 우선한다. */
export const OpenConversationCtx = createContext<((conv: string) => void) | null>(null);

/** 탭 셸이 제공하는 "이 대화의 대상(칩)을 고친다" 훅 — 칩은 대화 id 의 파생이라 대상을 바꾸려면
 *  좌표를 바꿔야 한다. 잘못 열린 대화는 대개 **아직 빈 대화**이므로 그때는 제자리에서 좌표만
 *  갈아끼워 무손실로 고치고(inPlace), 이미 오간 말이 있으면 그 좌표의 대화로 이동한다.
 *  getPageSlot = 지금 보고 있는 페이지의 슬롯(피커의 "지금 페이지에 맞추기" 항목). */
export type PaneTarget = {
  getPageSlot: () => { instanceId: string; conversationId: string } | null;
  /** 페이지가 선언한 작업 대상 전체(<AgentScope targets>) — 아직 대화한 적 없는 워크벤치도
   *  "대상 추가" 후보로 뜨게 한다(대화 이력 열거의 사각을 메운다). */
  getPageTargets: () => string[];
  retarget: (conversationId: string, inPlace: boolean) => void;
  /** 다른 인스턴스로 — 워크스페이스·도구·자격이 통째로 다른 곳이라 제자리 교체가 성립하지 않는다.
   *  **항상 새 탭**이다(retarget 은 같은 인스턴스 안에서만 좌표를 바꾼다). */
  openInstance: (instanceId: string) => void;
};
export const PaneTargetCtx = createContext<PaneTarget | null>(null);

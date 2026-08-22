/*!
 * main.tsx — relay-chat entry(ESM 번들 — export mount/mountTabs, 계획 §4-e). 세 진입 경로:
 *   ① 자동 마운트(전용 문서): #relay-desk / #relay-chat 이 있으면 그대로 렌더 — 그 문서는
 *      기판이 컨텍스트 주입과 함께 서빙한다.
 *   ② mount API: import { mount } from "/assets/chat-app.js" 또는 window.RelayChat.mount(el,
 *      {instanceId, conversation, title}) — 임의 div 에 도킹(컴포넌트화 1단계).
 *   ③ 자동 마운트(패키지 view 임베드 — README §2 "스크립트 한 줄"): 기판 자산(/assets)으로
 *      로드됐고 호스트 div 가 없으면 우측하단 부유 위젯. 아래 autoFloat 의 게이트·좌표 규약 참조.
 *
 * 좌표 규약(client-protocol §2-6) — base/root 는 location 에서 조립하지 않는다. 기판 마운트를
 * 아는 쪽이 주입한다:
 *   · 서빙 HTML 주입 — 기판이 view/채팅 HTML 에 window.__RELAY_CONTEXT = {base, root,
 *     instanceId, conversationId?, baseFor?, viewFor?} 를 번들 로드 전에 심는다.
 *   · 문서 데이터 속성 — 임베더가 아무 요소에 data-relay-base(·data-relay-root·
 *     data-relay-instance)를 선언한다.
 * 해석은 runtime.injectedCoords 단일 지점 — 둘 다 없으면 자동 마운트는 포기하고 판정을
 * 콘솔에 남긴다(fail-loud). 마운트 문법(/pkg/·/i/) 추측·조립 금지.
 *
 * An error boundary + global handlers render any mount/runtime error ON SCREEN (instead of a blank
 * iframe) — opaque-origin iframes swallow console errors, so this is how we diagnose the field.
 */
import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { ChatApp } from "./Chat";
import { Desk } from "./Desk";
import { ChatTabs, type OpenReq } from "./ChatTabs";
import { getCtx, injectedCoords, type RelayCtx } from "./runtime";
import "./chat.css";

const errStyle = "padding:16px;color:#c0392b;font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-word";

class ErrorBoundary extends Component<{ children: ReactNode }, { err: unknown }> {
  state = { err: null as unknown };
  static getDerivedStateFromError(err: unknown) { return { err }; }
  componentDidCatch(err: unknown) { console.error("relay-chat render error:", err); }
  render() {
    if (this.state.err) {
      const e = this.state.err as any;
      return <pre style={{ padding: 16, color: "#c0392b", font: "12px/1.5 ui-monospace,Menlo,monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{"relay-chat 렌더 오류:\n" + String(e?.stack || e?.message || e)}</pre>;
    }
    return this.props.children;
  }
}

function showError(label: string, detail: string) {
  const h = document.getElementById("relay-chat");
  if (h && !h.firstElementChild) h.innerHTML = `<pre style="${errStyle}">${label}:\n${detail.replace(/</g, "&lt;")}</pre>`;
}

window.addEventListener("error", (e) => showError("스크립트 오류", String((e as ErrorEvent).message || e) + "\n" + ((e as ErrorEvent).filename || "")));
window.addEventListener("unhandledrejection", (e) => showError("Promise 거부", String((e as PromiseRejectionEvent).reason)));

function render(host: HTMLElement, ctxOverrides?: Partial<RelayCtx>) {
  const root = createRoot(host);
  root.render(
    <ErrorBoundary>
      <ChatApp ctxOverrides={ctxOverrides} />
    </ErrorBoundary>
  );
  return root;
}

function boot() {
  // 멀티 에이전트 데스크(기판 /desk 문서 — 탭 셸). #relay-desk 우선.
  const ws = document.getElementById("relay-desk");
  if (ws) {
    try {
      createRoot(ws).render(<ErrorBoundary><Desk /></ErrorBoundary>);
    } catch (e: any) {
      ws.innerHTML = `<pre style="${errStyle}">데스크 부팅 오류:\n${String(e?.stack || e).replace(/</g, "&lt;")}</pre>`;
    }
    return;
  }
  // 전용 채팅 문서 — 기판이 #relay-chat 과 컨텍스트 주입을 함께 서빙한다.
  const host = document.getElementById("relay-chat");
  if (host) {
    try {
      render(host);
    } catch (e: any) {
      showError("부팅 오류", String(e?.stack || e));
    }
    return;
  }
  // 호스트 div 없는 문서 — 패키지 view 임베드(자동 부유 위젯) 또는 컴포넌트 모드
  // (호스트가 mount/mountTabs 를 부를 때까지 아무것도 그리지 않는다 — body 침범 금지).
  autoFloat();
}

// ── 자동 부유 위젯(패키지 view 임베드) — 구 widget.js 자동 마운트 게이트의 승계 ──
// 게이트 둘: ① 기판 자산으로 로드된 경우에만(import.meta.url 의 /assets/ 판별 — npm 임포트
// 소비자가 부유 위젯을 떠안지 않게), ② window.RELAY_CHAT_MANUAL = true 면 마운트하지 않는다.
// 좌표는 파일 머리의 규약(§2-6)대로 주입만 받는다 — 구 판의 location.pathname(/pkg/…) 파싱은
// 마운트 문법 조립이라 은퇴. 미주입이면 마운트를 포기하고 판정을 콘솔에 남긴다(fail-loud).
const FLOAT_CSS = `
.rc-float-dock{position:fixed;right:20px;bottom:20px;z-index:2147483000}
.rc-float-fab{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:var(--rc-accent,#0f766e);color:#fff;font-size:22px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
.rc-float-fab:hover{background:var(--rc-accent-strong,#115e59)}
.rc-float-dock.open .rc-float-fab{display:none}
.rc-float-panel{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:96vw;background:var(--rc-bg,#fff);border-left:1px solid var(--rc-line,#e6e9ec);box-shadow:-10px 0 36px rgba(0,0,0,.10);display:none;flex-direction:column;overflow:hidden}
.rc-float-dock.open .rc-float-panel{display:flex}
`;

function autoFloat() {
  if ((window as any).RELAY_CHAT_MANUAL) return;
  if (!String(import.meta.url).includes("/assets/")) return;
  if (!injectedCoords().declared) {
    console.error(
      "relay-chat: 좌표(base) 미주입 — 자동 마운트를 중단합니다. 기판 마운트를 아는 쪽이 " +
      "window.__RELAY_CONTEXT.base 또는 data-relay-base 로 주입해야 합니다(client-protocol §2-6).",
    );
    return;
  }
  const style = document.createElement("style");
  style.textContent = FLOAT_CSS;
  document.head.appendChild(style);
  const dock = document.createElement("div");
  dock.className = "rc-float-dock";
  const panel = document.createElement("div");
  panel.className = "rc-float-panel";
  const fab = document.createElement("button");
  fab.type = "button";
  fab.className = "rc-float-fab";
  fab.textContent = "✦";
  fab.setAttribute("aria-label", "채팅 열기");
  dock.appendChild(panel);
  dock.appendChild(fab);
  document.body.appendChild(dock);
  let opened = false;
  // 도킹은 겹침이 아니라 **공간 예약**이다 — 열면 body 폭을 줄여 화면이 나란히 앉는다(org
  // 기판의 도킹 계약과 같은 결: 화면이 body 기준 폭(w-full/100%)이면 자연히 함께 줄어든다).
  // fixed 오버레이만 있으면 전폭 화면 위에 패널이 떠서 내용을 가린다 — 실사용 보고의 답.
  const PANEL_W = 440;
  const prevBodyWidth = document.body.style.width;
  const prevBodyTransition = document.body.style.transition;
  const reserve = (v: boolean) => {
    if (v && window.innerWidth > PANEL_W * 2) {
      document.body.style.transition = "width .18s ease";
      document.body.style.width = `calc(100% - ${PANEL_W}px)`;
    } else {
      document.body.style.width = prevBodyWidth;
      document.body.style.transition = prevBodyTransition;
    }
  };
  const setOpen = (v: boolean) => { opened = v; dock.classList.toggle("open", v); reserve(v); };
  let mounted = false;
  fab.addEventListener("click", () => {
    if (!mounted) {
      mounted = true;
      const ctx = getCtx();
      mountTabs(panel, {
        ...(ctx.instanceId ? { instanceId: ctx.instanceId } : {}),
        onCollapse: () => setOpen(false),
        onAllClosed: () => setOpen(false),
      });
    }
    setOpen(!opened);
  });
}

// ── mount API (컴포넌트화 1단계) — iframe/window.relay 브리지 없이 임의 div 도킹 ──
export type RelayChatMountOptions = {
  /** 대상 인스턴스 id. 생략 시 전역 __RELAY_CONTEXT/[data-relay-instance] 폴백. */
  instanceId?: string;
  /** 대화 스레드 id — "main" | "agent-<name>[:<param>]" (routematch 슬롯 문자열 계약과 동형).
   *  기존 conversationId 자리에 주입되며, mount 시 이 스레드의 히스토리를 되읽는다. */
  conversation?: string;
  title?: string;
  /** 신원 표식(기본 "local" — 서버가 검증된 호출자로 승격, 신원 해석은 서버가 정본). */
  principal?: string;
  /** 패널 접기 콜백(호스트 크롬 소유) — 있으면 위젯 헤더에 접기 버튼이 생긴다. */
  onClose?: () => void;
};

// ── mountTabs API — 도킹 채팅을 멀티 세션 탭 셸(ChatTabs)로 마운트(구 단일 ChatApp 대체) ──
// 도킹 크롬(agent.tsx ChatChrome)이 부른다. openTab(핸들)으로 특정 (인스턴스×대화)를 탭으로 연다
// (relay:chat-open 착지). onAllClosed=탭 전부 닫힘 시 패널 닫기, onCollapse=탭 유지한 채 접기.
export type RelayTabsMountOptions = {
  instanceId?: string;
  conversation?: string;
  title?: string;
  principal?: string;
  onAllClosed?: () => void;
  onCollapse?: () => void;
};

export function mountTabs(el: HTMLElement, opts: RelayTabsMountOptions = {}) {
  let inner: { openTab: (r: OpenReq) => void } | null = null;
  let pending: OpenReq[] = [];
  const register = (h: { openTab: (r: OpenReq) => void } | null) => {
    inner = h;
    if (h && pending.length) { pending.forEach((p) => h.openTab(p)); pending = []; }
  };
  const initial: OpenReq | undefined = opts.instanceId
    ? { instanceId: opts.instanceId, conversationId: opts.conversation, title: opts.title }
    : undefined;
  const root = createRoot(el);
  root.render(
    <ErrorBoundary>
      <ChatTabs
        variant="dock"
        initial={initial}
        principal={opts.principal || "local"}
        onAllClosed={opts.onAllClosed}
        onCollapse={opts.onCollapse}
        registerHandle={register}
      />
    </ErrorBoundary>
  );
  return {
    unmount: () => root.unmount(),
    openTab: (r: OpenReq) => { if (inner) inner.openTab(r); else pending.push(r); },
  };
}

export function mount(el: HTMLElement, opts: RelayChatMountOptions = {}) {
  let current = { ...opts };
  let root: ReturnType<typeof render>;
  const toOverrides = (o: RelayChatMountOptions): Partial<RelayCtx> => ({
    instanceId: o.instanceId,
    conversationId: o.conversation,
    title: o.title,
    principal: o.principal,
    onClose: o.onClose,
    // 대화함의 대상 전환 — 위젯 내부(InboxMenu)가 부른다. 재마운트로 구현(스레드는 서버 SoT).
    onRetarget: (instanceId: string, conversation: string) => api.setTarget(instanceId, conversation),
  });
  const remount = () => {
    root?.unmount();
    root = render(el, toOverrides(current));
  };
  const api = {
    unmount: () => root.unmount(),
    // ChatApp 은 ctxOverrides 를 mount 시 1회 캡처(getCtx useMemo [])하므로 prop 재주입으로는
    // 전환되지 않는다 — root 를 내리고 같은 el 에 새 root 로 재렌더한다(unmount 된 root 는
    // 재사용 불가). 스레드는 서버 SoT 라 재마운트 무해 — 새 root 가 히스토리를 되읽는다.
    setConversation: (c: string) => {
      if (c === current.conversation) return;
      current = { ...current, conversation: c };
      remount();
    },
    // 대상(인스턴스)까지 전환 — 대화함/외부 이벤트(relay:chat-open detail.instance)가 쓴다.
    setTarget: (instanceId: string, conversation?: string) => {
      if (instanceId === current.instanceId && (!conversation || conversation === current.conversation)) return;
      current = { ...current, instanceId, ...(conversation ? { conversation } : {}) };
      remount();
    },
  };
  root = render(el, toOverrides(current));
  return api;
}

// 전역 표면 유지 — ESM import 를 못 쓰는 임베더(인라인 스크립트 등)의 진입점.
(window as any).RelayChat = { mount, mountTabs };

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();

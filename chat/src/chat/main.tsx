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
import "./tw.css";
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
//
// autoFloat 는 OSS 의 **크롬**이다(view-bridge.md §1-1) — 뷰 발신 wire 의 착지를 소유한다:
//   · relay:chat-open(§4-8) — 패널 열기 + 대상 해석 + prefill/send 를 postMessage 로 중계
//     (재시도-until-ack, §4-10 — 수신부는 Chat.tsx 컴포저).
//   · relay:scope(§5-17) — "페이지가 곧 대화": 선언 슬롯을 preview 탭으로 끌어온다.
//     패널이 닫혀 있으면 이월해 열릴 때 착지한다.
// relayos 쌍둥이 크롬은 agent.tsx ChatChrome — 같은 wire 를 같은 규칙으로 착지한다.
const FLOAT_CSS = `
.rc-float-dock{position:fixed;right:20px;bottom:20px;z-index:2147483000}
.rc-float-fab{width:52px;height:52px;border-radius:50%;border:none;cursor:pointer;background:var(--rc-accent,#0f766e);color:#fff;font-size:22px;box-shadow:0 6px 20px rgba(0,0,0,.18)}
.rc-float-fab:hover{background:var(--rc-accent-strong,#115e59)}
.rc-float-dock.open .rc-float-fab{display:none}
.rc-float-panel{position:fixed;top:var(--rc-dock-top,0px);right:0;bottom:0;width:var(--rc-dock-w,380px);max-width:96vw;background:var(--rc-bg,#fff);border-left:1px solid var(--rc-line,#e6e9ec);display:none;flex-direction:column;overflow:hidden}
.rc-float-dock.open .rc-float-panel{display:flex}
.rc-float-grip{position:fixed;top:var(--rc-dock-top,0px);bottom:0;right:calc(var(--rc-dock-w,380px) - 4px);width:8px;cursor:col-resize;z-index:2147483001;display:none}
.rc-float-dock.open .rc-float-grip{display:block}
.rc-float-grip:hover,.rc-float-grip.on{background:rgba(13,148,136,.25)}
body.rc-resizing{cursor:col-resize;user-select:none}
body.rc-resizing iframe{pointer-events:none}
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
  // 패널 폭 — 왼쪽 가장자리를 끌어 조절하고 기억한다(relay-dock-w). 기본 380.
  const DOCK_KEY = "relay-dock-w";
  const MIN_W = 300, MAX_W = 720;
  let PANEL_W = 380;
  try { const v = Number(localStorage.getItem(DOCK_KEY)); if (v >= MIN_W && v <= MAX_W) PANEL_W = v; } catch { /* 무시 */ }
  document.documentElement.style.setProperty("--rc-dock-w", PANEL_W + "px");
  const prevBodyWidth = document.body.style.width;
  const prevBodyTransition = document.body.style.transition;
  const reserve = (v: boolean, animate = true) => {
    if (v && window.innerWidth > PANEL_W * 2) {
      document.body.style.transition = animate ? "width .18s ease" : "none";
      // body 의 margin-left(전역 사이드바가 :root --relay-side 로 민 폭)까지 빼야 나란히 선다 —
      // width 는 내용 폭이라 margin 을 모른 채 100% 를 재면 그만큼 패널 밑으로 들어간다
      document.body.style.width = `calc(100% - ${PANEL_W}px - var(--relay-side, 0px))`;
    } else {
      document.body.style.width = prevBodyWidth;
      document.body.style.transition = prevBodyTransition;
    }
  };
  // getCtx 는 boot 시점 1회 — 주입 좌표(__RELAY_CONTEXT)는 번들 로드 전에 서 있다(§2-6).
  const ctx = getCtx();
  let mounted = false;
  let handle: ReturnType<typeof mountTabs> | null = null;
  /** 페이지가 선언한 슬롯(relay:scope) — 무대상 prefill/send 의 착지 판정(view-bridge §4-8).
   *  null = 선언 없음. */
  let declaredSlot: string | null = null;
  /** 패널이 닫혀 있는 동안 도착한 마지막 선언 — 열릴 때 착지(view-bridge §5-17). */
  let pendingScope: OpenReq | null = null;
  /** 크롬 쪽 선언 dedupe — 같은 페이지에 머무는 동안 재발화하지 않아 사용자가 손으로 고른
   *  탭을 빼앗지 않는다(발신 쪽 dedupe 와 이중 방어). */
  let lastScopeKey = "";
  const ensureMounted = () => {
    if (mounted) return;
    mounted = true;
    handle = mountTabs(panel, {
      ...(ctx.instanceId ? { instanceId: ctx.instanceId } : {}),
      onCollapse: () => setOpen(false),
      onAllClosed: () => setOpen(false),
    });
  };
  const setOpen = (v: boolean) => {
    opened = v;
    dock.classList.toggle("open", v);
    reserve(v);
    // 페이지가 읽는 값 — 열린 도크의 폭(닫히면 0). 패키지 화면의 탑바가 이만큼 오른쪽으로 더 뻗어
    // 도크 위를 덮는다(도크는 페이지가 준 --rc-dock-top 아래에서 시작한다)
    document.documentElement.style.setProperty("--rc-dock-open-w", v ? PANEL_W + "px" : "0px");
    if (v && pendingScope && handle) {
      const req = pendingScope;
      pendingScope = null;
      handle.openTab(req);
    }
  };
  fab.addEventListener("click", () => {
    ensureMounted();
    setOpen(!opened);
  });

  // ── 폭 조절 — 패널 왼쪽 가장자리 드래그. 패널 **밖**(dock)에 둔다: 위젯의 React 루트가
  // 패널 안을 통째로 소유해 첫 렌더에 기존 자식을 지우기 때문이다
  const grip = document.createElement("div");
  grip.className = "rc-float-grip";
  grip.title = "끌어서 폭 조절";
  dock.appendChild(grip);
  grip.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add("on");
    document.body.classList.add("rc-resizing");
    const move = (ev: PointerEvent) => {
      PANEL_W = Math.min(MAX_W, Math.max(MIN_W, Math.round(window.innerWidth - ev.clientX)));
      document.documentElement.style.setProperty("--rc-dock-w", PANEL_W + "px");
      document.documentElement.style.setProperty("--rc-dock-open-w", PANEL_W + "px");
      reserve(true, false);
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.classList.remove("on");
      document.body.classList.remove("rc-resizing");
      try { localStorage.setItem(DOCK_KEY, String(PANEL_W)); } catch { /* 무시 */ }
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
  });

  // ── prefill/send 중계(view-bridge §4-9·10) — 크롬은 React 위젯의 마운트 타이밍을 모른다:
  // 1회 발신은 마운트 전이면 유실, ack 없는 반복은 이중 주입. 각자의 ack 이 올 때까지 250ms
  // 간격 재전송, 32회(≈8s) 후 포기. nonce 중복 수신은 위젯이 no-op 한다(Chat.tsx 수신부).
  const relayTimers = new Map<string, ReturnType<typeof setInterval>>();
  const stopRelay = (kind: string) => {
    const t = relayTimers.get(kind);
    if (t) { clearInterval(t); relayTimers.delete(kind); }
  };
  const ACK_OF: Record<string, string> = {
    "relay:chat-prefill-ack": "relay:chat-prefill",
    "relay:chat-send-ack": "relay:chat-send",
  };
  window.addEventListener("message", (ev) => {
    if (ev.origin !== window.location.origin) return;
    const kind = ACK_OF[String((ev.data as any)?.type || "")];
    if (kind) stopRelay(kind);
  });
  const relayToWidget = (kind: "relay:chat-prefill" | "relay:chat-send", text: string) => {
    stopRelay(kind);
    let tries = 0;
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    const fire = () => {
      tries += 1;
      if (tries > 32) { stopRelay(kind); return; }
      try { window.postMessage({ type: kind, text, nonce }, window.location.origin); } catch { /* noop */ }
    };
    relayTimers.set(kind, setInterval(fire, 250));
    fire();
  };

  // ── relay:chat-open 착지(view-bridge §4-8) — 패널 열기 + 대상 해석 + 주입 중계.
  window.addEventListener("relay:chat-open", (ev) => {
    const d = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
    ensureMounted();
    setOpen(true);
    const inst = typeof d.instance === "string" && d.instance ? d.instance : "";
    const conv = typeof d.conversation === "string" && d.conversation ? d.conversation : "";
    const prefill = typeof d.prefill === "string" ? d.prefill : "";
    const send = typeof d.send === "string" ? d.send : "";
    if (inst || conv) {
      // 명시 대상 존중 — instance 생략은 크롬 자신의 좌표(주입 instanceId)로 해석(§4-8).
      const instanceId = inst || ctx.instanceId;
      if (instanceId) handle?.openTab({ instanceId, ...(conv ? { conversationId: conv } : {}) });
    } else if ((prefill || send) && declaredSlot && ctx.instanceId) {
      // 무대상 prefill/send 는 페이지 선언 슬롯으로 — 아니면 그 글이 지금 활성인, 대개 무관한
      // 에이전트에게 간다. 선언이 없으면 전환하지 않는다(활성 탭 유지).
      handle?.openTab({ instanceId: ctx.instanceId, conversationId: declaredSlot });
    }
    if (prefill) relayToWidget("relay:chat-prefill", prefill);
    if (send) relayToWidget("relay:chat-send", send);
  });

  // ── relay:scope 착지(view-bridge §5-17) — "페이지가 곧 대화": 선언 변화(SPA 이동 포함)마다
  // 그 슬롯을 preview 탭으로 끌어온다. 선언 부재(null)는 상위 좌표("main")로 같은 푸시 —
  // 건너뛰면 대화가 직전에 보던 다른 에이전트 탭에서 계속된다. 좌표 없는 문서(instanceId
  // 미주입)는 탭 좌표를 만들 수 없어 건너뛴다(선언 슬롯 기억은 유지 — prefill 라우팅용).
  window.addEventListener("relay:scope", (ev) => {
    const d = ((ev as CustomEvent).detail || {}) as Record<string, unknown>;
    const conversation = typeof d.conversation === "string" && d.conversation ? d.conversation : null;
    const targets = Array.isArray(d.targets)
      ? d.targets.filter((t): t is string => typeof t === "string" && !!t)
      : [];
    declaredSlot = conversation;
    if (!ctx.instanceId) return;
    const key = JSON.stringify([conversation, targets]);
    if (key === lastScopeKey) return;
    lastScopeKey = key;
    const req: OpenReq = {
      instanceId: ctx.instanceId,
      conversationId: conversation ?? "main",
      preview: true,
      ...(targets.length ? { targets } : {}),
    };
    if (opened && handle) handle.openTab(req);
    else pendingScope = req;
  });
  // 부팅 레이스 봉합(view-bridge §5-16-a) — 선언은 변화 때만 흐르고 이 번들은 async 로
  // 늦게 뜰 수 있다: 리스너 등록 직후 현재 선언의 재방송을 요청한다. 바인딩 층이 없는
  // 문서는 응답이 없다 — 기본 상태(선언 없음) 그대로.
  try { window.dispatchEvent(new CustomEvent("relay:scope-request")); } catch { /* 무시 */ }
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

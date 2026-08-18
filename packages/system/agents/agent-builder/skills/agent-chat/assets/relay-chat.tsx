"use client";

/* RelayChat React 바인딩 — agent-chat 스킬의 스캐폴드 템플릿. view 소스에 복사해 쓴다.
   프로토콜(엔드포인트·봉투·세션 장부)은 기판이 서빙하는 /assets/chat-app.js 와 공개 계약
   (docs/client-protocol.md v1) 소유이고, 이 파일은 그 표면만 소비하는 안정층이다 —
   복사해도 썩지 않는 이유. 번들 자체를 번들에 넣거나 public/ 에 복사하는 것은 여전히 금지다.

   사용:
     <RelayChat style={{ height: 520 }} />                          기본 UI (기판 위젯 inline)
     const coords = useRelayCoords()                                주입 좌표 읽기
     await sendTurn(coords.base, session, "질문", { onEvent })      커스텀 UI (계약 직접 호출)
*/

import { useEffect, useRef, useState, type CSSProperties } from "react";

/** 기판이 view 문서에 심는 마운트 좌표(client-protocol §2-6). 클라이언트는 조립하지 않는다. */
export interface RelayCoords {
  /** 대화 스코프의 뿌리 — §5 의 모든 동사가 여기 상대다 */
  base: string;
  /** 인스턴스 열거의 뿌리 */
  root: string;
  instanceId?: string;
}

/** 주입 좌표를 읽는다. 미주입이면 null — URL 에서 조립하지 마라(다른 마운트에서 깨진다). */
export function readCoords(): RelayCoords | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { __RELAY_CONTEXT?: Partial<RelayCoords> };
  const c = w.__RELAY_CONTEXT;
  if (c && typeof c.base === "string") return { base: c.base, root: c.root ?? c.base, instanceId: c.instanceId };
  const el = document.querySelector<HTMLElement>("[data-relay-base]");
  if (!el) return null;
  const base = el.getAttribute("data-relay-base") ?? "";
  return base ? { base, root: el.getAttribute("data-relay-root") ?? base, instanceId: el.getAttribute("data-relay-instance") ?? undefined } : null;
}

/** 좌표를 React 상태로. SSR 에서는 null 이고 마운트 후 채워진다. */
export function useRelayCoords(): RelayCoords | null {
  const [coords, setCoords] = useState<RelayCoords | null>(null);
  useEffect(() => setCoords(readCoords()), []);
  return coords;
}

export interface TurnEvent {
  event: string;
  [k: string]: unknown;
}

export interface TurnResult {
  reply: string;
  files: string[];
}

/**
 * 계약 v1 왕복 하나 — 개설(202)과 관찰(SSE)이 분리돼 있다.
 * 어휘는 하네스 봉투 protocol 3 그대로: delta·tool·usage·task·ask·file·reply·error.
 * 종결은 reply/error 정확히 하나이고, 스트림의 끝은 수명주기 settled 다 —
 * settled 없이 끊긴 스트림은 종결이 아니라 절단이므로 빈 답으로 위장하지 않는다.
 */
export async function sendTurn(
  base: string,
  session: string,
  message: string,
  opts: { attachments?: string[]; scene?: string; onEvent?: (ev: TurnEvent) => void } = {},
): Promise<TurnResult> {
  const open = await fetch(`${base}/turns`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      message,
      session,
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts.scene ? { scene: opts.scene } : {}),
    }),
  });
  const started = (await open.json()) as { turn?: string; error?: { message?: string } };
  if (!open.ok || !started.turn) throw new Error(started.error?.message ?? `turn ${open.status}`);

  const res = await fetch(`${base}/turns/${encodeURIComponent(started.turn)}/stream`);
  if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let reply = "";
  let failure = "";
  let settled = false;
  const files: string[] = [];
  while (!settled) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut: number;
    // 프레임 경계는 빈 줄. 하트비트(:hb)처럼 data: 아닌 줄은 버린다
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        let ev: TurnEvent;
        try {
          ev = JSON.parse(line.slice(5).trim()) as TurnEvent;
        } catch {
          continue; // 부서진 줄 하나가 턴을 죽이지 않는다
        }
        opts.onEvent?.(ev);
        if (ev.event === "file" && typeof ev.path === "string" && !files.includes(ev.path)) files.push(ev.path);
        else if (ev.event === "reply") reply = String(ev.text ?? "");
        else if (ev.event === "error") failure = String(ev.message ?? "턴 실패");
        else if (ev.event === "turn" && ev.status === "settled") settled = true;
      }
    }
  }
  await reader.cancel().catch(() => { /* 이미 닫힌 스트림 */ });
  if (failure) throw new Error(failure);
  if (!settled) throw new Error("스트림이 종결 없이 끊겼습니다");
  return { reply, files };
}

// 번들러가 절대 URL 을 자기 모듈로 해석하지 못하게 런타임 임포트로 우회한다
const importAsset = (url: string): Promise<any> => (new Function("u", "return import(u)") as (u: string) => Promise<any>)(url);

/** 위젯 스타일은 번들과 짝이다 — 링크가 없으면 마크업만 뜨고 레이아웃이 무너진다 */
function ensureWidgetCss(): void {
  const href = "/assets/chat-app.css";
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

/** 기본 UI — 기판 위젯을 inline 으로 심는 래퍼. 커스텀 UI 라면 sendTurn 을 쓰라.
    이 컴포넌트를 쓰는 화면에는 자동 마운트 script 를 같이 넣지 마라 — 부유 위젯이 중복으로 뜬다 */
export function RelayChat(props: {
  instanceId?: string;
  conversation?: string;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let gone = false;
    let handle: { unmount(): void } | null = null;
    // 번들은 로드 시 자동 마운트를 시도한다 — 첫 로드 전에 수동 모드를 켜야 부유 위젯이 안 샌다
    (window as unknown as { RELAY_CHAT_MANUAL?: boolean }).RELAY_CHAT_MANUAL = true;
    ensureWidgetCss();
    importAsset("/assets/chat-app.js").then((m) => {
      if (gone || !host.current) return;
      // 좌표는 주입에서 온다 — instanceId 를 안 주면 위젯이 주입값을 쓴다
      handle = m.mount(host.current, {
        ...(props.instanceId ? { instanceId: props.instanceId } : {}),
        ...(props.conversation ? { conversation: props.conversation } : {}),
        ...(props.title ? { title: props.title } : {}),
      });
    });
    return () => { gone = true; handle?.unmount(); };
  }, [props.instanceId, props.conversation, props.title]);
  return <div ref={host} className={props.className} style={{ height: "100%", ...props.style }} />;
}

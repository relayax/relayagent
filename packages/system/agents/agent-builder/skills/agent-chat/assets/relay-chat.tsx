"use client";

/* RelayChat React 바인딩 — agent-chat 스킬의 스캐폴드 템플릿. view 소스에 복사해 쓴다.
   프로토콜(엔드포인트·봉투·세션 장부)은 기판이 서빙하는 /assets/chat-core.js 소유이고,
   이 파일은 그 공개 계약(이벤트·메서드)만 소비하는 안정층이다 — 복사해도 썩지 않는 이유.
   코어·위젯 자체를 번들에 넣거나 public/ 에 복사하는 것은 여전히 금지다.

   사용:
     <RelayChat style={{ height: 520 }} />                          기본 UI (기판 위젯 inline)
     <RelayChatProvider> + useRelayChat()                           커스텀 UI (headless)
*/

import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

export interface ChatMessage {
  role: "user" | "bot" | "sys";
  text: string;
  files?: { name: string; path: string }[];
  usage?: { input: number; output: number; context_window: number | null };
  model?: string;
}

export interface ChatError {
  code: string;
  message: string;
}

export interface SendOptions {
  attachments?: { path: string; name?: string }[];
  agent?: string;
  /** 화면 맥락 스냅샷 — 합성은 기판 몫. 프롬프트 서문으로 붙고 이력에는 원문만 남는다 */
  scene?: string;
  /** 화면용 원문 — text 에 손으로 맥락을 섞는 특수한 경우에만 (이력에 맥락이 남는다) */
  display?: string;
}

/** /assets/chat-core.js 공개 계약의 발췌 — 전체 표면은 기판 레포 lib/relayjs/src/index.d.ts */
export interface ChatClient {
  pkg: string;
  readonly slot: string;
  readonly busy: boolean;
  history: ChatMessage[];
  on(ev: string, fn: (arg?: unknown) => void): () => void;
  send(text: string, opts?: SendOptions): Promise<{ reply: string } | { error: ChatError }>;
  cancel(): Promise<unknown>;
  reset(): Promise<unknown>;
  upload(file: File | Blob, onProgress?: (pct: number) => void): Promise<{ path: string; size: number; name: string } | { error: ChatError }>;
  fileUrl(rel: string, dl?: boolean): string;
}

/** 설치 이름은 설치 시점에 정해진다 — URL 이 유일한 정본이다. 하드코딩하지 마라 */
export function pkgFromUrl(): string {
  const m = location.pathname.match(/^\/pkg\/([^/]+)\/view/);
  if (!m) throw new Error("relay view 밖에서는 패키지를 알 수 없다: " + location.pathname);
  return decodeURIComponent(m[1]);
}

// 번들러가 절대 URL 을 자기 모듈로 해석하지 못하게 런타임 임포트로 우회한다
const importAsset = (url: string): Promise<any> => (new Function("u", "return import(u)") as (u: string) => Promise<any>)(url);

const Ctx = createContext<ChatClient | null>(null);

/** 커스텀 UI 의 뿌리 — 코어를 런타임에 불러와 클라이언트 하나를 하위 트리에 공유한다 */
export function RelayChatProvider(props: { pkg?: string; slot?: string; agent?: string; children: ReactNode }) {
  const [client, setClient] = useState<ChatClient | null>(null);
  useEffect(() => {
    let gone = false;
    importAsset("/assets/chat-core.js").then((m) => {
      if (!gone) setClient(m.createChat({ pkg: props.pkg || pkgFromUrl(), slot: props.slot, agent: props.agent }));
    });
    return () => { gone = true; };
  }, [props.pkg, props.slot, props.agent]);
  return <Ctx.Provider value={client}>{props.children}</Ctx.Provider>;
}

/** 코어 상태를 React 상태로. ready 전에는 이력이 비어 있고 send 가 오류를 돌려준다 */
export function useRelayChat() {
  const client = useContext(Ctx);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!client) return;
    const sync = () => setMessages([...client.history]);
    sync();
    setBusy(client.busy);
    const offs = [
      client.on("message", sync),
      client.on("history", sync),
      client.on("reset", sync),
      client.on("busy", (b) => setBusy(!!b)),
    ];
    return () => { for (const off of offs) off(); };
  }, [client]);
  const send = (text: string, opts?: SendOptions) =>
    client
      ? client.send(text, opts)
      : Promise.resolve({ error: { code: "E_NOT_READY", message: "채팅이 아직 준비되지 않았습니다" } as ChatError });
  return { client, ready: client != null, messages, busy, send };
}

/** 기본 UI — 기판 위젯을 inline 으로 심는 래퍼. 커스텀 UI 라면 useRelayChat 을 쓰라.
    이 컴포넌트를 쓰는 화면에는 자동 마운트 script 한 줄을 같이 넣지 마라 — 부유 위젯이 중복으로 뜬다 */
export function RelayChat(props: { pkg?: string; slot?: string; agent?: string; className?: string; style?: CSSProperties }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let gone = false;
    let handle: { remove(): void } | null = null;
    // 위젯 모듈은 로드 시 자동 마운트를 시도한다 — 첫 로드 전에 수동 모드를 켜야 부유 위젯이 안 샌다
    (window as unknown as { RELAY_CHAT_MANUAL?: boolean }).RELAY_CHAT_MANUAL = true;
    importAsset("/assets/chat-widget.js").then((m) => {
      if (gone || !host.current) return;
      handle = m.mount({ pkg: props.pkg || pkgFromUrl(), mode: "inline", target: host.current, slot: props.slot, agent: props.agent });
    });
    return () => { gone = true; handle?.remove(); };
  }, [props.pkg, props.slot, props.agent]);
  return <div ref={host} className={props.className} style={{ height: "100%", ...props.style }} />;
}

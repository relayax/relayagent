export { createChat } from "./client.ts";
export { cn } from "./ui.js";
// 뷰-채팅 인페이지 브리지(정본 docs/view-bridge.md) — 뷰 발신 표면. React 소비자(view) 전용
// 축이 섞여 있다: headless 왕복만 필요한 소비자는 "@relay/relayjs/client" 서브패스를 쓴다.
export { openChat, setScene, AgentScope, useAgentBinding } from "./bridge.tsx";

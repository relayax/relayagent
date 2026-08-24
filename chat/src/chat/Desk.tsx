/*!
 * Desk.tsx — 멀티 에이전트 데스크(VSCode식 탭). deployd 새 표면 /desk 가 #relay-desk 에
 * 마운트한다. 탭 셸 로직은 공용 ChatTabs(도킹 채팅과 공유)로 추출됐고 — 여기는 그 desk
 * variant 를 세우는 얇은 진입점이다(우측 에이전트 뷰 iframe split 은 desk 에서만 노출).
 *
 * 인스턴스 스코프는 transport 의 X-Relay-Instance 헤더라 문서 하나가 N개 인스턴스를
 * 멀티플렉싱한다(control 무변경) — 각 탭 = 살아있는 ChatApp 1개.
 */
import { ChatTabs } from "./ChatTabs";
import "./chat.css";

export function Desk() {
  return <ChatTabs variant="desk" principal="local" />;
}

"use client";

import { useEffect, useState } from "react";

// 첫 방문 말풍선 — 우측 하단 채팅 버튼의 왼쪽 대각선 위에 뜬다.
// 전부 이 파일에 산다. 제거 = 이 파일 삭제 + page.tsx 의 "말풍선" 표시 2곳 삭제.
const NUDGE_KEY = "relay-nudge-v1";

const CSS = `
.nz-bubble {
  position: fixed; right: 34px; bottom: 80px; z-index: 9998;
  padding: 10px 14px; border-radius: 12px;
  background: color-mix(in srgb, var(--rc-accent) 7%, #fff);
  border: 1px solid color-mix(in srgb, var(--rc-accent) 25%, #fff);
  color: var(--rc-accent-strong);
  font: 600 13px var(--rc-sans);
  box-shadow: 0 6px 18px rgba(15, 23, 42, 0.12);
  cursor: pointer; user-select: none;
  animation:
    nz-in 0.4s cubic-bezier(0.22, 1, 0.36, 1) 0.6s both,
    nz-float 2.8s ease-in-out 1s infinite;
}
.nz-bubble::after {
  content: ""; position: absolute; right: 20px; bottom: -6px; width: 10px; height: 10px;
  background: inherit;
  border-right: 1px solid color-mix(in srgb, var(--rc-accent) 25%, #fff);
  border-bottom: 1px solid color-mix(in srgb, var(--rc-accent) 25%, #fff);
  transform: rotate(45deg);
}
.nz-bubble:hover { background: color-mix(in srgb, var(--rc-accent) 12%, #fff); }
@keyframes nz-in {
  from { opacity: 0; transform: translate(6px, 10px) scale(0.94); }
  to { opacity: 1; transform: none; }
}
@keyframes nz-float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-5px); }
}
`;

export default function ChatNudge() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (!localStorage.getItem(NUDGE_KEY)) setShow(true);
  }, []);

  const dismiss = () => {
    localStorage.setItem(NUDGE_KEY, "1");
    setShow(false);
  };

  if (!show) return null;
  return (
    <>
      <style>{CSS}</style>
      <div className="nz-bubble" role="button" title="닫기" onClick={dismiss}>
        새로운 에이전트를 만들어보세요!
      </div>
    </>
  );
}

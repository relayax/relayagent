"use client";

import { useEffect, useState } from "react";
import { openChat } from "@relay/chat";

// 첫 방문 말풍선 — 우측 하단 채팅 버튼의 왼쪽 대각선 위에 뜬다.
// 누르면 채팅이 열리고 예시 문장이 입력칸에 들어간다 — 종전에는 누르면 닫히기만 했다(버튼처럼
// 생긴 것이 아무 일도 하지 않으면 다음 안내도 안 믿는다).
// 전부 이 파일에 산다. 제거 = 이 파일 삭제 + page.tsx 의 "말풍선" 표시 삭제.
const NUDGE_KEY = "relay-nudge-v2";
const EXAMPLE = "근태관리 도우미 만들어줘. 출근·퇴근을 찍고 이번 달 근무 시간을 볼 수 있게.";

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
  display: flex; align-items: center; gap: 10px;
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
.nz-x { border: none; background: none; color: var(--rc-faint); font: 600 13px var(--rc-sans); cursor: pointer; padding: 0 2px; }
.nz-x:hover { color: var(--rc-ink); }
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
    try {
      if (!localStorage.getItem(NUDGE_KEY)) setShow(true);
    } catch {
      /* 저장소 없음 — 말풍선 없이 간다 */
    }
  }, []);

  const dismiss = () => {
    try {
      localStorage.setItem(NUDGE_KEY, "1");
    } catch {
      /* 무시 */
    }
    setShow(false);
  };
  const go = () => {
    openChat({ prefill: EXAMPLE });
    dismiss();
  };

  if (!show) return null;
  return (
    <>
      <style>{CSS}</style>
      <div className="nz-bubble" role="button" title="채팅을 열고 예시 문장을 넣습니다" onClick={go}>
        <span>새로운 에이전트를 만들어보세요!</span>
        <button
          type="button"
          className="nz-x"
          aria-label="닫기"
          title="닫기"
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
        >
          ×
        </button>
      </div>
    </>
  );
}

"use client";

import { useEffect, useState } from "react";

// 온보딩 전체가 이 파일 하나에 산다 (문구·스타일·노출 규칙).
// 제거하려면 이 파일과 page.tsx 의 "온보딩" 표시 4곳(import, 상태, 안내 버튼, 마운트)을 지우면 끝.
export const ONBOARD_KEY = "relay-onboarding-v1";

// 텍스트 초안 — 카드별 이미지는 추후 image 필드로 얹는다
// body 안의 <b>는 각 단계에서 사용자가 꼭 기억해야 할 조작·개념만 강조한다.
const CARDS = [
  {
    title: "Relay에 오신 것을 환영합니다",
    body: (
      <>
        Relay는 AI 에이전트를 <b>앱처럼 설치해서 쓰는</b> 내 컴퓨터 속 작업 공간입니다. <b>이 화면 하나에서</b> 설치된
        에이전트를 보고, 대화하고, 새로 만들 수 있습니다.
      </>
    ),
  },
  {
    title: "카드 하나가 에이전트 하나입니다",
    body: (
      <>
        가운데 지도에 보이는 <b>카드가 설치된 에이전트</b>입니다. 카드를 누르면 무엇을 할 수 있는지 자세히 볼 수 있고,
        화면을 가진 에이전트는 <b>&quot;새 탭에서 확인하기&quot;</b>로 열어볼 수 있습니다.
      </>
    ),
  },
  {
    title: "채팅으로 말만 하면 됩니다",
    body: (
      <>
        <b>오른쪽 아래 채팅</b>을 열고 원하는 것을 말해보세요. 예를 들어 <b>&quot;근태관리 도우미 만들어줘&quot;</b>라고
        하면 <b>설계부터 설치까지</b> 알아서 진행하고, 일하는 과정도 실시간으로 보여줍니다.
      </>
    ),
  },
  {
    title: "안전장치가 기본입니다",
    body: (
      <>
        비밀번호와 토큰은 <b>금고에만 저장</b>되고, 에이전트는 <b>허락한 폴더만</b> 볼 수 있습니다. 에이전트끼리 연결할
        때도 <b>내 승인이 있어야</b> 활성화됩니다. 이제 시작해보세요.
      </>
    ),
  },
];

const CSS = `
.ob-veil { position: fixed; inset: 0; background: rgba(22, 24, 27, 0.45); display: flex; align-items: center; justify-content: center; z-index: 60; }
.ob-card { width: min(420px, calc(100vw - 48px)); padding: 26px 28px; display: flex; flex-direction: column; gap: 12px; }
.ob-kicker { font: 600 11.5px var(--rc-sans); color: var(--rc-accent); letter-spacing: 0.4px; }
.ob-title { font: 700 18px/1.4 var(--rc-sans); }
.ob-body { color: var(--rc-soft); min-height: 88px; }
.ob-body b { font-weight: 600; color: var(--rc-ink); }
.ob-dots { display: flex; gap: 6px; justify-content: center; padding: 4px 0; }
.ob-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--rc-line); cursor: pointer; }
.ob-dots i.on { background: var(--rc-accent); }
.ob-nav { display: flex; justify-content: space-between; align-items: center; }
.ob-never { display: flex; align-items: center; gap: 6px; color: var(--rc-faint); font: 12.5px var(--rc-sans); cursor: pointer; user-select: none; }
.ob-never input { accent-color: var(--rc-accent); margin: 0; }
.ob-open { margin-left: auto; border: 1px solid var(--rc-line); background: var(--rc-bg); color: var(--rc-soft); border-radius: 999px; padding: 2px 10px; font: 600 11.5px var(--rc-sans); cursor: pointer; }
.ob-open:hover { background: var(--rc-hover); }
`;

export default function Onboarding({ open, onClose }: { open: boolean; onClose: (never: boolean) => void }) {
  const [i, setI] = useState(0);
  const [never, setNever] = useState(false);

  useEffect(() => {
    if (open) {
      setI(0);
      setNever(false);
    }
  }, [open]);

  const close = () => onClose(never);
  const last = i === CARDS.length - 1;

  return (
    <>
      <style>{CSS}</style>
      {open ? (
        <div className="ob-veil" onClick={close}>
          <div className="ob-card rc-card" onClick={(e) => e.stopPropagation()}>
            <div className="ob-kicker">사용 안내 {i + 1} / {CARDS.length}</div>
            <div className="ob-title">{CARDS[i].title}</div>
            <div className="ob-body">{CARDS[i].body}</div>
            <div className="ob-dots">
              {CARDS.map((_, n) => (
                <i key={n} className={n === i ? "on" : ""} onClick={() => setI(n)} />
              ))}
            </div>
            <div className="ob-nav">
              <label className="ob-never">
                <input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} />
                다시 보지 않기
              </label>
              <span style={{ display: "inline-flex", gap: 8 }}>
                {i > 0 ? (
                  <button className="rc-btn" type="button" onClick={() => setI(i - 1)}>
                    이전
                  </button>
                ) : null}
                <button className="rc-btn accent" type="button" onClick={() => (last ? close() : setI(i + 1))}>
                  {last ? "시작하기" : "다음"}
                </button>
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

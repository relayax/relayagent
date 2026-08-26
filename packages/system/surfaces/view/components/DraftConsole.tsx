"use client";

import type { Draft, Nav } from "@/lib/useDraft";
import { fixTargetOf } from "@/lib/verdict";

// 콘솔 띠 — 검사·기록·적용의 결과가 남는 곳. 접혀 있어도 마지막 한 줄은 보인다.
export default function DraftConsole({ draft, nav }: { draft: Draft; nav: Nav }) {
  const { issues, verdicts, log, consoleOpen, effFile } = draft;
  return (
    <div className={`st-console${consoleOpen ? " open" : ""}`}>
      <div className="st-console-bar" onClick={() => draft.setConsoleOpen(!consoleOpen)}>
        <span className="rc-label">콘솔</span>
        {issues != null ? (
          issues.length ? (
            <span className="rc-chip" style={{ color: "var(--rc-err)", background: "var(--rc-err-bg)" }}>
              판정 {issues.length}건
            </span>
          ) : (
            <span className="rc-chip">검사 통과</span>
          )
        ) : null}
        {!consoleOpen && log[0] ? <span className={`st-last ${log[0].kind}`}>{log[0].text}</span> : null}
        <span className="st-sp" />
        <span className="st-caret">{consoleOpen ? "▾" : "▴"}</span>
      </div>
      {consoleOpen ? (
        <div className="st-console-body">
          {issues?.length ? (
            <div className="st-issues">
              {issues.map((text, x) => {
                // 판정은 원인만 말한다 — 고치는 자리로 가는 버튼을 붙인다(좌표가 있을 때)
                const v = verdicts[x];
                const go = v ? fixTargetOf(v.path) : null;
                return (
                  <div key={x} className="st-issue err">
                    <span>- {text}</span>
                    {go ? (
                      <button className="rc-btn" onClick={() => nav({ sec: go.sec, item: go.item, file: null })}>
                        {go.label}
                      </button>
                    ) : v?.line != null && effFile !== "relay.yaml" ? (
                      <button className="rc-btn" onClick={() => nav({ sec: null, item: null, file: "relay.yaml" })}>
                        relay.yaml {v.line}행 보기
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}
          {log.map((l, x) => (
            <div key={x} className={l.kind}>
              {l.href ? (
                // 파일로 받기 — 버튼을 하나 더 두는 대신 결과 줄에서 바로 받는다.
                // 굽고 나서야 의미가 생기는 동작이라 그 자리가 제일 가깝다
                <a href={l.href} download style={{ color: "inherit", fontWeight: 600 }}>
                  {l.text}
                </a>
              ) : (
                l.text
              )}
            </div>
          ))}
          {!log.length && !issues?.length ? <div className="info">검사·기록·적용 결과가 여기 남습니다</div> : null}
        </div>
      ) : null}
    </div>
  );
}

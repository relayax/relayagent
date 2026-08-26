"use client";

import CodeEditor from "@/components/CodeEditor";
import type { Draft } from "@/lib/useDraft";

// 3층 "파일". 몸 전체가 에디터가 된다 — 위에 돌아가는 줄 하나(경로 · 저장 점 · 삭제).
// 동시 편집 판정(기판의 base 검사)에 걸리면 배너가 두 처분을 묻는다.
export default function EditorPanel({ draft, onBack }: { draft: Draft; onBack: () => void }) {
  const { buf, effFile, conflict, marks } = draft;
  if (!effFile) return null;
  return (
    <div className="ed">
      <div className="ed-bar">
        <button type="button" className="rc-btn" onClick={onBack} title="파일을 닫고 실제 화면으로 돌아갑니다">
          ◀ 돌아가기
        </button>
        <span className="mono ed-path">{effFile}</span>
        {buf?.dirty ? <span className="st-dot" title="저장 중" /> : null}
        <span className="st-sp" />
        <button type="button" className="st-x" title="파일 삭제" onClick={() => draft.deleteFile(effFile)}>
          삭제
        </button>
      </div>
      {buf && buf.path === effFile ? (
        <>
          {conflict === effFile ? (
            <div className="banner" role="alert" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span>다른 손(빌더·다른 화면)이 이 파일을 먼저 고쳤습니다 — 지금 버퍼는 그 위 판이 아닙니다.</span>
              <button className="rc-btn" onClick={draft.conflictReload}>
                새 내용 읽기 (내 편집 버림)
              </button>
              <button className="rc-btn" onClick={draft.conflictOverwrite}>
                내 내용으로 덮어쓰기
              </button>
            </div>
          ) : null}
          <CodeEditor key={buf.path} path={buf.path} value={buf.content} onChange={draft.onEdit} marks={marks} />
        </>
      ) : (
        <div className="empty">
          <span className="rc-ring" />
        </div>
      )}
    </div>
  );
}

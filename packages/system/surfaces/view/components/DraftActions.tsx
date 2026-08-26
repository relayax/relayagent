"use client";

import { useState } from "react";
import { CommitDialog, DiscardDialog, PublishDialog, PublishedDialog, ReleasesDialog } from "@/components/StudioDialogs";
import { notifyNav, type Draft } from "@/lib/useDraft";

type Dialog = null | "commit" | "publish" | "releases" | "discard";

// draft 가 열려 있을 때 머리에 서는 버튼 묶음. 왼쪽에서 오른쪽이 곧 작업 순서다:
//   만들고 고치는 동안 반복하는 것(만들기·↶↷·검사·기록) → 결과를 내는 것(적용·돌아가는 판·내보내기)
//   → 드물고 무거운 것(⋯: 이전 판으로 · 작업 사본 버리기)
// 파괴적인 것을 자주 누르는 버튼과 떨어뜨리는 이유: 옆에 두면 언젠가 잘못 눌린다.
export default function DraftActions({
  pkg,
  draft,
  onOpenPalette,
  onDiscarded,
}: {
  pkg: string;
  draft: Draft;
  onOpenPalette: () => void;
  /** 작업 사본을 버린 뒤 — 패키지 화면은 설치본으로 돌아가고, 설치본이 없으면 떠난다 */
  onDiscarded: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [more, setMore] = useState(false);
  const { status, manifest, changedCount, published, say } = draft;
  return (
    <>
      <button className="rc-btn accent" onClick={onOpenPalette} title="이 앱에 무엇을 붙일 수 있는지 봅니다">
        ＋ 만들기
      </button>
      <span className="st-undo">
        <button className="rc-btn" title={`폼 조작 되돌리기 (⌘Z) — 쌓인 판 ${draft.undoDepth}`} disabled={!draft.undoDepth} onClick={() => draft.stepHistory("undo")}>
          ↶
        </button>
        <button className="rc-btn" title="다시 적용 (⌘⇧Z)" disabled={!draft.redoDepth} onClick={() => draft.stepHistory("redo")}>
          ↷
        </button>
      </span>
      <button className="rc-btn" title="선언한 것과 실제 파일이 맞는지 봅니다 — 고치지는 않습니다" onClick={() => void draft.validate()}>
        검사
      </button>
      <button className="rc-btn" title="지금까지 고친 것을 되돌릴 수 있는 지점으로 남깁니다" disabled={!changedCount} onClick={() => setDialog("commit")}>
        기록
      </button>
      <span className="st-div" aria-hidden="true" />
      <button className="rc-btn accent" title="고친 것을 실제로 돌아가는 판으로 바꿉니다" onClick={() => setDialog("publish")}>
        적용
      </button>
      <button className="rc-btn" title="남에게 주거나 스토어에 올릴 수 있는 형태로 만듭니다" disabled={!status?.version.live} onClick={() => void draft.pack()}>
        내보내기
      </button>
      <span className="st-more">
        <button className="rc-btn" title="이전 판으로 · 작업 사본 버리기" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          ⋯
        </button>
        {more ? (
          <div className="st-menu" role="menu" onMouseLeave={() => setMore(false)}>
            <button role="menuitem" onClick={() => { setMore(false); setDialog("releases"); }}>
              이전 판으로
              <small>예전에 적용했던 판 목록을 보고 그 판으로 바꿉니다</small>
            </button>
            <button role="menuitem" className="danger" onClick={() => { setMore(false); setDialog("discard"); }}>
              작업 사본 버리기
              <small>고치던 내용과 이력을 지웁니다 — 되돌릴 수 없습니다</small>
            </button>
          </div>
        ) : null}
      </span>

      {dialog === "commit" ? (
        <CommitDialog pkg={pkg} changedCount={changedCount} onDone={(line) => { say("ok", line); void draft.refresh(); }} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "publish" ? (
        <PublishDialog
          pkg={pkg}
          draftVersion={status?.version.draft ?? null}
          installed={!!status?.installed}
          manifest={manifest}
          onDone={draft.onPublished}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "releases" ? (
        <ReleasesDialog pkg={pkg} onDone={(line) => { say("ok", line); void draft.refresh(); }} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "discard" ? (
        <DiscardDialog pkg={pkg} installed={!!status?.installed} onDone={() => { notifyNav(); setDialog(null); onDiscarded(); }} onClose={() => setDialog(null)} />
      ) : null}
      {published ? (
        <PublishedDialog pkg={pkg} display={manifest?.display_name ?? pkg} outcome={published} onClose={() => draft.setPublished(null)} />
      ) : null}
    </>
  );
}

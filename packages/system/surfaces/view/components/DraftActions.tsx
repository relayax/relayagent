"use client";

import { useState } from "react";
import { CommitDialog, DiscardDialog, PublishDialog, PublishedDialog, ReleasesDialog } from "@/components/StudioDialogs";
import { notifyNav, type Draft } from "@/lib/useDraft";

type Dialog = null | "commit" | "publish" | "releases" | "discard";

// draft 가 열려 있을 때 머리에 서는 것은 둘뿐이다: [적용] 과 [⋯]. 종전엔 아홉 개(만들기·↶↷·검사·
// 기록·적용·내보내기·⋯·화면 열기)가 같은 무게로 늘어서 무엇을 눌러야 하는지 보이지 않았다.
//   만들기 → 왼쪽 패널의 섹션마다 [＋ 추가] 가 있다(말로 만들기 포함). 탑바의 "만들기"는 새
//            패키지 만들기로도 읽혀 뺐다
//   ↶↷·검사·기록·내보내기·새 탭에서 열기 → 가끔 쓰는 것, ⋯ 안으로(⌘Z 는 그대로)
//   이전 판으로·작업 사본 버리기 → ⋯ 맨 아래, 선 아래(파괴적인 것은 자주 누르는 것과 떨어뜨린다)
export default function DraftActions({
  pkg,
  draft,
  onDiscarded,
}: {
  pkg: string;
  draft: Draft;
  /** 작업 사본을 버린 뒤 — 패키지 화면은 설치본으로 돌아가고, 설치본이 없으면 떠난다 */
  onDiscarded: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [more, setMore] = useState(false);
  const { status, manifest, changedCount, published, say } = draft;
  const viewHref = `/pkg/${encodeURIComponent(pkg)}/view/`;
  const item = (label: string, small: string, onClick: () => void, opt: { disabled?: boolean; danger?: boolean } = {}) => (
    <button role="menuitem" className={opt.danger ? "danger" : undefined} disabled={opt.disabled} onClick={() => { setMore(false); onClick(); }}>
      {label}
      <small>{small}</small>
    </button>
  );
  return (
    <>
      <button
        className="rc-btn accent"
        title={changedCount ? "고친 것을 실제로 돌아가는 판으로 바꿉니다 — 검사를 통과해야 적용됩니다" : "고친 것이 없습니다"}
        disabled={!changedCount && !!status?.installed}
        onClick={() => setDialog("publish")}
      >
        적용{changedCount ? ` (${changedCount})` : ""}
      </button>
      <span className="st-more">
        <button className="rc-btn" title="더 보기" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          ⋯
        </button>
        {more ? (
          <div className="st-menu" role="menu" onMouseLeave={() => setMore(false)}>
            {item("되돌리기", `⌘Z — 쌓인 판 ${draft.undoDepth}`, () => draft.stepHistory("undo"), { disabled: !draft.undoDepth })}
            {item("다시 실행", "⌘⇧Z", () => draft.stepHistory("redo"), { disabled: !draft.redoDepth })}
            <span className="st-menu-div" aria-hidden="true" />
            {item("검사만 하기", "선언한 것과 실제 파일이 맞는지 봅니다 — 고치지는 않습니다", () => void draft.validate())}
            {item("기록 남기기", "지금까지 고친 것을 되돌릴 수 있는 지점으로 남깁니다", () => setDialog("commit"), { disabled: !changedCount })}
            {item("내보내기", "남에게 주거나 스토어에 올릴 수 있는 형태로 만듭니다", () => void draft.pack(), { disabled: !status?.version.live })}
            {status?.installed ? item("새 탭에서 열기", "지금 돌아가고 있는 판의 화면", () => window.open(viewHref, "_blank", "noreferrer")) : null}
            <span className="st-menu-div" aria-hidden="true" />
            {item("이전 판으로", "예전에 적용했던 판 목록을 보고 그 판으로 바꿉니다", () => setDialog("releases"))}
            {item("작업 사본 버리기", "고치던 내용과 이력을 지웁니다 — 되돌릴 수 없습니다", () => setDialog("discard"), { danger: true })}
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

"use client";

import { useState } from "react";
import { CommitDialog, DiscardDialog, PublishDialog, PublishedDialog, ReleasesDialog } from "@/components/StudioDialogs";
import { Button } from "@/components/ui/button";
import { notifyNav, type Draft } from "@/lib/useDraft";

type Dialog = null | "commit" | "publish" | "releases" | "discard";

// draft 가 열려 있을 때 머리에 서는 것은 둘뿐이다: [적용] 과 [⋯]. 종전엔 아홉 개(만들기·↶↷·검사·
// 기록·적용·내보내기·⋯·화면 열기)가 같은 무게로 늘어서 무엇을 눌러야 하는지 보이지 않았다.
//   만들기 → 왼쪽 패널의 섹션마다 [＋ 추가] 가 있다(말로 만들기 포함). 탑바의 "만들기"는 새
//            패키지 만들기로도 읽혀 뺐다
//   ↶↷·검사·기록·내보내기·새 탭에서 열기 → 가끔 쓰는 것, ⋯ 안으로(⌘Z 는 그대로)
//   이전 판으로·작업 사본 버리기 → ⋯ 맨 아래, 선 아래(파괴적인 것은 자주 누르는 것과 떨어뜨린다)
// 사본이 없어도 머리는 그대로 선다 — 사본을 버렸다고 [이전 버전으로]·⋯ 까지 사라지면 사람은
// 자기가 눌러서 화면을 잃었다고 읽는다. 사본에 매인 것(적용·검사·버리기)만 눌리지 않는다(2026-08-28)
export default function DraftActions({
  pkg,
  draft,
  installed,
  onDiscarded,
}: {
  pkg: string;
  draft: Draft;
  /** 지금 돌아가는 버전이 있는가 — 작업 사본과 무관하다(사본을 버려도 그대로다) */
  installed: boolean;
  /** 작업 사본을 버린 뒤 — 패키지 화면은 설치본으로 돌아가고, 설치본이 없으면 떠난다 */
  onDiscarded: () => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [more, setMore] = useState(false);
  const { status, manifest, changedCount, published, say } = draft;
  // 작업 사본이 열려 있는가 — 머리는 사본이 없어도 그대로 서고, 사본에 매인 것만 눌리지 않는다
  const editing = status != null;
  const viewHref = `/pkg/${encodeURIComponent(pkg)}/view/`;
  const item = (label: string, small: string, onClick: () => void, opt: { disabled?: boolean; danger?: boolean } = {}) => (
    <button role="menuitem" className={opt.danger ? "danger" : undefined} disabled={opt.disabled} onClick={() => { setMore(false); onClick(); }}>
      {label}
      <small>{small}</small>
    </button>
  );
  return (
    <>
      {/* 패널 수정은 여기 [적용]으로 반영한다 — 폼은 눌러볼 수 있으므로 바로 적용하지 않는다.
          채팅 수정은 빌더가 바로 적용하므로 이 버튼을 거치지 않는다(그때는 changedCount 0). */}
      <Button
        size="sm"
        title={changedCount ? "패널에서 고친 것을 지금 돌아가는 버전에 반영합니다" : editing ? "패널에서 고친 것이 없습니다" : "고치기 시작하면 여기로 반영합니다 — 아직 작업 사본이 없습니다"}
        disabled={!editing || (!changedCount && !!status?.installed)}
        onClick={() => setDialog("publish")}
      >
        적용{changedCount ? ` (${changedCount})` : ""}
      </Button>
      {/* 되돌리기 — 방금 적용한 것이 마음에 안 들 때 이전 버전으로. 채팅이 바로 적용하는 흐름의 안전망 */}
      {/* "되돌리기"가 ⋯ 안의 ⌘Z 와 같은 이름이라 뜻이 섞였다 — 이건 버전, 저건 조작 취소(2026-08-27) */}
      <Button variant="outline" size="sm" title="예전에 적용했던 버전으로 되돌립니다" disabled={!installed} onClick={() => setDialog("releases")}>
        이전 버전으로
      </Button>
      <span className="st-more">
        <Button variant="outline" size="icon-sm" title="더 보기" aria-haspopup="menu" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          ⋯
        </Button>
        {more ? (
          <div className="st-menu" role="menu" onMouseLeave={() => setMore(false)}>
            {/* 위: 방금 한 조작 · 가운데: 가끔 쓰는 것 · 아래(선 밑): 파괴적인 것. 이름은 부제보다 뜻이 먼저 보이게(2026-08-27) */}
            {item("실행 취소", `⌘Z${draft.undoDepth ? ` · ${draft.undoDepth}단계` : ""}`, () => draft.stepHistory("undo"), { disabled: !draft.undoDepth })}
            {item("다시 실행", "⌘⇧Z", () => draft.stepHistory("redo"), { disabled: !draft.redoDepth })}
            {installed ? item("새 탭에서 열기", "지금 돌아가고 있는 버전의 화면", () => window.open(viewHref, "_blank", "noreferrer")) : null}
            <span className="st-menu-div" aria-hidden="true" />
            {item("되돌릴 지점 남기기", "지금까지 고친 것을 기록해 두고 나중에 여기로 돌아올 수 있게", () => setDialog("commit"), { disabled: !changedCount })}
            {item("검사하기", "선언과 실제 파일이 맞는지만 봅니다 — 고치지는 않습니다", () => void draft.validate(), { disabled: !editing })}
            {item("내보내기", "남에게 주거나 스토어에 올릴 수 있는 파일로 만듭니다", () => void draft.pack(), { disabled: !installed })}
            <span className="st-menu-div" aria-hidden="true" />
            {item("작업 사본 버리기", "패널에서 고치던 것과 이력을 지웁니다 — 되돌릴 수 없습니다", () => setDialog("discard"), { danger: true, disabled: !editing })}
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

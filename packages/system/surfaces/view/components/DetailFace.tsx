"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import AgentPanel from "@/components/AgentPanel";
import DraftActions from "@/components/DraftActions";
import DraftConsole from "@/components/DraftConsole";
import EditorPanel from "@/components/EditorPanel";
import Palette from "@/components/Palette";
import SectionView from "@/components/SectionView";
import { approveGrant, callScript, removePkg } from "@/lib/api";
import { describe, scriptNamesFromFiles, scriptNamesFromTree } from "@/lib/describe";
import { creatable, type Creatable } from "@/lib/create";
import { landingAgent } from "@/lib/faces";
import { SECTIONS } from "@/lib/sections";
import { draftList } from "@/lib/studio";
import type { EdgeView, Pkg, Registry } from "@/lib/types";
import { useDraft, type Nav, type View } from "@/lib/useDraft";

// 패키지 화면의 "상세" — 세 층이 한 몸이다.
//   1층 읽기   설명서 줄(사람 말). 설치본을 보여주되, draft 가 있으면 draft 를 보여주고 칩으로 말한다
//   2층 항목을 누르면 왼쪽 칸이 그 항목의 폼(SectionView)이 된다 — 섹션 랜딩과 결과면은 없다
//   3층 파일   폼의 파일 카드를 누르면 몸 전체가 에디터가 된다
// 종전에는 1층이 콘솔에, 2·3층이 스튜디오(/studio)에 따로 있었다 — 같은 패키지가 두 화면에
// 있고 유일한 다리가 "스튜디오에서 편집" 버튼이었다. 깊이의 정본은 URL(sec · item · file)이다.

/** 결과면 이름표 — "재료" 는 설계 은유(lib/sections.ts)라 화면에는 얻는 것의 이름으로 쓴다 */

export default function DetailFace({
  pkg,
  reg,
  edges,
  view,
  nav,
  onChanged,
  onGone,
  onTitle,
  actionsSlot,
  editorSlot,
}: {
  pkg: Pkg;
  reg: Registry;
  edges: EdgeView[];
  view: View;
  nav: Nav;
  onChanged: () => void;
  onGone: () => void;
  /** draft 에서 읽은 표시 이름·버전 — 설치 안 된 초안은 머리가 이것으로 이름을 얻는다 */
  onTitle: (t: { display: string | null; live: string | null; draft: string | null } | null) => void;
  /** 머리 오른쪽의 액션 자리 */
  actionsSlot: HTMLElement | null;
  /** 파일 에디터가 설 자리(가운데 칸). null 이면 가운데 칸이 없어 왼쪽 칸 전체가 에디터가 된다 */
  editorSlot: HTMLElement | null;
}) {
  // 설치 안 된 초안 — 장부에 없어 콘솔이 합성한 Pkg (workspace 가 빈 것으로 안다)
  const ghost = pkg.workspace === "";
  const draft = useDraft(pkg.name, view, nav);
  const editing = draft.status != null;
  const m = (editing ? draft.manifest : pkg.manifest) ?? {};

  const mine = edges.filter((e) => e.consumer === pkg.name); // 이 앱이 쓰는 것
  const users = edges.filter((e) => e.provider === pkg.name); // 이 앱을 쓰는 앱 — 소비자 역색인
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [palette, setPalette] = useState(false);
  // [＋ 추가] 메뉴에서 고른 종류 — 팔레트가 이것의 질문으로 바로 연다
  const [pickedKind, setPickedKind] = useState<Creatable | null>(null);
  // 설치본의 동사 이름 — 설치본 트리에서. draft 가 열리면 draft 의 파일 목록이 대신한다
  const [liveScripts, setLiveScripts] = useState<string[]>([]);
  // 동사의 짧은 서술 — 설치본은 설치본 코드에서, draft 가 열리면 작업 사본 코드에서. 내용 지문(rev)이
  // 바뀌면 다시 묻는다(동사 파일을 고치면 서술도 따라온다)
  const [verbLabels, setVerbLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let on = true;
    void callScript<{ labels: Record<string, string> }>("pkg-verbs", { name: pkg.name, draft: editing })
      .then((r) => { if (on) setVerbLabels(r.labels ?? {}); })
      .catch(() => { if (on) setVerbLabels({}); });
    return () => { on = false; };
  }, [pkg.name, editing, draft.rev]);

  const label = useCallback((name: string) => reg.packages.find((p) => p.name === name)?.manifest?.display_name ?? name, [reg]);

  // 들어올 때: 초안이거나 이미 draft 가 있으면 연다. 없으면 설치본을 보여주고, 줄을 누를 때 연다
  useEffect(() => {
    let on = true;
    if (ghost) {
      void draft.open();
      return;
    }
    void draftList()
      .then((r) => { if (on && r.drafts.some((d) => d.name === pkg.name)) void draft.open(); })
      .catch(() => {});
    void callScript<{ tree: string[] }>("pkg-read", { name: pkg.name })
      .then((r) => { if (on) setLiveScripts(scriptNamesFromTree(r.tree ?? [], pkg.manifest?.scripts?.source)); })
      .catch(() => { if (on) setLiveScripts([]); });
    return () => { on = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg.name, ghost]);

  // 머리에 이름을 올린다 — 초안은 장부에 표시 이름이 없다
  useEffect(() => {
    onTitle(editing ? { display: draft.manifest?.display_name ?? null, live: draft.status?.version.live ?? null, draft: draft.status?.version.draft ?? null } : null);
  }, [editing, draft.manifest?.display_name, draft.status?.version.live, draft.status?.version.draft, onTitle]);

  const rows = describe(
    m,
    {
      workspace: pkg.workspace,
      scripts: editing ? scriptNamesFromFiles(draft.status!.files, m.scripts?.source) : liveScripts,
      edges: mine,
      landing: landingAgent(m),
      activeHarness: pkg.harness,
      labelOf: label,
      files: draft.status?.files ?? [],
      verbLabels,
    },
    { editing },
  );
  const pending = mine.filter((e) => !e.granted && e.provider);
  async function approve(e: EdgeView) {
    setError(null);
    try {
      await approveGrant({ consumer: e.consumer, provider: e.provider!, tools: e.tools, mission: e.mission });
      onChanged();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  }

  async function remove() {
    setError(null);
    setBusy(true);
    try {
      await removePkg(pkg.name);
      onGone();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setBusy(false);
    }
  }

  // [＋ 추가] 메뉴 — 종류를 골랐으면 draft 를 연 뒤 팔레트를 그 질문으로. "말로" 는 오른쪽 빌더에게
  const pickKind = (c: Creatable) => {
    const go = () => { setPickedKind(c); setPalette(true); };
    if (!editing) void draft.open().then(go);
    else go();
  };
  const ask = (text: string) => {
    try { window.dispatchEvent(new CustomEvent("relay:chat-open", { detail: { prefill: text } })); } catch { /* 무시 */ }
  };

  // 항목·섹션 누름 — draft 가 없으면 열고 나서 간다(설치본 사본)
  // 엔진 칩 — 팔레트의 harness 레시피를 바로 부른다(이름 물을 것이 없다)
  const [engineBusy, setEngineBusy] = useState(false);
  const addEngine = (template: string) => {
    if (engineBusy) return;
    setEngineBusy(true);
    const go = editing ? Promise.resolve() : draft.open();
    void go
      .then(() => (draft.ctx ? creatable("harness").make(draft.ctx, template) : Promise.reject(new Error("작업 사본이 아직 없습니다"))))
      .then((made) => draft.onMade(made))
      .catch(() => {})
      .finally(() => setEngineBusy(false));
  };
  const openAt = (sec: string, item: string | null) => {
    if (!editing) {
      void draft.open().then(() => nav({ sec, item, file: null }));
      return;
    }
    nav({ sec, item, file: null });
  };

  // 설정 갈래 — 여는 것 둘은 위험하지 않다. 초안(장부에 없음)은 열 판도 지울 것도 없다
  const links = !ghost ? (
    <>
      {draft.status?.installed ? (
        <a className="rc-btn" style={{ textDecoration: "none" }} href={`/pkg/${encodeURIComponent(pkg.name)}/view/`} target="_blank" rel="noreferrer" title="지금 돌아가고 있는 판의 화면을 새 탭에서 엽니다">
          돌아가는 판 열기 ↗
        </a>
      ) : null}
      <button
        className="rc-btn"
        type="button"
        title={`${pkg.workspace} 폴더를 파일 탐색기로 엽니다`}
        onClick={() => { void fetch(`/pkg/${encodeURIComponent(pkg.name)}/workspace/open`, { method: "POST" }).catch(() => {}); }}
      >
        데이터 폴더 열기
      </button>
    </>
  ) : null;
  const foot = !ghost ? (
          <div className="detail-foot">
            {confirming ? (
              <>
                <span className="warn-text">
                  {users.length ? `${users.map((e) => label(e.consumer)).join(", ")} 이(가) 함께 멈춥니다.` : "되돌릴 수 없습니다."}
                </span>
                <button className="rc-btn" type="button" onClick={() => setConfirming(false)} disabled={busy}>취소</button>
                <button className="rc-btn danger" type="button" onClick={() => void remove()} disabled={busy}>
                  {busy ? "제거 중…" : "정말 제거"}
                </button>
              </>
            ) : (
              <button className="rc-btn danger" type="button" onClick={() => setConfirming(true)} title="설치를 지웁니다 — 돌아가는 판과 데이터 폴더가 함께 사라집니다">이 패키지 제거</button>
            )}
          </div>
  ) : null;

  // 결과면(작업 사본 미리보기)은 두지 않는다 — 가운데 칸이 실제 화면이고, 폼 아래 미리보기는 빈 상태를
  // 한 번 더 말하는 카드였다. 고친 것은 [적용] 뒤 가운데 칸에서 본다
  // 상태 칩은 머리(탑바)에 — 버전 옆에서 "돌아가는 판 vs 작업 사본" 이 한 줄에 읽힌다
  // 상태는 글 한 줄 — 칩 두 개가 버튼처럼 보였다. 빌더가 돌면 그 말이 앞선다
  const status = editing ? (
    <span
      className={`head-status${draft.changedCount ? " on" : ""}`}
      title={draft.agentBusy ? "이 패키지의 빌더 대화에서 턴이 돌고 있습니다 — 끝나면 화면이 새 내용을 반영합니다" : draft.changedCount ? "고친 것이 있지만 아직 돌아가는 판에 적용되지 않았습니다" : undefined}
    >
      {draft.agentBusy ? "빌더 작업 중…" : draft.changedCount ? `수정 ${draft.changedCount}건 · 아직 적용 안 됨` : "변경 없음"}
    </span>
  ) : null;
  const actions = actionsSlot
    ? createPortal(
        editing ? (
          <>
          {status}
          <DraftActions
            pkg={pkg.name}
            draft={draft}
            onDiscarded={() => {
              if (ghost) onGone();
              else {
                draft.close();
                nav({ sec: null, item: null, file: null });
                onChanged();
              }
            }}
          />
          </>
        ) : (
          <>
            <button className="rc-btn accent" onClick={() => void draft.open()} title="고칠 수 있는 사본을 엽니다 — 적용하기 전에는 돌아가는 판이 바뀌지 않습니다">
              고치기
            </button>
            <a className="rc-btn" href={`/pkg/${encodeURIComponent(pkg.name)}/view/`} target="_blank" rel="noreferrer" title="지금 돌아가고 있는 판의 화면을 새 탭에서 엽니다" style={{ textDecoration: "none" }}>
              ↗
            </a>
          </>
        ),
        actionsSlot,
      )
    : null;

  // 3층 — 파일이 열리면 가운데 칸이 에디터. 왼쪽 목록은 그대로 서 있다(어느 기능을 고치는지 보인다)
  const editor = editing && view.file && editorSlot
    ? createPortal(<EditorPanel draft={draft} onBack={() => nav({ file: null })} />, editorSlot)
    : null;
  if (editing && view.file && !editorSlot) {
    return (
      <>
        {actions}
        <div className="pane-body editor">
          {/* 스크립트 항목은 파일 그 자체다(ScriptItem 이 마운트되며 곧장 연다) — 파일만 닫으면 다시 열리고, 항목만 닫으면
              섹션 랜딩(이 화면에는 없는 층)에 떨어진다. 설명서로 돌아간다. 다른 섹션은 폼(항목)으로 */}
          <EditorPanel draft={draft} onBack={() => (view.sec === "scripts" ? nav({ sec: null, item: null, file: null }) : nav({ file: null }))} />
          <DraftConsole draft={draft} nav={nav} />
        </div>
      </>
    );
  }

  // 페이지 정체성 선언(AgentScope agent-builder)은 PkgPane 이 탭 바깥에서 한다 — 뷰 탭으로
  // 건너가도 오른쪽 빌더 대화가 그대로 남아야 "써보다 → 고쳐달라" 가 한 화면에서 돈다
  return (
    <>
      {actions}
      {editor}
      <div className="pane-body">
        {draft.fatal ? <div className="banner">{draft.fatal}</div> : null}
        {error ? <div className="banner">{error}</div> : null}
        {editing && !draft.manifest ? <div className="banner">relay.yaml 파싱 실패 — 기타 파일에서 relay.yaml 을 열어 문법을 고치세요</div> : null}

        {pending.length ? (
          // 미결재 연결은 설명이 아니라 결재다 — 목록 위에 승인 버튼
          <div className="ap-pending">
            {pending.map((e, i) => (
              <button key={`p-${e.ref}-${i}`} type="button" className="rc-btn" onClick={() => void approve(e)}>
                {label(e.provider!)} 연결 승인
              </button>
            ))}
          </div>
        ) : null}

        <AgentPanel
          m={m}
          files={draft.status?.files ?? []}
          rows={rows}
          landing={landingAgent(m)}
          open={{ sec: editing ? view.sec : null, item: editing ? view.item : null }}
          onOpen={openAt}
          onBack={() => nav({ sec: null, item: null, file: null })}
          links={links}
          danger={foot}
          onPick={pickKind}
          onAsk={ask}
          onEngine={addEngine}
          engineBusy={engineBusy}
        >
          {editing && view.sec && draft.ctx ? (
            <>
              <SectionView sec={view.sec} item={view.item} ctx={draft.ctx} />
            </>
          ) : editing && view.sec ? (
            <div className="empty"><span className="rc-ring" /></div>
          ) : null}
        </AgentPanel>

        {users.length ? (
          <p className="hint">이 앱을 쓰는 앱: {users.map((e) => label(e.consumer)).join(", ")} — 지우면 함께 멈춥니다</p>
        ) : null}

        {editing ? <DraftConsole draft={draft} nav={nav} /> : null}

        {palette && draft.ctx && draft.manifest && draft.status ? (
          <Palette
            manifest={draft.manifest}
            files={draft.status.files}
            ctx={draft.ctx}
            initial={pickedKind}
            onMade={(made) => { setPalette(false); setPickedKind(null); draft.onMade(made); }}
            onClose={() => { setPalette(false); setPickedKind(null); }}
          />
        ) : null}

      </div>
    </>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AgentScope } from "@relay/chat";
import Describe, { Icon } from "@/components/Describe";
import DraftActions from "@/components/DraftActions";
import DraftConsole from "@/components/DraftConsole";
import EditorPanel from "@/components/EditorPanel";
import Palette from "@/components/Palette";
import Preview from "@/components/Preview";
import SectionView from "@/components/SectionView";
import { approveGrant, callScript, removePkg } from "@/lib/api";
import { describe, scriptNamesFromFiles, scriptNamesFromTree } from "@/lib/describe";
import { landingAgent } from "@/lib/faces";
import { SECTIONS, type Material } from "@/lib/sections";
import { draftList } from "@/lib/studio";
import type { EdgeView, Pkg, Registry } from "@/lib/types";
import { useDraft, type Nav, type View } from "@/lib/useDraft";

// 패키지 화면의 "상세" — 세 층이 한 몸이다.
//   1층 읽기   설명서 줄(사람 말). 설치본을 보여주되, draft 가 있으면 draft 를 보여주고 칩으로 말한다
//   2층 고치기 줄을 누르면 그 아래로 그 섹션의 폼(SectionView)과 결과면(Preview)이 펼쳐진다
//   3층 파일   폼의 파일 카드를 누르면 몸 전체가 에디터가 된다
// 종전에는 1층이 콘솔에, 2·3층이 스튜디오(/studio)에 따로 있었다 — 같은 패키지가 두 화면에
// 있고 유일한 다리가 "스튜디오에서 편집" 버튼이었다. 깊이의 정본은 URL(sec · item · file)이다.

/** 결과면 이름표 — "재료" 는 설계 은유(lib/sections.ts)라 화면에는 얻는 것의 이름으로 쓴다 */
const FACE_OF: Record<Material, string> = { 그림: "미리보기", 배선: "연결 지도", 시간: "일정", 말: "시연 대화", 동사: "실행", 계약: "설정" };

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
  // 머리의 요약 칩 — 첫눈에 "무엇을 하는 앱인가". 줄의 재료를 그대로 센다
  const nVerbs = rows.find((r) => r.key === "verbs")?.items.length ?? 0;
  const nWhen = rows.find((r) => r.key === "when")?.items.length ?? 0;
  const talk = rows.find((r) => r.key === "talk")?.items.length ?? 0;
  const engine = rows.find((r) => r.key === "engine")?.items[0]?.text;
  const facts: { k: Parameters<typeof Icon>[0]["k"]; text: string }[] = [
    ...(nVerbs ? [{ k: "verbs" as const, text: `기능 ${nVerbs}개` }] : []),
    { k: "talk" as const, text: talk ? "대화 가능" : "대화 없음" },
    ...(nWhen ? [{ k: "when" as const, text: `스스로 ${nWhen}번 예약` }] : []),
    ...(engine ? [{ k: "engine" as const, text: `${engine} 로 동작` }] : []),
  ];

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

  // 줄 누름 — draft 가 없으면 열고 나서 펼친다(설치본 사본). 같은 줄이면 접는다
  const toggle = (sec: string) => {
    if (!editing) {
      void draft.open().then(() => nav({ sec, item: null, file: null }));
      return;
    }
    nav({ sec: view.sec === sec ? null : sec, item: null, file: null });
  };

  const secDef = SECTIONS.find((s) => s.key === view.sec);
  const actions = actionsSlot
    ? createPortal(
        editing ? (
          <DraftActions
            pkg={pkg.name}
            draft={draft}
            onOpenPalette={() => setPalette(true)}
            onDiscarded={() => {
              if (ghost) onGone();
              else {
                draft.close();
                nav({ sec: null, item: null, file: null });
                onChanged();
              }
            }}
          />
        ) : (
          <button className="rc-btn" onClick={() => void draft.open()} title="고칠 수 있는 사본을 엽니다 — 적용하기 전에는 돌아가는 판이 바뀌지 않습니다">
            고치기
          </button>
        ),
        actionsSlot,
      )
    : null;

  // 3층 — 파일이 열리면 몸 전체가 에디터
  if (editing && view.file) {
    return (
      <AgentScope agent="agent-builder" param={pkg.name}>
        {actions}
        <div className="pane-body editor">
          <EditorPanel draft={draft} onBack={() => nav({ file: null })} />
          <DraftConsole draft={draft} nav={nav} />
        </div>
      </AgentScope>
    );
  }

  return (
    // 페이지 정체성 선언(view-bridge §5) — "이 화면의 대화는 이 패키지의 빌더"
    <AgentScope agent="agent-builder" param={pkg.name}>
      {actions}
      <div className="pane-body">
        <div className="ds-head">
          {m.description ? <p className="lede">{m.description}</p> : null}
          {editing ? (
            draft.changedCount ? (
              <span className="rc-chip" title="고친 것이 있지만 아직 돌아가는 판에 적용되지 않았습니다">
                수정 {draft.changedCount}건 · 아직 적용 안 됨
              </span>
            ) : (
              <span className="rc-chip gray">변경 없음</span>
            )
          ) : null}
          {draft.agentBusy ? (
            <span className="rc-chip" title="이 패키지의 빌더 대화에서 턴이 돌고 있습니다 — 끝나면 화면이 새 내용을 반영합니다">
              빌더 작업 중…
            </span>
          ) : null}
        </div>
        <div className="ds-facts">
          {facts.map((f) => (
            <span key={f.k} className="ds-fact">
              <Icon k={f.k} />
              {f.text}
            </span>
          ))}
        </div>
        {draft.fatal ? <div className="banner">{draft.fatal}</div> : null}
        {error ? <div className="banner">{error}</div> : null}
        {editing && !draft.manifest ? <div className="banner">relay.yaml 파싱 실패 — 기타 파일에서 relay.yaml 을 열어 문법을 고치세요</div> : null}

        <Describe
          rows={rows}
          open={editing ? view.sec : null}
          onToggle={toggle}
          trailing={{
            // 미결재 연결은 설명이 아니라 결재다 — 줄 끝에 승인 버튼. 버튼 안의 버튼이라 전파를 막는다
            links: pending.length ? (
              <span style={{ display: "inline-flex", gap: 6 }}>
                {pending.map((e, i) => (
                  <span
                    key={`p-${e.ref}-${i}`}
                    role="button"
                    className="rc-btn"
                    onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); void approve(e); }}
                  >
                    {label(e.provider!)} 연결 승인
                  </span>
                ))}
              </span>
            ) : null,
          }}
        >
          {editing && view.sec && draft.ctx ? (
            <>
              <div className="rc-card">
                {view.item ? (
                  <div className="ds-crumb">
                    <span className="lnk" onClick={() => nav({ item: null, file: null })}>{secDef?.label ?? view.sec}</span>
                    <i>/</i>
                    <span className="cur">{view.item}</span>
                  </div>
                ) : null}
                <div className="st-scroll">
                  <SectionView sec={view.sec} item={view.item} ctx={draft.ctx} />
                </div>
              </div>
              {draft.previewCtx ? (
                <div className="rc-card st-right">
                  <div className="ds-crumb">
                    <span className="cur">결과</span>
                    <span className="rc-chip gray">{FACE_OF[draft.material]}</span>
                    <span className="st-sp" />
                    <span className="st-ver">발행 전 · 작업 사본</span>
                  </div>
                  <Preview ctx={draft.previewCtx} material={draft.material} />
                </div>
              ) : null}
            </>
          ) : editing && view.sec ? (
            <div className="empty"><span className="rc-ring" /></div>
          ) : null}
        </Describe>

        {users.length ? (
          <p className="hint">이 앱을 쓰는 앱: {users.map((e) => label(e.consumer)).join(", ")} — 지우면 함께 멈춥니다</p>
        ) : null}

        {editing ? <DraftConsole draft={draft} nav={nav} /> : null}

        {palette && draft.ctx && draft.manifest && draft.status ? (
          <Palette
            manifest={draft.manifest}
            files={draft.status.files}
            ctx={draft.ctx}
            onMade={(made) => { setPalette(false); draft.onMade(made); }}
            onClose={() => setPalette(false)}
          />
        ) : null}

        {!ghost ? (
          <div className="detail-foot">
            {draft.status?.installed ? (
              <a className="rc-btn" style={{ textDecoration: "none" }} href={`/pkg/${encodeURIComponent(pkg.name)}/view/`} target="_blank" rel="noreferrer" title="지금 돌아가고 있는 판의 화면을 새 탭에서 엽니다">
                돌아가는 판 열기
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
            <span className="grow" />
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
              <button className="rc-btn danger" type="button" onClick={() => setConfirming(true)}>제거</button>
            )}
          </div>
        ) : null}
      </div>
    </AgentScope>
  );
}

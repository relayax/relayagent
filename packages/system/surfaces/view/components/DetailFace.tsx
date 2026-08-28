"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import AgentPanel, { type ItemStatus } from "@/components/AgentPanel";
import DraftActions from "@/components/DraftActions";
import DraftConsole from "@/components/DraftConsole";
import EditorPanel from "@/components/EditorPanel";
import Palette from "@/components/Palette";
import SectionView from "@/components/SectionView";
import { Button } from "@/components/ui/button";
import { approveGrant, callScript, removePkg, setHarnessActive } from "@/lib/api";
import { describe, scriptNamesFromFiles, scriptNamesFromTree } from "@/lib/describe";
import { creatable, removeHarness, type Creatable } from "@/lib/create";
import { landingAgent } from "@/lib/faces";
import { SECTIONS } from "@/lib/sections";
import { draftList, draftReadFile } from "@/lib/studio";
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
  liveStatus,
  mountedIn,
}: {
  pkg: Pkg;
  reg: Registry;
  /** 이 패키지의 부품을 결재해 쓰는 설치본들(셸 nav 의 mounted_in) — 설명서의 사이드바 자리 줄 */
  mountedIn?: string[];
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
  /** 줄 옆 실행 상태 칩(연결됨·켜짐) — PkgPane 이 실상을 안다 */
  liveStatus?: ItemStatus;
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

  // 착지 에이전트의 성격 글 첫 줄 — 이 에이전트가 자기를 말하는 문장이다. 요약하지 않고 그대로 낸다
  const [personaLead, setPersonaLead] = useState<string>("");
  const personaFile = (m.agents ?? []).find((a) => a.name === landingAgent(m))?.persona;
  useEffect(() => {
    let on = true;
    if (!editing || !personaFile) { setPersonaLead(""); return; }
    void draftReadFile(pkg.name, personaFile)
      .then((r) => {
        if (!on) return;
        // 성격 글은 **에이전트에게 하는 지시문**이라 2인칭이다("당신은 …입니다"). 그대로 내면
        // 화면이 보는 사람에게 말을 거는 꼴이 된다. 그 첫 문장은 이름표일 뿐이라 걷고,
        // 실제 서술이 시작되는 다음 문장부터 낸다(2026-08-28)
        const body = (r.content ?? "")
          .split("\n").map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#") && !l.startsWith("---"))
          .join(" ")
          .replace(/^당신은\s.*?입니다[.!]?\s*/, "")
          .trim();
        setPersonaLead(body.split(/(?<=[.!?])\s+/).slice(0, 2).join(" "));
      })
      .catch(() => { if (on) setPersonaLead(""); });
    return () => { on = false; };
  }, [pkg.name, personaFile, editing, draft.rev]);

  const label = useCallback((name: string) => reg.packages.find((p) => p.name === name)?.manifest?.display_name ?? name, [reg]);

  // 들어올 때: 초안이거나 이미 draft 가 있으면 연다. 없으면 설치본을 보여주고, 줄을 누를 때 연다
  useEffect(() => {
    let on = true;
    if (ghost) {
      void draft.open();
      return;
    }
    void draftList()
      .then((r) => {
        if (!on) return;
        if (r.drafts.some((d) => d.name === pkg.name)) return draft.open();
      })
      .catch(() => { /* 사본 목록을 못 읽으면 설치본을 보여준다 — 줄을 누르면 그때 연다 */ });
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
      mountedIn: mountedIn ?? [],
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
  // 엔진 칩 — 켜면 팔레트의 harness 레시피로 붙이고, 끄면 그 후보를 뺀다(어댑터 파일은 남는다)
  const [engineBusy, setEngineBusy] = useState(false);
  // 지금 도는 엔진 — 장부의 값이라 작업 사본과 무관하다. 전환은 즉시 반영되므로 응답으로 앞선다
  const [active, setActive] = useState<string | null>(pkg.harness);
  useEffect(() => { setActive(pkg.harness); }, [pkg.harness]);
  // 설치본에 선 엔진들 — 장부가 아는 이름만 활성으로 고를 수 있다(사본에만 있으면 적용이 먼저다)
  const liveEngines = (pkg.manifest?.harness?.variants ?? []).map((v) => v.name);
  // 장부에 고른 값이 없거나 그 이름이 사라졌으면 첫 변형이 돈다 — 실행이 그렇게 고른다
  // (supply/manifest.ts activeHarness). 화면이 그 규칙을 모르면 "아무것도 안 켜진" 줄이 뜬다
  const running = active && liveEngines.includes(active) ? active : liveEngines[0] ?? null;
  const activateEngine = (name: string) => {
    if (engineBusy || name === running) return;
    setEngineBusy(true);
    setError(null);
    void setHarnessActive(pkg.name, name)
      .then((r) => { setActive(r.active); onChanged(); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setEngineBusy(false));
  };
  const toggleEngine = (template: string) => {
    if (engineBusy) return;
    setEngineBusy(true);
    const go = editing ? Promise.resolve() : draft.open();
    void go
      .then(() => {
        const ctx = draft.ctx;
        if (!ctx) throw new Error("작업 사본이 아직 없습니다");
        if ((ctx.manifest.harness?.variants ?? []).some((v) => v.name === template)) return removeHarness(ctx, template);
        return creatable("harness").make(ctx, template).then((made) => draft.onMade(made));
      })
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
        <Button variant="outline" size="sm" nativeButton={false} render={<a href={`/pkg/${encodeURIComponent(pkg.name)}/view/`} target="_blank" rel="noreferrer" title="지금 돌아가고 있는 버전의 화면을 새 탭에서 엽니다" />}>
          돌아가는 버전 열기 ↗
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        type="button"
        title={`${pkg.workspace} 폴더를 파일 탐색기로 엽니다`}
        onClick={() => { void fetch(`/pkg/${encodeURIComponent(pkg.name)}/workspace/open`, { method: "POST" }).catch(() => {}); }}
      >
        데이터 폴더 열기
      </Button>
    </>
  ) : null;
  const foot = !ghost ? (
          <div className="detail-foot">
            {confirming ? (
              <>
                <span className="warn-text">
                  {users.length ? `${users.map((e) => label(e.consumer)).join(", ")} 이(가) 함께 멈춥니다.` : "되돌릴 수 없습니다."}
                </span>
                <Button variant="outline" size="sm" type="button" onClick={() => setConfirming(false)} disabled={busy}>취소</Button>
                <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10" type="button" onClick={() => void remove()} disabled={busy}>
                  {busy ? "제거 중…" : "정말 제거"}
                </Button>
              </>
            ) : (
              <Button variant="outline" size="sm" className="text-destructive border-destructive/30 hover:bg-destructive/10" type="button" onClick={() => setConfirming(true)} title="설치를 지웁니다 — 돌아가는 버전과 데이터 폴더가 함께 사라집니다">이 패키지 제거</Button>
            )}
          </div>
  ) : null;

  // 결과면(작업 사본 미리보기)은 두지 않는다 — 가운데 칸이 실제 화면이고, 폼 아래 미리보기는 빈 상태를
  // 한 번 더 말하는 카드였다. 고친 것은 [적용] 뒤 가운데 칸에서 본다
  // 상태 칩은 머리(탑바)에 — 버전 옆에서 "돌아가는 판 vs 작업 사본" 이 한 줄에 읽힌다
  // 상태는 글 한 줄 — 칩 두 개가 버튼처럼 보였다. 빌더가 돌면 그 말이 앞선다
  const status = (
    <span
      className={`head-status${draft.changedCount ? " on" : ""}`}
      title={draft.agentBusy ? "이 패키지의 빌더 대화에서 턴이 돌고 있습니다 — 끝나면 화면이 새 내용을 반영합니다" : draft.changedCount ? "고친 것이 있지만 아직 돌아가는 버전에 적용되지 않았습니다" : undefined}
    >
      {draft.agentBusy ? "빌더 작업 중…" : draft.changedCount ? "아직 적용 안 됨" : "변경 없음"}
    </span>
  );
  // 머리는 한 얼굴이다 — 사본이 있든 없든 같은 줄이 선다. [고치기] 도 ↗ 도 두지 않는다:
  // 줄·[＋ 추가]·엔진 칩이 이미 사본을 열고, "새 탭에서 열기" 는 ⋯ 안과 적용 결과창에 있다.
  // 상태에 따라 버튼이 생겼다 사라지면 사람은 자기가 눌러서 사라졌다고 읽는다(2026-08-28) —
  // 사본을 버렸을 때가 바로 그랬다. 이제 줄은 남고, 사본에 매인 것만 눌리지 않는다
  const actions = actionsSlot
    ? createPortal(
        (
          <>
          {status}
          <DraftActions
            pkg={pkg.name}
            draft={draft}
            installed={!ghost}
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
              <Button key={`p-${e.ref}-${i}`} type="button" variant="outline" size="sm" onClick={() => void approve(e)}>
                {label(e.provider!)} 연결 승인
              </Button>
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
          mountedIn={mountedIn ?? []}
          personaLead={personaLead}
          onEngine={toggleEngine}
          engineBusy={engineBusy}
          activeEngine={running}
          liveEngines={liveEngines}
          onActivate={activateEngine}
          status={liveStatus}
          labelOf={label}
          scripts={editing ? scriptNamesFromFiles(draft.status!.files, m.scripts?.source) : liveScripts}
        >
          {editing && view.sec && draft.ctx ? (
            <>
              <SectionView sec={view.sec} item={view.item} ctx={draft.ctx} verbLabels={verbLabels} />
            </>
          ) : editing && view.sec ? (
            <div className="empty"><span className="rc-ring" /></div>
          ) : null}
        </AgentPanel>

        {/* 한 소비자가 tools·components 두 선언으로 오면 edge 도 둘이다 — 앱 이름은 한 번만 */}
        {users.length ? (
          <p className="hint">이 앱을 쓰는 앱: {[...new Set(users.map((e) => e.consumer))].map(label).join(", ")} — 지우면 함께 멈춥니다</p>
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

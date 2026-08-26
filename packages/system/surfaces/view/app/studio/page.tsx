"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentScope } from "@relay/chat";
import CodeEditor from "@/components/CodeEditor";
import DeclTree from "@/components/DeclTree";
import Palette from "@/components/Palette";
import Preview from "@/components/Preview";
import SectionView from "@/components/SectionView";
import { CommitDialog, DiscardDialog, PublishDialog, PublishedDialog, ReleasesDialog } from "@/components/StudioDialogs";
import { SECTIONS, type Material } from "@/lib/sections";
import { draftList, draftOpen, type DraftEntry } from "@/lib/studio";
import { notifyNav, useDraft } from "@/lib/useDraft";
import { fixTargetOf } from "@/lib/verdict";

// 스튜디오 = 패키지 하나의 수정 레이어를 여는 IDE. URL 쿼리가 depth 의 정본이다:
//   /studio/?pkg=x              depth 1  개요 (relay.yaml 에디터)
//   /studio/?pkg=x&sec=agents   depth 2  섹션 (선언 폼 + 파일 카드)
//   /studio/?pkg=x&...&file=f   depth 3  파일 (에디터 전면)
// 정적 발행(output: export)이라 동적 세그먼트 대신 쿼리를 쓴다.
// 모든 편집은 draft 로 간다 — 설치본(live)을 만지는 화면 경로는 없다.
//
// 화면은 세 면이다: 선언 트리 · 고치는 자리 · **결과면**. 셋째 면이 없던 동안 결과로 가는 문은
// [적용] 뿐이었고, 그건 미리보기가 아니라 발행이었다 — 저작의 되먹임이 "고친다 → 도는 판을
// 갈아치운다 → 본다" 였다는 뜻이다. 결과면의 모양은 재료가 정한다(lib/sections.ts Material).
//
// 기계(draft 열기·저장·충돌·되돌리기·검사·적용)는 lib/useDraft.ts 에 있다 — 이 파일은 그린다.

/** 결과면 이름표 — "재료" 는 설계 은유(lib/sections.ts)라 화면에는 얻는 것의 이름으로 쓴다 */
const FACE_OF: Record<Material, string> = { 그림: "미리보기", 배선: "연결 지도", 시간: "일정", 말: "시연 대화", 동사: "실행", 계약: "설정" };

type Dialog = null | "commit" | "publish" | "releases" | "discard";

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <Studio />
    </Suspense>
  );
}

function Studio() {
  const router = useRouter();
  const sp = useSearchParams();
  const pkg = sp.get("pkg");
  const sec = sp.get("sec");
  const item = sp.get("item");
  const file = sp.get("file");
  const isNew = sp.get("new") === "1";

  const nav = useCallback(
    (q: { sec?: string | null; item?: string | null; file?: string | null }) => {
      const p = new URLSearchParams();
      if (pkg) p.set("pkg", pkg);
      const s = q.sec === undefined ? sec : q.sec;
      const it = q.item === undefined ? item : q.item;
      const f = q.file === undefined ? file : q.file;
      if (s) p.set("sec", s);
      if (s && it) p.set("item", it);
      if (f) p.set("file", f);
      router.push(`/studio/?${p.toString()}`);
    },
    [router, pkg, sec, item, file],
  );

  const draft = useDraft(pkg, { sec, item, file }, nav, { defaultFile: "relay.yaml" });
  // 진입 = draft 열기
  useEffect(() => {
    if (pkg) void draft.open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [palette, setPalette] = useState(false);
  // ⋯ 메뉴 — 이전 판으로 · 작업 사본 버리기. 자주 누르는 버튼과 떨어뜨린다
  const [more, setMore] = useState(false);

  if (!pkg && !isNew) return <Landing />;
  if (isNew) return <Wizard onOpen={(name) => router.replace(`/studio/?pkg=${encodeURIComponent(name)}`)} />;

  const { status, fatal, manifest, buf, effFile, marks, issues, verdicts, log, consoleOpen, conflict, agentBusy, ctx, previewCtx, material, changedCount, published, say } = draft;
  const secDef = SECTIONS.find((s) => s.key === sec);

  return (
    // 페이지 정체성 선언(view-bridge §5) — "이 화면의 대화는 이 패키지의 빌더". 부유 위젯이
    // 이 대화를 미리보기 탭으로 끌어오고, 대상 없는 openChat prefill/send 가 여기로 간다
    <AgentScope agent="agent-builder" param={pkg ?? undefined}>
    <div className="st-shell">
      <div className="rc-card st-top">
        <Link href="/" className="st-back">
          ◀ 콘솔
        </Link>
        <b>{manifest?.display_name ?? pkg}</b>
        <span className="st-ver">
          {status?.version.live ? `live v${status.version.live}` : "미발행"}
          {status?.version.draft && status.version.draft !== status.version.live ? ` · draft v${status.version.draft}` : ""}
        </span>
        {changedCount ? <span className="rc-chip">수정 {changedCount}건</span> : <span className="rc-chip gray">변경 없음</span>}
        {agentBusy ? (
          <span className="rc-chip" title="이 패키지의 빌더 대화에서 턴이 돌고 있습니다 — 끝나면 화면이 새 내용을 반영합니다">
            빌더 작업 중…
          </span>
        ) : null}
        {status?.lastCommit ? <span className="st-commit">기록: {status.lastCommit.message}</span> : null}
        <span className="st-sp" />
        {/* 되돌리기·다시하기 — 폼 조작의 눈금. 파괴적인 [초기화]와 멀리 둔다(오른쪽 끝) */}
        <span className="st-undo">
          <button className="rc-btn" title={`폼 조작 되돌리기 (⌘Z) — 쌓인 판 ${draft.undoDepth}`} disabled={!draft.undoDepth} onClick={() => draft.stepHistory("undo")}>
            ↶
          </button>
          <button className="rc-btn" title="다시 적용 (⌘⇧Z)" disabled={!draft.redoDepth} onClick={() => draft.stepHistory("redo")}>
            ↷
          </button>
        </span>
        {/* 버튼은 성질로 묶는다. 왼쪽에서 오른쪽이 곧 작업 순서다:
              고치는 동안 반복하는 것 → 결과를 내고 확인하는 것 → 되돌리는 것.
            되돌리기·초기화를 맨 끝에 두는 것은 파괴적이기 때문이다 — 자주 누르는
            버튼 옆에 두면 언젠가 잘못 눌린다 */}
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
        {/* 실행본으로 가는 문. 기판이 직접 서빙하는 경로라 여기는 Link 가 아니라 생짜 a 가 맞다
            (앱 내부 경로였다면 basePath 때문에 Link 여야 한다) */}
        {status?.installed && pkg ? (
          <a className="rc-btn" style={{ textDecoration: "none" }} href={`/pkg/${pkg}/view/`} target="_blank" rel="noreferrer" title="지금 돌아가고 있는 판의 화면을 새 탭에서 엽니다">
            돌아가는 판 열기
          </a>
        ) : null}
        <button className="rc-btn" title="남에게 주거나 스토어에 올릴 수 있는 형태로 만듭니다" disabled={!status?.version.live} onClick={() => void draft.pack()}>
          내보내기
        </button>

        <span className="st-div" aria-hidden="true" />

        {/* 드물고 무거운 둘은 ⋯ 뒤에 — "되돌리기" 가 ⌘Z 되돌리기와 같은 말로 나란히 서 있었고
            그 옆이 복구 불가능한 "초기화" 였다. 메뉴는 이름 아래에 무엇을 하는지 한 줄을 단다 */}
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
      </div>

      <div className={`st-body${previewCtx ? " st-3" : ""}`}>
        <div className="rc-card st-left">
          {status && ctx ? (
            <button className="rc-btn accent st-make" onClick={() => setPalette(true)} title="이 앱에 무엇을 붙일 수 있는지 봅니다">
              ＋ 만들기
            </button>
          ) : null}
          {fatal ? (
            <div className="banner">{fatal}</div>
          ) : status ? (
            <DeclTree
              manifest={manifest}
              files={status.files}
              changes={status.changes}
              sec={sec}
              item={item}
              onSelect={(s, it) => nav({ sec: s, item: it ?? null, file: null })}
            />
          ) : (
            <div className="empty">
              <span className="rc-ring" /> draft 여는 중…
            </div>
          )}
        </div>

        <div className="rc-card st-canvas">
          <div className="st-crumb">
            <span className={!sec && !file ? "cur" : "lnk"} onClick={() => nav({ sec: null, item: null, file: null })}>
              {pkg}
            </span>
            {secDef || sec === "files" ? (
              <>
                <i>/</i>
                <span className={!item && !file ? "cur" : "lnk"} onClick={() => nav({ item: null, file: null })}>
                  {secDef?.label ?? "기타 파일"}
                </span>
              </>
            ) : null}
            {item ? (
              <>
                <i>/</i>
                <span className={!file ? "cur" : "lnk"} onClick={() => nav({ file: null })}>
                  {item}
                </span>
              </>
            ) : null}
            {file ? (
              <>
                <i>/</i>
                <span className="cur mono">{file}</span>
              </>
            ) : null}
            {buf?.dirty ? <span className="st-dot" title="저장 중" /> : null}
            {file ? (
              <button className="st-x" title="파일 삭제" onClick={() => draft.deleteFile(file)}>
                삭제
              </button>
            ) : null}
          </div>
          <div className="st-canvas-body">
            {fatal ? (
              <div className="empty">{fatal}</div>
            ) : !status ? (
              <div className="empty">
                <span className="rc-ring" />
              </div>
            ) : effFile ? (
              buf && buf.path === effFile ? (
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
                  <CodeEditor key={`${pkg}:${buf.path}`} path={buf.path} value={buf.content} onChange={draft.onEdit} marks={marks} />
                </>
              ) : (
                <div className="empty">
                  <span className="rc-ring" />
                </div>
              )
            ) : sec && ctx ? (
              <div className="st-scroll">
                <SectionView sec={sec} item={item} ctx={ctx} />
              </div>
            ) : !manifest ? (
              <div className="empty">relay.yaml 파싱 실패 — 개요 에디터에서 문법을 고치세요</div>
            ) : null}
          </div>
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
        </div>

        {palette && ctx && manifest && status ? (
          <Palette
            manifest={manifest}
            files={status.files}
            ctx={ctx}
            onMade={(m) => { setPalette(false); draft.onMade(m); }}
            onClose={() => setPalette(false)}
          />
        ) : null}

        {previewCtx ? (
          <div className="rc-card st-right">
            <div className="st-crumb">
              <span className="cur">결과</span>
              <span className="rc-chip gray">{FACE_OF[material]}</span>
              <span className="st-sp" />
              <span className="st-ver">발행 전 · 작업 사본</span>
            </div>
            <Preview ctx={previewCtx} material={material} />
          </div>
        ) : null}
      </div>

      {dialog === "commit" && pkg ? (
        <CommitDialog
          pkg={pkg}
          changedCount={changedCount}
          onDone={(line) => {
            say("ok", line);
            void draft.refresh();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "publish" && pkg ? (
        <PublishDialog
          pkg={pkg}
          draftVersion={status?.version.draft ?? null}
          installed={!!status?.installed}
          manifest={manifest}
          onDone={draft.onPublished}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "releases" && pkg ? (
        <ReleasesDialog
          pkg={pkg}
          onDone={(line) => {
            say("ok", line);
            void draft.refresh();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "discard" && pkg ? (
        <DiscardDialog pkg={pkg} installed={!!status?.installed} onDone={() => { notifyNav(); router.push("/"); }} onClose={() => setDialog(null)} />
      ) : null}
      {published && pkg ? (
        <PublishedDialog pkg={pkg} display={manifest?.display_name ?? pkg} outcome={published} onClose={() => draft.setPublished(null)} />
      ) : null}
    </div>
    </AgentScope>
  );
}

/** 시작 화면 — 만드는 중인 초안이 여기 선다. 종전에는 "콘솔에서 골라 들어오라" 한 줄뿐이라,
 *  적용 전에 탭을 닫은 초안으로 돌아갈 화면이 없었다(주소를 손으로 치는 수밖에) */
function Landing() {
  const [drafts, setDrafts] = useState<DraftEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    draftList()
      .then((r) => setDrafts(r.drafts))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, []);
  const pending = (drafts ?? []).filter((d) => !d.installed);
  const editing = (drafts ?? []).filter((d) => d.installed && d.changes > 0);
  const row = (d: DraftEntry, chip: string) => (
    <Link key={d.name} href={`/studio/?pkg=${encodeURIComponent(d.name)}`} className="st-draft">
      <b>{d.name}</b>
      <span className="rc-chip">{chip}</span>
      <span className="st-ver">
        {d.version ? `v${d.version}` : ""}
        {d.changes ? ` · 기록 안 한 변경 ${d.changes}건` : ""}
      </span>
    </Link>
  );
  return (
    <div className="st-shell">
      <div className="rc-card st-top">
        <Link href="/" className="st-back">
          ◀ 콘솔
        </Link>
        <b>스튜디오</b>
        <span className="st-sp" />
        <Link href="/studio/?new=1" className="rc-btn accent" style={{ textDecoration: "none" }}>
          새 패키지
        </Link>
      </div>
      <div className="rc-card st-landing">
        {drafts == null && !err ? <span className="rc-ring" /> : null}
        {err ? <div className="banner">{err}</div> : null}
        {pending.length ? (
          <div className="st-drafts">
            <div className="rc-label">만드는 중 — 아직 한 번도 적용하지 않은 패키지</div>
            {pending.map((d) => row(d, "초안"))}
          </div>
        ) : null}
        {editing.length ? (
          <div className="st-drafts">
            <div className="rc-label">수정 중 — 적용하지 않은 변경이 있는 패키지</div>
            {editing.map((d) => row(d, "수정 중"))}
          </div>
        ) : null}
        {drafts && !pending.length && !editing.length ? (
          <div className="empty">
            콘솔에서 패키지를 골라 들어오거나, <Link href="/studio/?new=1">새 패키지</Link>를 만드세요.
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 표시 이름에서 폴더 이름을 만든다 — 영문·숫자만 남기고 나머지는 하이픈. 한글만 있으면 빈 값 */
function slugOf(display: string): string {
  return display
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** 새 패키지 — 표시 이름과 한 줄 설명만 받는다. 폴더 이름은 표시 이름에서 만들고, 나머지는
 *  스튜디오 안의 [＋ 만들기]로 붙여 나간다. 첫 화면부터 내부 용어(draft·스캐폴드·하네스)를
 *  쓰지 않는다 — 팔레트의 말투와 같아야 한다 */
function Wizard({ onOpen }: { onOpen: (name: string) => void }) {
  const [display, setDisplay] = useState("");
  const [desc, setDesc] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirValue = (dirTouched ? dir : slugOf(display)).trim();
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(dirValue);
  const invalidDir = dirValue.length > 0 && !valid;
  const needsDir = display.trim().length > 0 && !dirTouched && !dirValue;

  return (
    <div className="st-shell">
      <div className="rc-card st-top">
        <Link href="/" className="st-back">
          ◀ 콘솔
        </Link>
        <b>새 패키지</b>
      </div>
      <div className="rc-card st-wizard">
        <div className="st-form" style={{ maxWidth: 480 }}>
          <label className="st-field">
            <span>이름</span>
            <input autoFocus placeholder="일기 비서" value={display} onChange={(e) => setDisplay(e.target.value)} />
          </label>
          <label className="st-field">
            <span>한 줄 설명 — 홈 카드에 그대로 보입니다</span>
            <input placeholder="하루를 정리해 일기로 남깁니다" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <label className="st-field">
            <span>폴더 이름 — 주소와 파일 위치에 쓰입니다 (영문 소문자, 숫자, 하이픈)</span>
            <input
              placeholder="diary"
              value={dirTouched ? dir : dirValue}
              onChange={(e) => {
                setDirTouched(true);
                setDir(e.target.value);
              }}
              aria-invalid={invalidDir}
              aria-describedby="new-package-dir-help"
            />
            <div id="new-package-dir-help" className={invalidDir ? "gx-err" : "st-hint"}>
              {invalidDir
                ? "영문 소문자, 숫자, 하이픈(-)만 쓸 수 있습니다. 한글은 폴더 이름에 쓸 수 없습니다."
                : needsDir
                  ? "이름이 한글이라 폴더 이름을 만들지 못했습니다 — 영문으로 짧게 적어 주세요 (예: diary)."
                  : "이름에서 자동으로 만듭니다. 고쳐도 됩니다."}
            </div>
          </label>
          <div className="st-hint">
            만들면 대화 상대 하나와 기본 실행 도구가 함께 준비됩니다. 화면, 기능, 폴더, 예약은 만든 뒤 왼쪽 [＋ 만들기]에서 붙입니다.
          </div>
          {err ? <div className="gx-err">{err}</div> : null}
          <button
            className="rc-btn accent"
            disabled={!valid || busy}
            onClick={async () => {
              const name = dirValue;
              const shown = display.trim() || name;
              setBusy(true);
              setErr(null);
              try {
                await draftOpen(name, {
                  manifest: {
                    schema: "relay/v1",
                    name: `@local/${name}`,
                    version: "0.1.0",
                    display_name: shown,
                    description: desc.trim() || shown,
                    agents: [{ name, persona: `agents/${name}/AGENT.md`, greeting: "무엇을 도와드릴까요?" }],
                  },
                });
                notifyNav();
                onOpen(name);
              } catch (e) {
                setErr(String(e instanceof Error ? e.message : e));
                setBusy(false);
              }
            }}
          >
            {busy ? "만드는 중…" : "만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}

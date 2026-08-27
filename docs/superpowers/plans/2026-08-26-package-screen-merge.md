# 패키지 화면 하나 (콘솔 상세 + 스튜디오 합치기) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/?p=<이름>&face=detail` 하나가 읽기·고치기·파일 세 층을 다 갖고, `/studio` 는 리다이렉트만 남는다.

**Architecture:** 1단계에서 `app/studio/page.tsx` 의 상태·동작을 `lib/useDraft.ts` 훅으로 옮긴다(UI 무변화). 2단계에서 콘솔의 상세 탭(`DetailFace`)이 그 훅을 써서 설명서 줄 아래에 기존 섹션 폼·결과면을 펼치고, 파일은 몸 전체 에디터로 연다. 스펙: `docs/superpowers/specs/2026-08-26-package-screen-merge-design.md`.

**Tech Stack:** Next 16 static export · React 19 · TypeScript · node:test (순수 로직만).

**굽기는 항상 `npm run relay -- build system`.** 데몬은 4747 에서 돌고 있다(`/pkg/system/view/`). 스크린샷: `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1280,1100 --virtual-time-budget=6000 --screenshot=<scratch>/x.png '<url>'`.

---

## File map

**1단계**
- Create `lib/verdict.ts` — `fixTargetOf` (page.tsx 60-67행에서 이동)
- Create `lib/useDraft.ts` — 훅
- Modify `app/studio/page.tsx` — 훅을 쓰는 껍데기

**2단계**
- Modify `lib/describe.ts` + `lib/describe.test.ts` — 줄 확장, `editing`
- Modify `components/Describe.tsx` — 버튼 줄 + 펼침 children
- Create `components/DraftActions.tsx` — 머리 버튼·다이얼로그·⋯ 메뉴
- Create `components/EditorPanel.tsx` — 돌아가기 줄·충돌 배너·CodeEditor
- Create `components/DraftConsole.tsx` — 콘솔 띠
- Create `components/DetailFace.tsx` — 합쳐진 상세 (PkgPane 에서 분리)
- Create `components/NewPackage.tsx` — Wizard (page.tsx 에서 이동)
- Modify `components/PkgPane.tsx` — DetailFace 를 밖에서 가져오고 머리에 액션 슬롯
- Modify `app/page.tsx` — `?new=1`, draft 전용 패키지 합성
- Modify `app/studio/page.tsx` — 리다이렉트만
- Modify `app/playground/page.tsx`, `components/Detail.tsx`, `packages/system/agents/agent-builder/AGENT.md` — 링크
- Modify `runner/runtime/shell.ts` — 링크 셋
- Delete `components/DeclTree.tsx`; `app/globals.css` 에서 스튜디오 셸 CSS 제거

---

## 1단계 — 스튜디오 기계를 훅으로

### Task 1: `lib/verdict.ts`

**Files:** Create `packages/system/surfaces/view/lib/verdict.ts`; Modify `app/studio/page.tsx`

- [ ] **Step 1: 파일 생성** — page.tsx 의 `IDENTITY_KEYS` 와 `fixTargetOf` 를 그대로 옮긴다

```ts
import { SECTIONS } from "./sections";

// 판정의 path(예: "agents[0].persona") 를 고치러 갈 자리(섹션·항목)로. 판정은 원인만 말하므로
// 화면이 문을 붙인다 — 좌표가 있을 때만
const IDENTITY_KEYS = new Set(["name", "version", "display_name", "description", "icon", "schema"]);

export function fixTargetOf(path: string | null): { sec: string; item: string | null; label: string } | null {
  if (!path) return null;
  const [first, second] = path.split(".");
  const def = IDENTITY_KEYS.has(first) ? SECTIONS.find((d) => d.key === "identity") : SECTIONS.find((d) => d.yamlKey === first || d.key === first);
  if (!def) return null;
  const item = second && def.items ? second.replace(/\[.*$/, "") : null;
  return { sec: def.key, item: item || null, label: `고치러 가기 → ${def.label}${item ? ` · ${item}` : ""}` };
}
```

(`IDENTITY_KEYS` 의 실제 내용은 page.tsx 에서 복사한다 — 위는 예시이며 원본이 정본.)

- [ ] **Step 2: page.tsx 에서 둘을 지우고 `import { fixTargetOf } from "@/lib/verdict";`**
- [ ] **Step 3: 타입 확인** — `cd packages/system/surfaces/view && npx tsc --noEmit -p .` → 출력 없음
- [ ] **Step 4: Commit** — `git commit -m "refactor(view): fixTargetOf 를 lib/verdict 로"`

### Task 2: `lib/useDraft.ts`

**Files:** Create `packages/system/surfaces/view/lib/useDraft.ts`

- [ ] **Step 1: 훅 작성.** page.tsx `Studio()` 의 87~430행(상태 선언부터 `onPublished` 까지)을 옮긴다. 인터페이스:

```ts
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAgentTurn } from "@relay/chat";
import { parse as parseYaml, parseDocument } from "yaml";
import type { Mark } from "@/components/CodeEditor";
import { materialOf, type PreviewCtx } from "@/components/Preview";
import type { SectionCtx } from "@/components/SectionView";
import { fetchRegistry } from "@/lib/api";
import type { Made } from "@/lib/create";
import { SECTIONS } from "@/lib/sections";
import { draftList, draftOpen, draftRead, draftReadFile, draftValidate, draftWrite, fetchSchema, packPkg, type DraftStatus, type PublishOutcome, type Verdict } from "@/lib/studio";
import type { Manifest, Registry } from "@/lib/types";

export type LogLine = { kind: "ok" | "err" | "info"; text: string; href?: string };
export type View = { sec: string | null; item: string | null; file: string | null };
export type Nav = (q: { sec?: string | null; item?: string | null; file?: string | null }) => void;

export interface Draft {
  status: DraftStatus | null;
  fatal: string | null;
  manifest: Manifest | null;
  schema: any;
  reg: Registry | null;
  buf: { path: string; content: string; dirty: boolean } | null;
  effFile: string | null;
  marks: Mark[];
  issues: string[] | null;
  verdicts: Verdict[];
  log: LogLine[];
  consoleOpen: boolean;
  setConsoleOpen(v: boolean): void;
  conflict: string | null;
  agentBusy: boolean;
  undoDepth: number;
  redoDepth: number;
  rev: string;
  ctx: SectionCtx | null;
  previewCtx: PreviewCtx | null;
  material: ReturnType<typeof materialOf>;
  changedCount: number;
  /** draft 를 연다(설치본 사본 또는 기존 draft). 이름이 장부에도 draft 목록에도 없으면 fatal */
  open(): Promise<void>;
  refresh(): Promise<void>;
  onEdit(text: string): void;
  stepHistory(dir: "undo" | "redo"): void;
  validate(): Promise<void>;
  pack(): Promise<void>;
  onPublished(r: PublishOutcome): void;
  conflictReload(): void;
  conflictOverwrite(): void;
  deleteFile(path: string): void;
  say(kind: LogLine["kind"], text: string, href?: string): void;
  onMade(made: Made): void;
}

export function useDraft(pkg: string | null, view: View, nav: Nav): Draft
```

옮길 때 바뀌는 것 **넷뿐**:
1. `sec · item · file` 은 `useSearchParams` 대신 `view` 인자에서 읽는다. `nav` 는 인자.
2. "진입 = draft 열기" `useEffect` 는 **없앤다.** 그 본문이 `open()` 이 된다(`known` 판정 포함). 대신 `pkg` 가 바뀌면 `status · fatal · buf · undo · redo · issues · verdicts · log` 를 초기화하는 effect 하나를 둔다.
3. `deleteFile(path)` 을 새로 만든다 — page.tsx 크럼의 "삭제" 버튼 onClick 본문(`draftWrite(pkg, {}, [path])` → say → `nav({ file: null })` → refresh).
4. `material · marks · rev · previewCtx · changedCount` 계산(page.tsx 437~449행)을 훅 안 `useMemo` 로 가져와 반환한다. `secDef` 는 `SECTIONS.find((s) => s.key === view.sec)`.

⌘Z 키 리스너와 `relay:turn` 구독은 훅 안에 그대로 둔다(패키지 화면에서도 같은 행동이 맞다).

- [ ] **Step 2: page.tsx 를 껍데기로.** `Studio()` 가 다음만 남긴다:

```tsx
const draft = useDraft(pkg, { sec, item, file }, nav);
useEffect(() => { if (pkg) void draft.open(); /* eslint-disable-line */ }, [pkg]);
const [dialog, setDialog] = useState<Dialog>(null);
const [palette, setPalette] = useState(false);
const [more, setMore] = useState(false);
```

이하 JSX 는 `status → draft.status` 식으로 참조만 바꾼다. `reg` 도 훅에서 온다(`loadReg` 는 훅 안).

- [ ] **Step 3: 타입 확인** — `npx tsc --noEmit -p .` → 출력 없음
- [ ] **Step 4: 굽고 눈으로** — `npm run relay -- build system`, 스크린샷 `/pkg/system/view/studio/?pkg=ad-creative&sec=triggers` — 트리·폼·결과면·콘솔 띠가 전과 같다. 폼 한 칸 고치기 → ⌘Z 가 되는지는 빌드 뒤 브라우저에서 사람이 한 번 본다(자동화 없음, 계획에 명시).
- [ ] **Step 5: Commit** — `git commit -m "refactor(view): 스튜디오의 기계를 useDraft 훅으로 — 화면은 그대로"`

---

## 2단계 — 패키지 화면

### Task 3: 설명서 줄 확장

**Files:** Modify `lib/describe.ts`, `lib/describe.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
test("describe — editing 이면 모든 섹션이 줄을 갖는다", () => {
  const rows = describe({}, { workspace: "/w", scripts: [], edges: [], landing: null, activeHarness: null, labelOf: (n) => n, files: [] }, { editing: true });
  assert.deepEqual(rows.map((r) => r.key), ["identity", "verbs", "when", "dirs", "talk", "faces", "links", "missions", "engine", "needs", "host", "org", "files"]);
  assert.equal(byKey(rows, "identity").items[0].text, "(이름 없음)");
  assert.equal(byKey(rows, "engine").empty, "아직 없음");
  assert.equal(byKey(rows, "host").advanced, true);
});

test("describe — 보기만 할 때는 빈 고급 줄을 생략한다", () => {
  const rows = describe({ name: "@local/x", version: "1.2.0" }, { workspace: "/w", scripts: [], edges: [], landing: null, activeHarness: null, labelOf: (n) => n, files: ["relay.yaml", "notes.txt"] });
  assert.deepEqual(rows.map((r) => r.key), ["identity", "verbs", "when", "dirs", "talk", "faces", "links", "missions", "files"]);
  assert.deepEqual(byKey(rows, "identity").items, [{ text: "@local/x", sub: "1.2.0" }]);
  assert.deepEqual(byKey(rows, "files").items, [{ text: "notes.txt" }]);
});

test("describe — faces 줄", () => {
  const m: Manifest = { surfaces: { view: { source: "view" }, components: { source: "parts" }, channels: [{ name: "slack", source: "c", entry: "run" }] } };
  const rows = describe(m, { workspace: "/w", scripts: [], edges: [], landing: null, activeHarness: null, labelOf: (n) => n, files: [] });
  assert.deepEqual(byKey(rows, "faces").items, [{ text: "화면", sub: "view" }, { text: "끼울 부품", sub: "parts" }, { text: "slack", sub: "채널" }]);
  assert.deepEqual(byKey(rows, "talk").items, []); // 채널은 faces 로 옮겼다
});
```

기존 "일기 비서" 테스트의 기대값 갱신: `keys` 에 `identity · faces · missions · files`(files 는 비면 생략) 반영, `talk` 는 `["이 화면"]` 만.

- [ ] **Step 2: 실패 확인** — `npm test` → 새 세 테스트 FAIL
- [ ] **Step 3: 구현** — `describe.ts`:

```ts
export interface Row {
  key: "identity" | "verbs" | "when" | "dirs" | "talk" | "faces" | "links" | "missions" | "engine" | "needs" | "host" | "org" | "files";
  q: string;
  items: RowItem[];
  empty?: string;
  sec: string;
  /** 고급 — 접힌 묶음 아래 */
  advanced?: boolean;
}
export interface DescribeCtx { /* 기존 + */ files: string[] }

export function describe(m: Manifest, ctx: DescribeCtx, opt: { editing?: boolean } = {}): Row[]
```

줄 순서와 재료 (스펙 표): identity = `{ text: m.name ?? "(이름 없음)", sub: m.version }`; talk = `[이 화면?, ...agents 이름]` (채널 제외); faces = view → `{ text: "화면", sub: source }`, components → `{ text: "끼울 부품", sub: source }`, channels → `{ text: name, sub: "채널" }`; missions = `{ text: name, sub: description }`; host = `host_methods` 각각; org = `m.org ? [{ text: "있음" }] : []`; files = `unclaimedFiles(m, ctx.files)` (lib/sections 에서 import — 값 import 지만 sections.ts 는 `./types` 만 import 하므로 node 로도 돈다) → `{ text }`.
`empty`: verbs/when/talk/links 는 기존 문구, 나머지는 "아직 없음". `advanced: true` — host · org · files.
생략 규칙: `editing` 이 아니고 `items` 가 비면 engine · needs · host · org · files 는 뺀다. 그 외 줄은 항상 있다.

- [ ] **Step 4: 통과** — `npm test` → 전부 pass
- [ ] **Step 5: Commit** — `git commit -m "feat(view): 설명서가 모든 선언에 줄을 낸다 — 2층으로 가는 문"`

### Task 4: Describe — 펼침

**Files:** Modify `components/Describe.tsx`, `app/globals.css`

- [ ] **Step 1: 컴포넌트**

```tsx
"use client";
import { useState } from "react";
import type { Row } from "@/lib/describe";

export default function Describe({
  rows, open, onToggle, trailing, children,
}: {
  rows: Row[];
  /** 펼친 줄의 sec (URL 의 sec) */
  open: string | null;
  onToggle: (sec: string) => void;
  trailing?: Partial<Record<Row["key"], React.ReactNode>>;
  /** 펼친 줄 아래에 그릴 것 */
  children?: React.ReactNode;
}) {
  const [advOpen, setAdvOpen] = useState(false);
  const main = rows.filter((r) => !r.advanced);
  const adv = rows.filter((r) => r.advanced);
  const advShown = advOpen || adv.some((r) => r.sec === open);
  const row = (r: Row) => (
    <div key={r.key} className={`ds-sec${r.sec === open ? " open" : ""}`}>
      <button type="button" className="ds-row" onClick={() => onToggle(r.sec)} aria-expanded={r.sec === open}>
        <span className="ds-q">{r.q}</span>
        <span className="ds-a">
          {r.items.length ? r.items.map((it, i) => (
            <span key={i} className="ds-item">{it.text}{it.sub ? <span className="ds-sub">{it.sub}</span> : null}</span>
          )) : <span className="ds-empty">{r.empty}</span>}
          {trailing?.[r.key] ?? null}
        </span>
        <span className="ds-caret">{r.sec === open ? "▾" : "▸"}</span>
      </button>
      {r.sec === open ? <div className="ds-x">{children}</div> : null}
    </div>
  );
  return (
    <div className="ds">
      {main.map(row)}
      {adv.length ? (
        <>
          <button type="button" className="ds-row ds-adv" onClick={() => setAdvOpen((v) => !v)}>
            <span className="ds-q">고급</span><span className="ds-a ds-empty">거의 손대지 않는 선언</span><span className="ds-caret">{advShown ? "▾" : "▸"}</span>
          </button>
          {advShown ? adv.map(row) : null}
        </>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: CSS** — 기존 `.ds-row` 를 버튼용으로 바꾸고 펼침을 더한다:

```css
.ds-row { display: flex; gap: 14px; padding: 10px 6px; border: none; border-bottom: 1px solid var(--rc-line-soft); background: none; width: 100%; text-align: left; color: inherit; font: inherit; border-radius: 8px; cursor: pointer; }
.ds-row:hover { background: var(--rc-hover); }
.ds-sec.open > .ds-row { background: var(--rc-accent-soft); border-bottom-color: transparent; }
.ds-caret { color: var(--rc-faint); font-size: 11px; padding-top: 3px; }
.ds-adv .ds-q { color: var(--rc-faint); }
.ds-x { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(360px, 1fr); gap: 12px; padding: 12px 6px 16px; border-bottom: 1px solid var(--rc-line-soft); }
.ds-x > .rc-card { min-height: 0; overflow: auto; max-height: 60vh; }
@media (max-width: 1100px) { .ds-x { grid-template-columns: 1fr; } }
```

`.ds-sec:last-child > .ds-row { border-bottom: none; }` 도 추가.

- [ ] **Step 3: 타입 확인.** PkgPane 은 아직 옛 props 로 부르므로 tsc 가 실패한다 — Task 6 에서 함께 고친다. 여기서는 커밋하지 않고 Task 6 과 묶는다.

### Task 5: DraftActions · EditorPanel · DraftConsole

**Files:** Create 셋. page.tsx 의 JSX 를 오려낸다.

- [ ] **Step 1: `DraftActions.tsx`** — page.tsx `st-top` 의 ↶↷·검사·기록·적용·돌아가는 판·내보내기·⋯ 메뉴와 네 다이얼로그 렌더를 옮긴다.

```tsx
export default function DraftActions({ pkg, draft, onOpenPalette }: { pkg: string; draft: Draft; onOpenPalette: () => void }) 
```
안에서 `dialog · more` 상태를 갖는다. `[＋ 만들기]` 버튼도 여기(`onOpenPalette`). 다이얼로그의 `onDone`/`onClose` 는 page.tsx 와 같다(`draft.say`, `draft.refresh`, `draft.onPublished`, discard 뒤 `router.push("/")` 대신 **`onDiscarded` prop** 으로 알린다 — 패키지 화면은 설치본으로 돌아가고 스튜디오는 홈으로 간다).

- [ ] **Step 2: `EditorPanel.tsx`** — 크럼(◀ 돌아가기 · 경로 · 저장 점 · 삭제) + 충돌 배너 + CodeEditor.

```tsx
export default function EditorPanel({ draft, onBack }: { draft: Draft; onBack: () => void })
```
`draft.buf?.path === draft.effFile` 이 아니면 스피너. 삭제는 `draft.deleteFile(draft.effFile)`.

- [ ] **Step 3: `DraftConsole.tsx`** — page.tsx 의 `st-console` 블록을 그대로. props `{ draft, nav }`.
- [ ] **Step 4: page.tsx 가 셋을 쓰도록 바꾸고** `npx tsc` → 출력 없음(Describe 는 아직 page.tsx 가 안 쓴다).
- [ ] **Step 5: 굽고 스튜디오 스크린샷** — 전과 같아야 한다.
- [ ] **Step 6: Commit** — `git commit -m "refactor(view): 스튜디오 조각 셋을 컴포넌트로 — 액션·에디터·콘솔"`

### Task 6: DetailFace 합치기

**Files:** Create `components/DetailFace.tsx`; Modify `components/PkgPane.tsx`

- [ ] **Step 1: `DetailFace.tsx`** — PkgPane 의 `DetailFace` 를 옮기며 아래로 바꾼다.

```tsx
export default function DetailFace({ pkg, reg, edges, view, nav, onChanged, onGone, actionsSlot }: {
  pkg: Pkg; reg: Registry; edges: EdgeView[];
  view: View; nav: Nav;
  onChanged: () => void; onGone: () => void;
  /** 머리 오른쪽에 액션을 꽂는 포털 대상 */
  actionsSlot: HTMLElement | null;
})
```

- `const draft = useDraft(pkg.name, view, nav);`
- 마운트 시 `draftList()` 로 이 이름의 draft 가 있으면 `draft.open()`. (설치 안 된 합성 Pkg 는 `pkg.workspace === ""` 로 알아본다 — 항상 open.)
- `editing = draft.status != null`. 설명서 재료: `m = editing ? draft.manifest : pkg.manifest`, `files = draft.status?.files ?? []`(설치본일 때 동사 이름은 기존 `pkg-read` 경로 유지), `describe(m, ctx, { editing })`.
- 줄 클릭: `onToggle(sec)` → `editing` 이 아니면 `draft.open().then(() => nav({ sec }))`, 이미 열렸으면 `nav({ sec: view.sec === sec ? null : sec, item: null, file: null })`.
- 펼침 children: `<div className="rc-card"><div className="st-scroll"><SectionView sec={view.sec} item={view.item} ctx={draft.ctx} /></div></div>` + `draft.previewCtx ? <div className="rc-card st-right"><Preview ctx={draft.previewCtx} material={draft.material} /></div> : null`. 항목이 열려 있으면 SectionView 위에 크럼 한 줄 `‹ 목록` (`nav({ item: null })`).
- `view.file` 이 있으면 몸 전체가 `<EditorPanel draft={draft} onBack={() => nav({ file: null })} />` (설명서·콘솔 띠 대신).
- 콘솔 띠 `<DraftConsole draft={draft} nav={nav} />` 는 `editing` 일 때만, 하단 액션 위.
- 머리 액션: `actionsSlot` 에 `createPortal(editing ? <DraftActions pkg={pkg.name} draft={draft} onOpenPalette={() => setPalette(true)} onDiscarded={...} /> : <button className="rc-btn" onClick={() => void draft.open()}>고치기</button>, actionsSlot)`.
- 팔레트: `palette && draft.ctx ? <Palette manifest={draft.manifest!} files={draft.status!.files} ctx={draft.ctx} onMade={(m) => { setPalette(false); draft.onMade(m); }} onClose={() => setPalette(false)} /> : null`.
- 칩: `editing ? (draft.changedCount ? "수정 n건 · 아직 적용 안 됨" : "변경 없음") : null` — 기존 draftList 기반 칩은 없앤다(훅이 안다).
- 승인 버튼·"이 앱을 쓰는 앱"·하단(폴더 열기·제거)은 그대로. 합성 Pkg(`workspace === ""`)면 "데이터 폴더 열기"와 "제거"를 숨긴다.
- `onDiscarded`: 합성 Pkg 면 `onGone()`, 아니면 `nav({ sec: null, item: null, file: null })` 후 상태 초기화(훅의 pkg-변경 초기화를 위해 `key` 를 바꾸는 대신 `draft.refresh()` 가 fatal 을 내면 설치본으로 남는다 — 간단히 `location.reload()` 하지 않는다: `draft.status` 를 null 로 만드는 `close()` 를 훅에 추가한다).

훅에 `close(): void` 추가 — status·buf·undo·redo·issues·verdicts 초기화.

- [ ] **Step 2: PkgPane** — `DetailFace` 를 import 하고, 머리 `.right` 앞에 `<span ref={setSlot} className="pane-actions" />` 를 두어 `actionsSlot` 으로 넘긴다. `view`/`nav` 는 props 로 받는다(app/page.tsx 가 URL 에서 읽어 준다). 옛 DetailFace 본문·import(`Describe`, `describe`, `scriptNamesFromTree`, `draftList`, `callScript` 중 안 쓰는 것) 정리.
- [ ] **Step 3: app/page.tsx** — `sec · item · file` 을 읽어 `view` 로, `nav` 는 `/?p=&face=detail&sec=&item=&file=` 를 만든다(스튜디오 `nav` 와 같은 규칙, `p`/`face` 유지). `goFace` 는 sec·item·file 을 버린다.
- [ ] **Step 4: CSS** — `.pane-actions { display: inline-flex; gap: 6px; align-items: center; margin-left: auto; }` 와 `.pane-head .right { margin-left: 0 }` 조정. 에디터가 몸을 차지할 때 `.pane-body.editor { padding: 0; gap: 0; }`.
- [ ] **Step 5: tsc → 출력 없음. 굽기. 스크린샷 셋:** `?p=ad-creative&face=detail` (설치본, 고치기 버튼) · `?p=ad-creative&face=detail&sec=triggers` (펼침 — 폼 + 결과면) · `&sec=agents&item=ad-creative&file=agents/ad-creative/AGENT.md` (에디터).
- [ ] **Step 6: Commit** — `git commit -m "feat(shell): 패키지 화면이 세 층이 된다 — 설명서 줄 아래로 폼과 결과면, 파일은 전면"`

### Task 7: 새 패키지 · 설치 안 된 draft

**Files:** Create `components/NewPackage.tsx`; Modify `app/page.tsx`

- [ ] **Step 1: `NewPackage.tsx`** — page.tsx 의 `Wizard` 를 그대로 옮긴다(`onOpen(name)`).
- [ ] **Step 2: app/page.tsx** — `sp.get("new") === "1"` 이면 `<NewPackage onOpen={(n) => router.replace(`/?p=${encodeURIComponent(n)}&face=detail`)} />`.
- [ ] **Step 3: draft 전용 합성** — `load()` 에서 `draftList()` 도 받아 `drafts` 상태로. `selected` 가 없고 `drafts` 에 있으면:

```ts
const ghost: Pkg = { name: sel, path: "", workspace: "", ring: null, model: null, harness: null, manifest: null, error: null };
```
PkgPane 에 넘긴다. PkgPane 머리는 `manifest` 가 null 이면 DetailFace 가 draft 를 열어 알게 된 `display_name` 을 쓰도록 — DetailFace 가 `onTitle(display: string | null, version: string | null)` 콜백으로 올려 보내고 PkgPane 이 상태로 갖는다. 버전 자리는 "미발행". 탭은 "상세"만.

- [ ] **Step 4: tsc · 굽기 · 스크린샷** `/?new=1` 과 `?p=<만드는 중인 초안 이름>&face=detail`(초안 이름은 `curl -s localhost:4747/shell/nav | jq .drafts` 로).
- [ ] **Step 5: Commit** — `git commit -m "feat(shell): 새 패키지와 만드는 중인 초안도 같은 패키지 화면"`

### Task 8: 리다이렉트와 링크

**Files:** Modify `app/studio/page.tsx`, `app/playground/page.tsx`, `components/Detail.tsx`, `packages/system/agents/agent-builder/AGENT.md`, `runner/runtime/shell.ts`

- [ ] **Step 1: `app/studio/page.tsx`** 전체를 교체:

```tsx
"use client";
import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
// 스튜디오는 패키지 화면의 층이 되었다(docs/superpowers/specs/2026-08-26-package-screen-merge-design.md).
// 옛 주소를 들고 오는 링크(빌더의 답, 북마크)를 새 자리로 보낸다
export default function StudioRedirect() { return <Suspense fallback={null}><Go /></Suspense>; }
function Go() {
  const router = useRouter(); const sp = useSearchParams();
  useEffect(() => {
    if (sp.get("new") === "1") { router.replace("/?new=1"); return; }
    const pkg = sp.get("pkg");
    if (!pkg) { router.replace("/"); return; }
    const q = new URLSearchParams({ p: pkg, face: "detail" });
    for (const k of ["sec", "item", "file"]) { const v = sp.get(k); if (v) q.set(k, v); }
    router.replace(`/?${q.toString()}`);
  }, [router, sp]);
  return null;
}
```

- [ ] **Step 2:** playground `router.replace("/?new=1")`; Detail.tsx 링크 `href={`/?p=${encodeURIComponent(pkg.name)}&face=detail`}`; AGENT.md 30행 `[스튜디오에서 보기](/pkg/system/view/studio/?pkg=<디렉토리 이름>)` → `[고치기](/pkg/system/view/?p=<디렉토리 이름>&face=detail)`.
- [ ] **Step 3: shell.ts** — 196행 `consoleHref(`?p=${encodeURIComponent(name)}&face=detail`)`, 200행 `create: consoleHref("?new=1")`, 202행 `studio: "/"`. 555행 홈의 "스튜디오에서 이어서 만들기" 앵커 제거. 485행 사이드바 "만드는 중" 의 title 을 "만드는 중인 초안 — 홈에서 고릅니다" 로.
- [ ] **Step 4:** `npm run typecheck` (루트, shell.ts) · `npm test` · view tsc · 굽기. `curl -s localhost:4747/shell/nav | jq '{create, studio, drafts}'` 로 링크 확인(데몬은 재시작해야 shell.ts 변경이 실린다 — **재시작은 사용자에게 알리고 한다**; 안 되면 링크는 코드로만 확인).
- [ ] **Step 5: Commit** — `git commit -m "feat(shell): /studio 는 리다이렉트 — 사이드바·홈·빌더의 문이 패키지 화면으로"`

### Task 9: 죽은 것 정리

**Files:** Delete `components/DeclTree.tsx`; Modify `app/globals.css`, `app/studio/page.tsx` 는 이미 작음

- [ ] **Step 1:** `grep -rn 'DeclTree' packages/system/surfaces/view --include=*.tsx` → 참조 없음 확인 후 삭제.
- [ ] **Step 2:** globals.css 에서 `.st-shell · .st-top · .st-back · .st-ver · .st-commit · .st-body · .st-body.st-3 · .st-left · .st-make · .st-canvas · .st-canvas-body · .st-tree · .st-node* · .st-count · .st-add · .st-badge · .st-crumb* · .st-x · .st-wizard(있으면)` 제거. **남기는 것**: `.st-sp · .st-undo · .st-right · .st-scroll · .st-editor · .st-dot · .st-section · .st-hint · .st-form · .st-field · .st-files · .st-file* · .st-console* · .st-last · .st-caret · .st-issues · .st-issue · .st-more · .st-menu · .st-div · .lv* · .pv*`. 지우기 전에 각 클래스를 `grep -rn 'st-<이름>' components app` 으로 확인한다 — 하나라도 쓰이면 남긴다.
- [ ] **Step 3:** 관문 셋 + 굽기 + 스크린샷 세 장 다시.
- [ ] **Step 4: Commit** — `git commit -m "chore(view): 스튜디오 셸의 잔해 정리 — 트리와 그 CSS"`

---

## Self-review

- 스펙 커버리지: 세 층 ✓(T6) · live/draft 규칙 ✓(T6) · 설치 안 된 draft ✓(T7) · 새 패키지 ✓(T7) · 리다이렉트 ✓(T8) · 사이드바 링크 ✓(T8) · 줄 확장 ✓(T3) · 삭제 목록 ✓(T9) · 테스트 ✓(T3, 스크린샷 T2/T6/T7/T9)
- 훅 인터페이스(`Draft`)의 이름을 T5·T6 이 그대로 쓴다. `close()` 는 T6 에서 추가하기로 명시.
- 데몬 재시작은 상태 변경 — 사용자 확인 후.

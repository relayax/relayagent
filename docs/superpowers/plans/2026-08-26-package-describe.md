# 패키지 설명서 (콘솔 상세 탭 1층) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 콘솔 패키지 창의 "상세" 탭을 매니페스트 어휘 대신 사람 말 질문-답 목록으로 바꾼다.

**Architecture:** `lib/describe.ts` 가 매니페스트(+ 컨텍스트)를 `Row[]` 로 번역하는 순수 함수, `components/Describe.tsx` 가 그것을 그린다. `PkgPane.tsx` 의 `DetailFace` 본문이 `Describe` 로 바뀌고 하단 액션(스튜디오·폴더·제거)과 연결 승인은 남는다. 스펙: `docs/superpowers/specs/2026-08-26-package-describe-design.md`.

**Tech Stack:** Next 16 (static export) · React 19 · TypeScript. 순수 로직 테스트는 `node --experimental-strip-types --test` (node:test) — view 패키지에는 테스트 러너가 없으므로 이 파일은 `@/` alias 없이 상대 경로·타입 전용 import 만 쓴다.

**주의:** 화면 확인은 반드시 `npm run relay -- build system` 으로 굽는다 (CLAUDE.md — 손으로 `next build` 하면 basePath 가 빠져 조용히 깨진다).

---

## File map

- Modify `packages/system/surfaces/view/tsconfig.json` — `allowImportingTsExtensions: true` (테스트가 `./describe.ts` 를 import 하기 위해; `noEmit: true` 라 합법)
- Create `packages/system/surfaces/view/lib/describe.ts` — `cronToKorean` · `scriptNamesFromTree` · `providerLabel` · `describe`
- Create `packages/system/surfaces/view/lib/describe.test.ts`
- Create `packages/system/surfaces/view/components/Describe.tsx`
- Modify `packages/system/surfaces/view/components/PkgPane.tsx` — `DetailFace`
- Modify `packages/system/surfaces/view/app/globals.css` — `.ds-*`
- Modify root `package.json` — `test` 에 view 의 describe 테스트 추가

---

### Task 1: cron 번역기

**Files:**
- Modify: `packages/system/surfaces/view/tsconfig.json`
- Create: `packages/system/surfaces/view/lib/describe.ts`
- Create: `packages/system/surfaces/view/lib/describe.test.ts`

- [ ] **Step 1: tsconfig 에 `.ts` 확장자 import 허용**

`compilerOptions` 에 한 줄 추가:

```json
    "allowImportingTsExtensions": true,
```

- [ ] **Step 2: 실패하는 테스트**

`packages/system/surfaces/view/lib/describe.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronToKorean } from "./describe.ts";

test("cronToKorean — 스펙의 표", () => {
  assert.equal(cronToKorean("0 22 * * *"), "매일 밤 10시");
  assert.equal(cronToKorean("30 9 * * *"), "매일 오전 9시 30분");
  assert.equal(cronToKorean("0 9 * * 1-5"), "평일 오전 9시");
  assert.equal(cronToKorean("0 14 * * 1"), "매주 월요일 오후 2시");
  assert.equal(cronToKorean("*/15 * * * *"), "15분마다");
  assert.equal(cronToKorean("0 */2 * * *"), "2시간마다");
  assert.equal(cronToKorean("0 0 1 * *"), null); // 매달 — 번역표 밖. 짐작하지 않는다
  assert.equal(cronToKorean("garbage"), null);
});
```

- [ ] **Step 3: 실패 확인**

Run: `node --experimental-strip-types --test packages/system/surfaces/view/lib/describe.test.ts`
Expected: FAIL — `Cannot find module .../describe.ts`

- [ ] **Step 4: 구현**

`packages/system/surfaces/view/lib/describe.ts`:

```ts
import type { EdgeView, Manifest } from "./types";

// 매니페스트 → 사람 말. 콘솔 상세 탭의 1층 "읽기"가 이 줄들을 그린다. 순수 함수 — 화면 밖에서
// 시험한다. 여기에는 매니페스트 어휘(agents · scripts · edges …)가 답에 나오면 안 된다.

const DAY = ["일", "월", "화", "수", "목", "금", "토"];

function hourWord(h: number, m: number): string {
  const ampm = h < 12 ? "오전" : h < 18 ? "오후" : "밤";
  const hh = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${ampm} ${hh}시${m ? ` ${m}분` : ""}`;
}

/** 번역표에 있는 cron 만 사람 말로. 없으면 null — 원문을 보여주는 것이 짐작보다 낫다 */
export function cronToKorean(expr: string): string | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*") return null;
  const every = (x: string) => (/^\*\/\d+$/.test(x) ? Number(x.slice(2)) : null);
  if (every(min) != null && hour === "*" && dow === "*") return `${every(min)}분마다`;
  if (min === "0" && every(hour) != null && dow === "*") return `${every(hour)}시간마다`;
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
  const m = Number(min), h = Number(hour);
  if (m > 59 || h > 23) return null;
  const at = hourWord(h, m);
  if (dow === "*") return `매일 ${at}`;
  if (dow === "1-5") return `평일 ${at}`;
  if (/^[0-6]$/.test(dow)) return `매주 ${DAY[Number(dow)]}요일 ${at}`;
  return null;
}
```

- [ ] **Step 5: 통과 확인**

Run: `node --experimental-strip-types --test packages/system/surfaces/view/lib/describe.test.ts`
Expected: `# pass 1`

- [ ] **Step 6: Commit**

```bash
git add packages/system/surfaces/view/tsconfig.json packages/system/surfaces/view/lib/describe.ts packages/system/surfaces/view/lib/describe.test.ts
git commit -m "feat(view): cron 을 사람 말로 — 설명서의 첫 번역기"
```

---

### Task 2: 트리에서 동사 이름 · provider 표시명

**Files:**
- Modify: `packages/system/surfaces/view/lib/describe.ts`
- Modify: `packages/system/surfaces/view/lib/describe.test.ts`

`pkg-read`(file 없이)는 파일 트리를 두 칸 들여쓴 문자열 배열로 준다 (`packages/system/scripts/pkg-read.ts` 의 `tree()`): `"scripts/"`, `"  save.ts"`, `"  list.ts"`, `"agents/"`, …

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
import { cronToKorean, providerLabel, scriptNamesFromTree } from "./describe.ts";

test("scriptNamesFromTree — scripts.source 바로 아래 *.ts 만", () => {
  const tree = ["relay.yaml", "scripts/", "  save.ts", "  list.ts", "  lib/", "    util.ts", "  README.md", "agents/", "  diary/", "    AGENT.md"];
  assert.deepEqual(scriptNamesFromTree(tree, "scripts"), ["save", "list"]);
  assert.deepEqual(scriptNamesFromTree(tree, "verbs"), []);
});

test("providerLabel", () => {
  assert.equal(providerLabel("anthropic"), "Claude");
  assert.equal(providerLabel("openai"), "OpenAI");
  assert.equal(providerLabel("moonshot"), "Kimi");
  assert.equal(providerLabel("acme"), "acme");
});
```

- [ ] **Step 2: 실패 확인**

Run: `node --experimental-strip-types --test packages/system/surfaces/view/lib/describe.test.ts`
Expected: FAIL — `scriptNamesFromTree is not a function` (또는 export 없음)

- [ ] **Step 3: 구현** — `describe.ts` 에 추가

```ts
/** pkg-read 의 들여쓴 트리에서 scripts.source 바로 아래 *.ts 의 이름. 하위 폴더는 동사가 아니다 */
export function scriptNamesFromTree(tree: string[], source: string | undefined): string[] {
  if (!source) return [];
  const head = source.replace(/\/$/, "") + "/";
  const i = tree.indexOf(head);
  if (i < 0) return [];
  const out: string[] = [];
  for (let k = i + 1; k < tree.length; k++) {
    const line = tree[k];
    if (!line.startsWith("  ")) break; // 다음 최상위 항목
    if (line.startsWith("    ")) continue; // 더 깊은 것
    const name = line.trim();
    if (name.endsWith(".ts")) out.push(name.slice(0, -3));
  }
  return out;
}

const PROVIDER: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", moonshot: "Kimi", google: "Gemini" };
export function providerLabel(provider: string): string {
  return PROVIDER[provider.toLowerCase()] ?? provider;
}
```

- [ ] **Step 4: 통과 확인**

Run: 같은 명령. Expected: `# pass 3`

- [ ] **Step 5: Commit**

```bash
git add packages/system/surfaces/view/lib/describe.ts packages/system/surfaces/view/lib/describe.test.ts
git commit -m "feat(view): 동사 이름·엔진 표시명 — 설명서의 재료 둘"
```

---

### Task 3: describe() — 매니페스트를 줄로

**Files:**
- Modify: `packages/system/surfaces/view/lib/describe.ts`
- Modify: `packages/system/surfaces/view/lib/describe.test.ts`

- [ ] **Step 1: 실패하는 테스트 추가**

```ts
import { cronToKorean, describe, providerLabel, scriptNamesFromTree, type Row } from "./describe.ts";
import type { Manifest } from "./types";

const byKey = (rows: Row[], key: string) => rows.find((r) => r.key === key)!;

test("describe — 빈 매니페스트도 줄이 선다", () => {
  const rows = describe({}, { workspace: "/w", scripts: [], edges: [], landing: null, activeHarness: null, labelOf: (n) => n });
  assert.deepEqual(rows.map((r) => r.key), ["verbs", "when", "dirs", "talk", "links"]);
  assert.equal(byKey(rows, "verbs").empty, "아직 없음");
  assert.equal(byKey(rows, "when").empty, "아직 없음 — 부르면 움직입니다");
  assert.equal(byKey(rows, "talk").empty, "대화 없음");
  assert.deepEqual(byKey(rows, "dirs").items, [{ text: "작업 폴더", sub: "/w" }]);
});

test("describe — 일기 비서", () => {
  const m: Manifest = {
    name: "@local/diary",
    agents: [{ name: "diary" }],
    scripts: { source: "scripts" },
    triggers: [
      { id: "nudge", when: { cron: "0 22 * * *", tz: "Asia/Seoul" }, then: { agent: "diary" } },
      { id: "odd", when: { cron: "0 0 1 * *" }, then: { agent: "diary" } },
      { id: "onfile", when: { event: "file.changed" }, then: { script: "index" } },
    ],
    services: [
      { name: "diary", dir: "~/Relay/diary" },
      { name: "notion", api: "https://api.notion.com" },
    ],
    surfaces: { channels: [{ name: "slack", source: "ch/slack", entry: "run" }] },
    harness: { variants: [{ name: "claude-code", source: "h/cc", llm: { provider: "anthropic" } }] },
    requires: { binaries: [{ name: "git" }] },
  };
  const rows = describe(m, {
    workspace: "/w",
    scripts: ["save", "find", "month"],
    edges: [{ consumer: "diary", provider: "calendar", ref: "@local/calendar", tools: ["list"], granted: true }],
    landing: "diary",
    activeHarness: "claude-code",
    labelOf: (n) => (n === "calendar" ? "달력" : n),
  });
  assert.deepEqual(rows.map((r) => r.key), ["verbs", "when", "dirs", "talk", "links", "engine", "needs"]);
  assert.deepEqual(byKey(rows, "verbs").items.map((i) => i.text), ["save", "find", "month"]);
  assert.deepEqual(byKey(rows, "when").items, [
    { text: "매일 밤 10시", sub: "Asia/Seoul" },
    { text: "0 0 1 * *", sub: undefined },
    { text: "file.changed 이 생기면", sub: undefined },
  ]);
  assert.deepEqual(byKey(rows, "dirs").items, [{ text: "작업 폴더", sub: "/w" }, { text: "diary", sub: "~/Relay/diary" }]);
  assert.deepEqual(byKey(rows, "talk").items.map((i) => i.text), ["이 화면", "slack"]);
  assert.deepEqual(byKey(rows, "links").items, [
    { text: "notion", sub: "https://api.notion.com" },
    { text: "달력의 도구를 빌려 씀", sub: "list" },
  ]);
  assert.deepEqual(byKey(rows, "engine").items, [{ text: "Claude", sub: undefined }]);
  assert.deepEqual(byKey(rows, "needs").items, [{ text: "git", sub: undefined }]);
  assert.equal(byKey(rows, "when").sec, "triggers");
});
```

- [ ] **Step 2: 실패 확인**

Run: 같은 명령. Expected: FAIL — `describe is not a function`

- [ ] **Step 3: 구현** — `describe.ts` 에 추가

```ts
export interface RowItem { text: string; sub?: string }
export interface Row {
  key: "verbs" | "when" | "dirs" | "talk" | "links" | "engine" | "needs";
  /** 왼쪽 질문 */
  q: string;
  items: RowItem[];
  /** 비었을 때 오른쪽에 놓을 문구. 없으면 빈 줄은 생략한다 */
  empty?: string;
  /** 누르면 가는 스튜디오 섹션 (lib/sections.ts 의 key) */
  sec: string;
}

export interface DescribeCtx {
  workspace: string;
  /** 설치본 scripts.source 아래 동사 이름 — pkg-read 트리에서 scriptNamesFromTree 로 */
  scripts: string[];
  /** 이 패키지가 consumer 인 edges */
  edges: EdgeView[];
  /** 착지 에이전트 이름 (faces.ts landingAgent) */
  landing: string | null;
  /** 장부의 활성 하네스 이름 (Pkg.harness) */
  activeHarness: string | null;
  /** 설치 이름 → 표시 이름 */
  labelOf: (name: string) => string;
}

export function describe(m: Manifest, ctx: DescribeCtx): Row[] {
  const rows: Row[] = [];

  rows.push({ key: "verbs", q: "시킬 수 있는 일", sec: "scripts", empty: "아직 없음", items: ctx.scripts.map((s) => ({ text: s })) });

  rows.push({
    key: "when", q: "스스로 움직이는 때", sec: "triggers", empty: "아직 없음 — 부르면 움직입니다",
    items: (m.triggers ?? []).map((t) =>
      t.when.cron != null
        ? { text: cronToKorean(t.when.cron) ?? t.when.cron, sub: t.when.tz }
        : { text: `${t.when.event ?? t.id} 이 생기면`, sub: undefined },
    ),
  });

  rows.push({
    key: "dirs", q: "손대는 폴더", sec: "services",
    items: [{ text: "작업 폴더", sub: ctx.workspace }, ...(m.services ?? []).filter((s) => s.dir != null).map((s) => ({ text: s.name, sub: s.dir }))],
  });

  rows.push({
    key: "talk", q: "대화하는 곳", sec: "agents", empty: "대화 없음",
    items: [...(ctx.landing ? [{ text: "이 화면" }] : []), ...(m.surfaces?.channels ?? []).map((c) => ({ text: c.name }))],
  });

  rows.push({
    key: "links", q: "바깥 연결", sec: "edges", empty: "아직 없음",
    items: [
      ...(m.services ?? []).filter((s) => s.url != null || s.api != null).map((s) => ({ text: s.name, sub: s.url ?? s.api })),
      ...ctx.edges.map((e) => ({
        text: e.mission ? `${ctx.labelOf(e.provider ?? e.ref)}에 일을 맡김` : `${ctx.labelOf(e.provider ?? e.ref)}의 도구를 빌려 씀`,
        sub: e.mission ?? e.tools?.join(", "),
      })),
    ],
  });

  const active = (m.harness?.variants ?? []).find((v) => v.name === ctx.activeHarness) ?? m.harness?.variants?.[0];
  if (active?.llm?.provider) {
    rows.push({ key: "engine", q: "동작 엔진", sec: "harness", items: [{ text: providerLabel(active.llm.provider), sub: undefined }] });
  }

  const bins = m.requires?.binaries ?? [];
  if (bins.length) rows.push({ key: "needs", q: "필요한 것", sec: "requires", items: bins.map((b) => ({ text: b.name, sub: undefined })) });

  return rows;
}
```

`RowItem` 의 `sub: undefined` 를 명시하는 이유: 테스트가 `deepEqual` 로 형태를 고정한다. `{ text }` 만 있는 항목(verbs · talk)은 테스트도 `.text` 만 본다.

- [ ] **Step 4: 통과 확인**

Run: 같은 명령. Expected: `# pass 5`

- [ ] **Step 5: 루트 `npm test` 에 편입** — root `package.json`:

```json
    "test": "node --experimental-strip-types --test runner/**/*.test.ts packages/system/surfaces/view/lib/*.test.ts",
```

Run: `npm test` — Expected: 기존 테스트 + 5 pass.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/system/surfaces/view/lib/describe.ts packages/system/surfaces/view/lib/describe.test.ts
git commit -m "feat(view): describe() — 매니페스트를 사람 말 줄로"
```

---

### Task 4: Describe 컴포넌트

**Files:**
- Create: `packages/system/surfaces/view/components/Describe.tsx`
- Modify: `packages/system/surfaces/view/app/globals.css` (`.detail-foot` 정의 근처, 84행 뒤)

- [ ] **Step 1: 컴포넌트**

```tsx
"use client";

import Link from "next/link";
import type { Row } from "@/lib/describe";

// 1층 "읽기". 줄은 질문-답이고 어느 줄이든 누르면 스튜디오의 그 섹션으로 간다 — 2층(제자리
// 펼침 폼)이 생기기 전까지의 문. 빈 줄도 같은 곳으로 간다: 거기서 만들 수 있다.
export default function Describe({ pkg, rows, trailing }: { pkg: string; rows: Row[]; trailing?: Partial<Record<Row["key"], React.ReactNode>> }) {
  return (
    <div className="ds">
      {rows.map((r) => {
        if (!r.items.length && !r.empty) return null;
        const href = `/studio/?pkg=${encodeURIComponent(pkg)}&sec=${r.sec}`;
        return (
          <Link key={r.key} href={href} className="ds-row" title="스튜디오에서 이 부분을 고칩니다">
            <span className="ds-q">{r.q}</span>
            <span className="ds-a">
              {r.items.length
                ? r.items.map((it, i) => (
                    <span key={i} className="ds-item">
                      {it.text}
                      {it.sub ? <span className="ds-sub">{it.sub}</span> : null}
                    </span>
                  ))
                : <span className="ds-empty">{r.empty}</span>}
              {trailing?.[r.key] ?? null}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: 스타일** — `globals.css` 의 `.detail-foot .grow { … }` 줄 뒤에:

```css
/* 설명서 (콘솔 상세 1층) — 질문-답 목록. 매니페스트 어휘가 아니라 사람 말 */
.ds { display: flex; flex-direction: column; }
.ds-row { display: flex; gap: 14px; padding: 10px 6px; border-bottom: 1px solid var(--rc-line-soft); color: inherit; text-decoration: none; border-radius: 8px; }
.ds-row:hover { background: var(--rc-hover); }
.ds-row:last-child { border-bottom: none; }
.ds-q { flex: 0 0 120px; font-size: 12.5px; color: var(--rc-faint); padding-top: 2px; }
.ds-a { flex: 1; display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: baseline; font-size: 13.5px; }
.ds-item { display: inline-flex; align-items: baseline; gap: 6px; }
.ds-sub { font: 11.5px var(--rc-mono); color: var(--rc-faint); }
.ds-empty { color: var(--rc-faint); }
.ds-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
```

- [ ] **Step 3: 타입 확인**

Run: `cd packages/system/surfaces/view && npx tsc --noEmit -p . 2>&1 | grep -v '^$' | head`
Expected: 출력 없음 (또는 이 변경과 무관한 기존 오류만)

- [ ] **Step 4: Commit**

```bash
git add packages/system/surfaces/view/components/Describe.tsx packages/system/surfaces/view/app/globals.css
git commit -m "feat(view): Describe — 설명서 줄을 그린다"
```

---

### Task 5: DetailFace 를 설명서로

**Files:**
- Modify: `packages/system/surfaces/view/components/PkgPane.tsx` — `DetailFace` (176행~)

남기는 것: 연결 승인(미결재 edge 의 버튼), "이 앱을 쓰는 앱"(제거 전 경고의 재료), 하단 액션. 바뀌는 것: 세 카드(`detail-grid`)가 설명서 한 목록이 된다.

- [ ] **Step 1: import 추가**

```tsx
import Describe from "@/components/Describe";
import { describe, scriptNamesFromTree } from "@/lib/describe";
import { landingAgent, residentDecls } from "@/lib/faces";
import { draftList, type DraftEntry } from "@/lib/studio";
```

(`landingAgent` · `residentDecls` 는 이미 있다 — 그 줄에 합친다.)

- [ ] **Step 2: DetailFace 본문 교체** — `const outward = …` 줄부터 `</div>` (`pane-body` 닫힘) 직전의 `detail-foot` 앞까지를 아래로 바꾼다. 상태 선언(`error` · `confirming` · `busy` · `label` · `approve` · `remove`)은 그대로 둔다.

```tsx
  // 설명서의 두 재료는 매니페스트 밖에 있다: 동사 이름(설치본 트리), 미적용 draft(변경 수)
  const [scripts, setScripts] = useState<string[]>([]);
  const [draft, setDraft] = useState<DraftEntry | null>(null);
  useEffect(() => {
    let on = true;
    void callScript<{ tree: string[] }>("pkg-read", { name: pkg.name })
      .then((r) => { if (on) setScripts(scriptNamesFromTree(r.tree ?? [], m?.scripts?.source)); })
      .catch(() => { if (on) setScripts([]); });
    void draftList()
      .then((r) => { if (on) setDraft(r.drafts.find((d) => d.name === pkg.name && d.changes > 0) ?? null); })
      .catch(() => { if (on) setDraft(null); });
    return () => { on = false; };
  }, [pkg.name, m?.scripts?.source]);

  const rows = describe(m ?? {}, {
    workspace: pkg.workspace,
    scripts,
    edges: mine,
    landing: landingAgent(m),
    activeHarness: pkg.harness,
    labelOf: label,
  });
  const pending = mine.filter((e) => !e.granted && e.provider);

  return (
    <div className="pane-body">
      <div className="ds-head">
        {m?.description ? <p className="lede">{m.description}</p> : null}
        {draft ? (
          <Link className="rc-chip" href={`/studio/?pkg=${encodeURIComponent(pkg.name)}`} title="고친 것이 있지만 아직 돌아가는 판에 적용되지 않았습니다">
            수정 중 · 아직 적용 안 됨 {draft.changes}건
          </Link>
        ) : null}
      </div>
      {error ? <div className="banner">{error}</div> : null}

      <Describe
        pkg={pkg.name}
        rows={rows}
        trailing={{
          // 미결재 연결은 설명이 아니라 결재다 — 줄 끝에 승인 버튼. 링크 안의 버튼이라 전파를 막는다
          links: pending.length ? (
            <span style={{ display: "inline-flex", gap: 6 }}>
              {pending.map((e, i) => (
                <button
                  key={`p-${e.ref}-${i}`}
                  className="rc-btn"
                  type="button"
                  onClick={(ev) => { ev.preventDefault(); ev.stopPropagation(); void approve(e); }}
                >
                  {label(e.provider!)} 연결 승인
                </button>
              ))}
            </span>
          ) : null,
        }}
      />

      {users.length ? (
        <p className="hint">
          이 앱을 쓰는 앱: {users.map((e) => label(e.consumer)).join(", ")} — 지우면 함께 멈춥니다
        </p>
      ) : null}
```

`callScript` 는 `@/lib/api` 에서 이미 import 목록에 있는지 확인하고 없으면 추가한다 (`callScript<T>(name, input)`; `packages/system/surfaces/view/lib/api.ts:111`).

- [ ] **Step 3: `pkg-read` 반환 형 확인**

Run: `sed -n 40,70p packages/system/scripts/pkg-read.ts`
Expected: file 없이 부르면 `{ manifest, tree }` 꼴로 돌려준다. 키 이름이 `tree` 가 아니면 Step 2 의 `r.tree` 를 그 이름으로 맞춘다.

- [ ] **Step 4: 죽은 코드 정리**

`outward` 변수와 `detail-grid` 마크업이 남아 있지 않은지, `serviceStatus`/`channelStatus`/`ServiceStatusView`/`ChannelStatusView`/`residentDecls` 등 import 가 이 파일의 다른 곳(`LiveFace`)에서 여전히 쓰이는지 확인한다. 안 쓰이는 import 만 지운다.

Run: `cd packages/system/surfaces/view && npx tsc --noEmit -p . 2>&1 | head`
Expected: 출력 없음

- [ ] **Step 5: 굽고 눈으로 확인**

```bash
npm run relay -- build system
```

데몬이 떠 있으면 콘솔에서 패키지 하나(예: system)를 골라 상세 탭. 확인할 것:
- 줄이 질문-답으로 서고, 영어 항목명이 본문에 없다
- 줄을 누르면 `/studio/?pkg=…&sec=…` 로 간다
- 미결재 edge 가 있는 패키지에서 "연결 승인" 버튼이 줄 끝에 있고, 누르면 이동하지 않고 승인된다
- draft 에 변경이 있는 패키지에서 "수정 중" 칩이 뜬다

- [ ] **Step 6: 관문**

```bash
npm run validate && npm run typecheck && npm test
```

Expected: 셋 다 통과.

- [ ] **Step 7: Commit**

```bash
git add packages/system/surfaces/view/components/PkgPane.tsx
git commit -m "feat(shell): 상세 탭이 설명서가 된다 — 매니페스트 어휘 대신 사람 말"
```

---

## Self-review

- 스펙 커버리지: 머리(아이콘·이름은 `pane-head` 가 이미 그림, 소개는 `lede`) ✓ · 8줄 ✓ · cron 번역표 ✓ · 원문 fallback ✓ · tz ✓ · 줄 클릭 → 스튜디오 섹션 ✓ · 빈 줄도 이동 ✓ · 수정 중 칩 ✓ · 하단 액션 유지 ✓ · `Detail.tsx` 불변 ✓ · 테스트 ✓
- 스펙 밖 추가 둘, 이유 명시: 미결재 연결 승인 버튼(지우면 결재 경로가 사라진다) · "이 앱을 쓰는 앱" 한 줄(제거 경고의 재료)
- 이름 일관성: `Row.key` 7종 · `DescribeCtx` 필드 · `scriptNamesFromTree(tree, source)` · `providerLabel` — Task 3·4·5 에서 같은 이름

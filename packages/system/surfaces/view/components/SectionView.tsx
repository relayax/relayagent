"use client";

import type React from "react";
import { useEffect, useId, useState } from "react";
import type { Document } from "yaml";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { HARNESS_TEMPLATES, creatable, harnessLabel, push, removeHarness, slugOk, type Made } from "@/lib/create";
import { DOW_LABEL, buildCron, cronToKorean, matchScripts, parseCron, type CronPick } from "@/lib/describe";
import { SECTIONS, schemaHint, unclaimedFiles, type SectionDef, type SectionItem } from "@/lib/sections";
import type { CredentialField, Manifest, ServiceDecl } from "@/lib/types";
import { draftIconList, draftReadFile, type DraftChange } from "@/lib/studio";

// depth 2: 섹션 랜딩(항목 목록 또는 폼)과 항목 폼 + 파일 카드.
// 폼의 정본은 relay.yaml 텍스트다 — 편집은 Document 패치로 들어가 사용자의 주석을 보존하고,
// 결과 텍스트가 apply() 로 올라가 저장된다. 폼은 그 텍스트의 뷰일 뿐이다.

export interface SectionCtx {
  /** draft 이름 — 작업 사본의 자산 주소(/draft/<이름>/asset/…)를 만들 때 */
  pkg: string;
  manifest: Manifest;
  text: string;
  files: string[];
  changes: DraftChange[];
  schema: any;
  // 쓰기 셋은 약속을 돌려준다 — 만든 뒤 그리로 데려가려면 **쓰기가 끝난 시점**을 알아야 한다.
  // 종전에는 셋 다 fire-and-forget 이라, 만들자마자 이동하면 아직 없는 항목으로 가서
  // "없는 에이전트" 가 잠깐 떴다
  apply(mutate: (doc: Document) => void): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  openFile(path: string): void;
  openItem(item: string | null): void;
  /** system 패키지의 하네스 템플릿 복사 (선언과 실체를 같이 만든다) */
  seedHarness(source: string, entry: string): Promise<void>;
  /** 만든 뒤 — 그리로 데려가고 영수증을 남긴다. 팔레트와 섹션이 같은 뒷처리를 지난다 */
  made(m: Made): void;
  /** 대표 아이콘 — 이모지 하나로 고른다(system draft-icon). 그림 파일과 선언을 한 번에 앉힌다 */
  setIcon(emoji: string): Promise<void>;
}

/**
 * 섹션 안의 만들기. 팔레트와 **같은 정의**(lib/create.ts)를 부른다 — 같은 것을 두 자리에서
 * 만들면 스캐폴드가 갈라질 자리가 생기고, 그 갈라짐은 "팔레트로 만든 부품과 섹션에서 만든
 * 부품이 다르다" 같은 형태로 나타난다.
 */
function useMake(ctx: SectionCtx): [boolean, (id: string, input: string, second?: string) => void] {
  const [busy, setBusy] = useState(false);
  const run = (id: string, input: string, second?: string): void => {
    if (busy) return;
    setBusy(true);
    void creatable(id)
      .make(ctx, input.trim(), second?.trim())
      .then((m) => ctx.made(m))
      .finally(() => setBusy(false));
  };
  return [busy, run];
}

/** blur 시점에만 커밋하는 입력 — 키 입력마다 YAML 재직렬화가 도는 churn 을 막는다 */
function Field({
  label,
  hint,
  k,
  value,
  placeholder,
  mono,
  onCommit,
}: {
  /** 사람 말 이름 — 이름만. 설명은 hint 로 내린다 */
  label: string;
  /** 라벨 아래 한 줄 — 종전에는 "이름 — 설명" 으로 라벨에 붙어 있었다. 라벨이 두 줄로 접히면
   *  어디까지가 이름이고 어디부터가 설명인지 안 보이고, 칸 세 개가 전부 같은 무게로 선다 */
  hint?: string;
  /** 문법 좌표 — 작게 병기한다. 팔레트·설명서와 같은 규칙: 얻는 것의 이름이 크고 문법이 작다 */
  k?: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  const id = useId();
  useEffect(() => setV(value), [value]);
  return (
    <div className="st-field" title={k ? `relay.yaml: ${k}` : undefined}>
      <Label htmlFor={id}>{label}</Label>
      {hint ? <p className="st-hintline">{hint}</p> : null}
      <Input
        id={id}
        value={v}
        placeholder={placeholder}
        className={mono ? "font-mono text-xs md:text-xs" : undefined}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

function listField(v: string): string[] {
  return v.split(",").map((x) => x.trim()).filter(Boolean);
}

const set = (doc: Document, path: (string | number)[], v: unknown) => {
  if (v === "" || v === undefined || (Array.isArray(v) && !v.length)) doc.deleteIn(path);
  else doc.setIn(path, v);
};

function FileCards({ item, ctx, missing }: { item: { files: string[] }; ctx: SectionCtx; missing?: { path: string; make: () => void }[] }) {
  const changed = new Set(ctx.changes.map((c) => c.file));
  if (!item.files.length && !missing?.length) return null;
  return (
    <div className="st-files">
      <div className="rc-label">파일</div>
      {item.files.map((f) => (
        <div key={f} className="st-file" onClick={() => ctx.openFile(f)}>
          <span className="st-file-path">{f}</span>
          {changed.has(f) ? <span className="st-dot" /> : null}
        </div>
      ))}
      {(missing ?? []).map((x) => (
        <div key={x.path} className="st-file missing">
          <span className="st-file-path">{x.path}</span>
          <Button variant="outline" size="sm" onClick={x.make}>
            만들기
          </Button>
        </div>
      ))}
    </div>
  );
}

function ItemList({ def, items, ctx, onAdd, addLabel }: { def: SectionDef; items: SectionItem[]; ctx: SectionCtx; onAdd?: () => void; addLabel?: string }) {
  return (
    <div className="lv">
      {items.map((it) => (
        <div key={it.id} className="lv-row" onClick={() => ctx.openItem(it.id)}>
          <span className="lv-ic">{it.title[0]?.toUpperCase()}</span>
          <span className="lv-tx">
            <span className="lv-t">{it.title}</span>
            {it.sub ? <span className="lv-s">{it.sub}</span> : null}
          </span>
          {it.files.length ? <Badge variant="secondary">{it.files.length} 파일</Badge> : null}
        </div>
      ))}
      {onAdd ? (
        <div className="lv-row lv-add" onClick={onAdd}>
          <b>+</b> {addLabel ?? "추가"}
        </div>
      ) : null}
      {!items.length && !onAdd ? <div className="empty">없음</div> : null}
    </div>
  );
}

/** 손댈 일이 드문 필드를 접는다 — 값이 있으면 펼쳐 둔다(비어 있지 않은 것을 숨기면 안 된다) */
function Advanced({ open, children }: { open?: boolean; children: React.ReactNode }) {
  return (
    <details className="st-adv" open={open}>
      <summary>고급</summary>
      {children}
    </details>
  );
}

function Hint({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  // 사람 말(sections.ts)이 먼저다. 스키마의 description 은 문법 설명이라 개발자 말이고, 그것은
  // relay.yaml 에디터의 lint 가 제 자리에서 보여 준다
  const hint = def.hint || schemaHint(ctx.schema, def.yamlKey);
  return (
    <details className="st-hint fold">
      <summary>이 묶음은?</summary>
      {hint}
    </details>
  );
}

// ── 섹션별 캔버스 ─────────────────────────────────────────────────────────

/** 코드포인트 이름(u1F4D2) → 이모지 글자. draft-icon 이 받는 것은 글자다 */
function glyphEmoji(name: string): string {
  return String.fromCodePoint(...name.slice(1).split("_u").map((h) => parseInt(h, 16)));
}
const glyphSrc = (name: string) => `/pkg/system/asset/assets/tossface/${name}.svg`;

/** 갈래 — 이름이 없어 유니코드 구획으로 나눈다. 순서대로 첫 일치, 나머지는 "기타" */
const ICON_GROUPS: { label: string; ranges: [number, number][] }[] = [
  { label: "표정", ranges: [[0x1f600, 0x1f644], [0x1f910, 0x1f92f], [0x1f970, 0x1f97a], [0x1f9d0, 0x1f9d0], [0x2639, 0x263a], [0x1fae0, 0x1fae8]] },
  { label: "사람", ranges: [[0x1f440, 0x1f450], [0x1f466, 0x1f487], [0x1f574, 0x1f57a], [0x1f645, 0x1f64f], [0x1f930, 0x1f939], [0x1f9b0, 0x1f9df], [0x1f4aa, 0x1f4aa], [0x1fac0, 0x1fac5], [0x1faf0, 0x1faf8], [0x261d, 0x261d], [0x270a, 0x270d]] },
  { label: "동물·자연", ranges: [[0x1f300, 0x1f32c], [0x1f330, 0x1f344], [0x1f400, 0x1f43f], [0x1f980, 0x1f9ae], [0x1fab0, 0x1fabf], [0x2600, 0x2604], [0x26c4, 0x26c8], [0x2744, 0x2744], [0x1f7e0, 0x1f7eb]] },
  { label: "음식", ranges: [[0x1f32d, 0x1f32f], [0x1f345, 0x1f37f], [0x1f950, 0x1f96f], [0x1f9c0, 0x1f9cb], [0x1fad0, 0x1fadb], [0x2615, 0x2615]] },
  { label: "활동", ranges: [[0x1f3a0, 0x1f3cf], [0x1f3d4, 0x1f3df], [0x1f93a, 0x1f94f], [0x26bd, 0x26be], [0x26f3, 0x26fa], [0x1f6f7, 0x1f6fc], [0x1f397, 0x1f39f], [0x1f3f8, 0x1f3ff]] },
  { label: "여행·장소", ranges: [[0x1f3e0, 0x1f3f0], [0x1f680, 0x1f6d7], [0x1f5fa, 0x1f5ff], [0x2708, 0x2708], [0x26ea, 0x26f2], [0x1f6e0, 0x1f6f6], [0x1f3d0, 0x1f3d3]] },
  { label: "물건", ranges: [[0x1f4a0, 0x1f4ff], [0x1f500, 0x1f53d], [0x1f549, 0x1f573], [0x1f57b, 0x1f5f9], [0x1f9e0, 0x1f9ff], [0x1fa70, 0x1faaf], [0x1f6cb, 0x1f6df], [0x2702, 0x2707], [0x260e, 0x2614], [0x231a, 0x231b], [0x2328, 0x2328], [0x23f0, 0x23f3]] },
  { label: "한국", ranges: [[0xe000, 0xf8ff]] },
];
function groupOf(name: string): string {
  const cp = parseInt(name.slice(1).split("_")[0], 16);
  return ICON_GROUPS.find((g) => g.ranges.some(([a, b]) => cp >= a && cp <= b))?.label ?? "기타";
}
const GROUP_LABELS = [...ICON_GROUPS.map((g) => g.label), "기타"];

/** 아이콘 선택창 — 기판이 품은 Tossface 전부를 갈래별 격자로. 누르면 그것으로 정해진다 */
function IconDialog({ current, onPick, onClose }: { current: string | null; onPick: (emoji: string) => Promise<void>; onClose: () => void }) {
  const [all, setAll] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState("물건");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    draftIconList().then((r) => setAll(r.glyphs)).catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  }, []);
  const shown = all ? all.filter((g) => groupOf(g) === tab) : [];
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>아이콘 고르기</DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap gap-1">
          {GROUP_LABELS.map((l) => (
            <button
              key={l}
              type="button"
              className={`rounded-md border px-2.5 py-1 text-xs ${tab === l ? "bg-primary text-primary-foreground border-primary" : "bg-background hover:bg-accent"}`}
              onClick={() => setTab(l)}
            >
              {l}
            </button>
          ))}
        </div>
        {err ? <div className="banner">{err}</div> : null}
        <div className="grid max-h-[50vh] grid-cols-8 gap-1 overflow-y-auto p-1 sm:grid-cols-10">
          {!all && !err ? <span className="col-span-full text-xs text-muted-foreground">불러오는 중…</span> : null}
          {shown.map((g) => (
            <button
              key={g}
              type="button"
              disabled={busy != null}
              aria-pressed={current === g}
              className={`inline-flex aspect-square items-center justify-center rounded-md border hover:bg-accent disabled:opacity-50 ${current === g ? "border-primary ring-2 ring-primary/30" : "border-transparent"}`}
              title={glyphEmoji(g)}
              onClick={() => {
                setBusy(g);
                onPick(glyphEmoji(g)).then(onClose).catch(() => { /* 콘솔이 사유를 말했다 */ }).finally(() => setBusy(null));
              }}
            >
              <img className="size-7" src={glyphSrc(g)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 아이콘 — 누르면 선택창. 그림 파일과 선언은 draft-icon 이 한 번에 앉힌다 */
function IconField({ ctx }: { ctx: SectionCtx }) {
  const m = ctx.manifest;
  const [open, setOpen] = useState(false);
  const [rev, setRev] = useState(0);
  const current = m.icon ? `/draft/${encodeURIComponent(ctx.pkg)}/asset/${m.icon}?v=${rev}` : null;
  // 지금 그림이 Tossface 의 어느 것인지는 파일이 말해 주지 않는다 — 선택창의 강조는 이름이 맞을 때만
  return (
    <div className="flex flex-col gap-1.5" title="relay.yaml: icon">
      <Label>아이콘</Label>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="inline-flex size-12 items-center justify-center rounded-md border bg-background hover:bg-accent"
          title="아이콘 고르기"
          onClick={() => setOpen(true)}
        >
          {current ? <img className="size-8" src={current} alt="" /> : <span className="text-xs text-muted-foreground">없음</span>}
        </button>
        <Button variant="outline" size="sm" type="button" onClick={() => setOpen(true)}>
          {current ? "바꾸기" : "고르기"}
        </Button>
      </div>
      {open ? (
        <IconDialog
          current={null}
          onPick={(emoji) => ctx.setIcon(emoji).then(() => setRev((r) => r + 1))}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function IdentityView({ ctx }: { ctx: SectionCtx }) {
  const m = ctx.manifest;
  return (
    <div className="st-form">
      <IconField ctx={ctx} />
      <Field label="이름" k="display_name" value={m.display_name ?? ""} onCommit={(v) => ctx.apply((d) => set(d, ["display_name"], v))} />
      <Field label="한 줄 소개" k="description" value={m.description ?? ""} onCommit={(v) => ctx.apply((d) => set(d, ["description"], v))} />
      <Advanced>
        <Field label="고유 이름" hint="설치와 배포에 쓰는 이름" k="name" value={m.name ?? ""} mono placeholder="@local/my-agent" onCommit={(v) => ctx.apply((d) => set(d, ["name"], v))} />
        <Field label="버전" k="version" value={m.version ?? ""} mono placeholder="0.1.0" onCommit={(v) => ctx.apply((d) => set(d, ["version"], v))} />
        <Field label="아이콘 파일" k="icon" value={m.icon ?? ""} mono placeholder="assets/icon.svg" onCommit={(v) => ctx.apply((d) => set(d, ["icon"], v))} />
        <NavField ctx={ctx} />
      </Advanced>
    </div>
  );
}

/** 사이드바 자리(shell.nav) — 표시 축이라 이름·아이콘 옆에 선다. 기본(auto)은 선언을 지운다:
 *  "접힐지"는 기판이 결재를 보고 정하는 것이라 매니페스트에 기본값을 박아 두지 않는다 */
function NavField({ ctx }: { ctx: SectionCtx }) {
  const id = useId();
  const nav = ctx.manifest.shell?.nav ?? "auto";
  return (
    <div className="st-field" title="relay.yaml: shell.nav">
      <Label htmlFor={id}>사이드바 자리</Label>
      <p className="st-hintline">기본은 자동 — 이 앱의 부품을 이어 쓰는 앱이 있으면 그 밑으로 접히고, 없으면 최상위에 섭니다. 숨겨도 상세 화면과 직접 주소로는 열립니다.</p>
      <select id={id} value={nav} onChange={(e) => ctx.apply((d) => (e.target.value === "auto" ? d.deleteIn(["shell"]) : d.setIn(["shell", "nav"], e.target.value)))}>
        <option value="auto">자동 (부품을 쓰는 앱 밑으로 접힘)</option>
        <option value="always">늘 최상위</option>
        <option value="never">사이드바에 숨김</option>
      </select>
    </div>
  );
}

function SurfacesLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const items = def.items!(m, ctx.files);
  const [adding, setAdding] = useState(false);
  const [chName, setChName] = useState("");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} onAdd={() => setAdding(true)} addLabel="채널 (슬랙·디스코드 …)" />
      {adding ? (
        <div className="lv-in">
          <Input placeholder="채널 이름 (예: discord)" value={chName} onChange={(e) => setChName(e.target.value)} autoFocus />
          <Button size="sm" disabled={busy || !slugOk(chName)} onClick={() => make("channel", chName)}>
            추가
          </Button>
        </div>
      ) : null}
      {!m.surfaces?.view ? (
        <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => make("view", "")}>
          + 이 앱의 화면
        </Button>
      ) : null}
      {!m.surfaces?.components ? (
        <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => make("components", "")}>
          + 다른 앱 화면에 끼울 부품
        </Button>
      ) : null}
    </>
  );
}

function SurfacesItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  if (id === "view") {
    const v = m.surfaces?.view;
    const item = { files: v ? ctx.files.filter((f) => f.startsWith(v.source + "/")) : [] };
    return (
      <div className="st-form">
        <Field label="소스 폴더" k="source" value={v?.source ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "view", "source"], x))} />
        <Field label="빌드 결과 폴더" hint="비우면 소스를 그대로 냅니다" k="out" value={v?.out ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "view", "out"], x))} />
        <FileCards item={item} ctx={ctx} missing={v && !item.files.length ? [{ path: `${v.source}/index.html`, make: () => ctx.createFile(`${v.source}/index.html`, `<!doctype html><meta charset="utf-8"><title>view</title>`) }] : []} />
        <Button variant="outline" size="sm" className="self-start st-remove" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "view"]))} title="이 화면 선언을 뺍니다 — 파일은 남습니다">
          빼기
        </Button>
      </div>
    );
  }
  if (id === "components") {
    const c = m.surfaces?.components;
    if (!c) return <div className="empty">없는 선언</div>;
    const item = { files: ctx.files.filter((f) => f.startsWith(c.source + "/")) };
    const entry = c.out ? `${c.source}/${c.out}/index.js` : `${c.source}/index.js`;
    return (
      <div className="st-form">
        <Field label="소스 폴더" k="source" value={c.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "components", "source"], x))} />
        <Field label="빌드 결과 폴더" hint="비우면 소스를 그대로 냅니다" k="out" value={c.out ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "components", "out"], x))} />
        {/* 다섯 줄짜리 계약 설명이 폼 한가운데 펼쳐져 있었다 — 칸에서 가장 무거운 덩어리가 설명이면
            무엇을 고치는 화면인지가 안 보인다. 접어 두고, 알아야 할 때만 편다 */}
        <details className="st-hint fold">
          <summary>부품이 지켜야 할 것</summary>
          {`내보내는 것은 하나입니다 — export function mount(el, props): { unmount() }\n진입점은 ${entry} 하나이고, 스타일도 그 안에 담깁니다.\n쓰는 쪽에 프레임워크를 요구하지 않도록, 필요한 런타임은 번들에 넣으세요.`}
        </details>
        <FileCards
          item={item}
          ctx={ctx}
          missing={!ctx.files.some((f) => f.startsWith(c.source + "/")) ? [{ path: `${c.source}/index.js`, make: () => ctx.createFile(`${c.source}/index.js`, `export function mount(el, props = {}) {\n  el.textContent = props.title ?? "안녕하세요";\n  return { unmount() { el.textContent = ""; } };\n}\n`) }] : []}
        />
        <Button variant="outline" size="sm" className="self-start st-remove" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "components"]))} title="이 부품 선언을 뺍니다 — 파일은 남습니다">
          빼기
        </Button>
      </div>
    );
  }
  const name = id.replace(/^channel:/, "");
  const idx = (m.surfaces?.channels ?? []).findIndex((c) => c.name === name);
  const ch = (m.surfaces?.channels ?? [])[idx];
  if (!ch) return <div className="empty">없는 채널</div>;
  const item = { files: ctx.files.filter((f) => f.startsWith(ch.source + "/")) };
  return (
    <div className="st-form">
      <Field label="어댑터 폴더" k="source" value={ch.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "channels", idx, "source"], x))} />
      <Field label="시작 파일" k="entry" value={ch.entry} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "channels", idx, "entry"], x))} />
      <Field label="배지 이미지" k="icon" value={ch.icon ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "channels", idx, "icon"], x))} />
      <CredentialFields idx={idx} ch={ch} ctx={ctx} />
      <FileCards
        item={item}
        ctx={ctx}
        missing={!ctx.files.includes(`${ch.source}/${ch.entry}`) ? [{ path: `${ch.source}/${ch.entry}`, make: () => ctx.createFile(`${ch.source}/${ch.entry}`, `// ${name} 채널 어댑터\n`) }] : []}
      />
      <Button
        variant="outline"
        size="sm"
        className="self-start st-remove"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["surfaces", "channels", idx]));
          ctx.openItem(null);
        }}
      >
        빼기
      </Button>
    </div>
  );
}

/** 어떤 엔진으로 돌릴 수 있나 — 후보 목록·드롭다운·추가 버튼 대신 칩 하나로. 켜면 붙고, 켜진 것을 누르면 상세 */
function HarnessLanding({ ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const have = new Set((m.harness?.variants ?? []).map((v) => v.name));
  const [busy, make] = useMake(ctx);
  return (
    <div className="st-form">
      <div className="flex flex-col gap-1.5">
        <Label>돌릴 수 있는 엔진</Label>
        <div className="st-picks">
          {HARNESS_TEMPLATES.map((t) => (
            <button key={t} type="button" className="st-pick" aria-pressed={have.has(t)} disabled={busy} title={have.has(t) ? `${t} — 자세히 보기` : `${t} 붙이기`} onClick={() => (have.has(t) ? ctx.openItem(t) : make("harness", t))}>
              {harnessLabel(t)}
            </button>
          ))}
        </div>
        <div className="st-picks-empty">실제로 어느 것으로 돌릴지는 설치한 쪽(설정)에서 고릅니다.</div>
      </div>
      <Advanced open={!!m.harness?.workdir}>
        <Field label="대화가 서는 하위 폴더" k="workdir" value={m.harness?.workdir ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "workdir"], x))} />
      </Advanced>
    </div>
  );
}

function HarnessItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = (m.harness?.variants ?? []).findIndex((v) => v.name === id);
  const v = (m.harness?.variants ?? [])[idx];
  if (!v) return <div className="empty">없는 하네스</div>;
  const item = { files: ctx.files.filter((f) => f.startsWith(v.source + "/")) };
  return (
    <div className="st-form">
      <button type="button" className="st-back" onClick={() => ctx.openItem(null)}>‹ 엔진 목록</button>
      <div className="st-picks-empty"><b>{harnessLabel(v.name)}</b> 어댑터 — 보통 손댈 일이 없습니다.</div>
      <Field label="도구 어댑터 폴더" k="source" value={v.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "source"], x))} />
      <Field label="시작 파일" k="entry" value={v.entry ?? "run"} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "entry"], x))} />
      <Field label="모델 제공자" k="llm.provider" value={v.llm?.provider ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "llm", "provider"], x))} />
      <FileCards item={item} ctx={ctx} />
      <Button
        variant="outline"
        size="sm"
        className="self-start st-remove"
        onClick={() => {
          void removeHarness(ctx, v.name).then(() => ctx.openItem(null));
        }}
      >
        이 엔진 빼기
      </Button>
    </div>
  );
}

function AgentsLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const items = def.items!(ctx.manifest, ctx.files);
  const [name, setName] = useState("");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <Input placeholder="도우미 이름 (예: organizer)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" disabled={busy || !slugOk(name)} onClick={() => { make("agent", name); setName(""); }}>
          추가
        </Button>
      </div>
    </>
  );
}

/** 여러 개 고르기 — 쉼표 입력 대신 칩. 목록에 없는 값(글롭 등)은 그대로 칩으로 보여 주고 뺄 수 있다 */
/**
 * 켜고 끄는 칩들.
 *
 * `covered` — **묶음(글로브)으로 이미 켜진** 낱개. digest-* 하나가 digest-list·read·remove·save
 * 넷을 켜는데 그 넷이 "꺼짐" 으로 그려져 있었다: 실제로는 다 쓸 수 있는데 화면은 하나도 못 쓴다고
 * 말한 것이다(2026-08-28). 낱개로 끌 수 있는 것이 아니므로 누를 수도 없다 — 끄려면 묶음을 끈다.
 */
function Picks({ value, options, covered, onChange, empty }: { value: string[]; options: { id: string; label?: string }[]; covered?: Set<string>; onChange: (v: string[]) => void; empty: string }) {
  const known = new Set(options.map((o) => o.id));
  const extra = value.filter((v) => !known.has(v));
  if (!options.length && !extra.length) return <div className="st-picks-empty">{empty}</div>;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  const by = (id: string) => extra.find((g) => g.includes("*") && new RegExp("^" + g.split("*").join(".*") + "$").test(id));
  return (
    <div className="st-picks">
      {options.map((o) => {
        const cov = !value.includes(o.id) && covered?.has(o.id);
        return (
          <button
            key={o.id}
            type="button"
            className={cov ? "st-pick covered" : "st-pick"}
            aria-pressed={value.includes(o.id) || !!cov}
            disabled={!!cov}
            onClick={() => toggle(o.id)}
            title={cov ? `${by(o.id) ?? "묶음"} 으로 이미 켜져 있습니다` : o.id}
          >
            {o.label ?? o.id}
          </button>
        );
      })}
      {extra.map((v) => (
        <button key={v} type="button" className="st-pick" aria-pressed onClick={() => toggle(v)} title={v.includes("*") ? `${v.replace("*", "")} 로 시작하는 것 전부 — 누르면 뺍니다` : "누르면 뺍니다"}>
          {v}
        </button>
      ))}
    </div>
  );
}

/**
 * 스킬 — **경로가 아니라 목록**이다. 종전에는 "기술(스킬) 폴더 [agents/briefer/skills]" 라는
 * 입력칸이었다: 그 값은 스캐폴드가 관례대로 앉히는 것이고 손으로 고칠 이유가 없으며, 고치면
 * 글만 잃는다. 사람이 여기서 하려는 일은 **무엇이 들어 있나 보기**와 **하나 더 만들기** 둘뿐이다.
 *
 * 스킬 하나 = 폴더 하나(SKILL.md 를 담는다). 그래서 목록은 파일이 아니라 그 폴더 이름이다.
 */
function SkillList({ agent, dir, ctx }: { agent: string; dir?: string; ctx: SectionCtx }) {
  const [busy, make] = useMake(ctx);
  const names = dir
    ? [...new Set(ctx.files.filter((f) => f.startsWith(dir + "/")).map((f) => f.slice(dir.length + 1).split("/")[0]))]
    : [];
  return (
    <div className="st-verbs">
      <div className="st-verbs-h">
        <Label>스킬</Label>
        <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => make("skill", agent)}>＋ 스킬 만들기</Button>
      </div>
      {names.length ? null : <p className="st-verbs-p">필요할 때만 펼쳐 읽는 문서입니다. 성격 글에 다 적는 대신 이쪽으로 덜어냅니다.</p>}
      {names.length ? (
        <ul className="st-verbl">
          {names.map((n) => {
            const file = ctx.files.find((f) => f.startsWith(`${dir}/${n}/`)) ?? `${dir}/${n}`;
            return (
              <li key={n}>
                <button type="button" className="st-verbl-r" title={file} onClick={() => ctx.openFile(file)}>
                  <span className="st-verbl-t">{n}</span>
                  <span className="st-verbl-i">열기 ↗</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** 선언된 폴더 하나의 파일들 — 만드는 레시피가 없는 것(명령)은 있는 것만 보여준다 */
function FileGroup({ title, dir, ctx }: { title: string; dir: string; ctx: SectionCtx }) {
  const files = ctx.files.filter((f) => f.startsWith(dir + "/"));
  if (!files.length) return null;
  return (
    <div className="st-verbs">
      <Label>{title}</Label>
      <ul className="st-verbl">
        {files.map((f) => (
          <li key={f}>
            <button type="button" className="st-verbl-r" title={f} onClick={() => ctx.openFile(f)}>
              <span className="st-verbl-t">{f.slice(dir.length + 1)}</span>
              <span className="st-verbl-i">열기 ↗</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 성격과 역할 — **글을 보여준다**. 종전에는 "누구인지, 어떻게 말하는지" 라고 적힌 카드였다:
 * 이 에이전트가 무엇인지는 그 글에 적혀 있는데, 화면은 그 글이 있다는 사실만 말하고 정작
 * 내용을 감췄다. 폼이 전부 문(門)이면 열어 보기 전에는 아무것도 모른다(2026-08-28).
 *
 * 앞 몇 줄만 낸다 — 페르소나는 길고, 여기서 하려는 것은 읽기가 아니라 **알아보기**다.
 */
function PersonaPeek({ pkg, file, onOpen }: { pkg: string; file: string; onOpen: () => void }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    void draftReadFile(pkg, file)
      .then((r) => { if (on) setText(r.content ?? ""); })
      .catch(() => { if (on) setText(""); });
    return () => { on = false; };
  }, [pkg, file]);
  // 제목 줄(#)과 빈 줄은 걷어낸다 — 사람이 알아볼 문장만 남긴다
  const peek = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("---"))
    .slice(0, 3)
    .join(" ");
  return (
    <div className="st-persona">
      <div className="st-persona-h">
        <Label>성격과 역할</Label>
        <Button variant="outline" size="sm" type="button" onClick={onOpen}>글 고치기</Button>
      </div>
      <p className="st-persona-t">{text == null ? "여는 중…" : peek || "아직 아무것도 적히지 않았습니다"}</p>
    </div>
  );
}

/**
 * 쓸 수 있는 기능 — **상태 한 줄이 먼저**고, 칩은 고치겠다고 할 때만 나온다.
 *
 * 종전에는 낱개 13개 + 묶음 4개가 한 벌로 쏟아졌다. 그 벽에서 읽히는 것은 아무것도 없었다:
 * 칩은 전부 파일 이름(campaign-delete)이라 뜻이 없고, 실제 상태는 "묶음 넷이 열셋을 전부 켠다"
 * 는 아주 단순한 것인데 화면은 그 **기제**를 보여주느라 결과를 감췄다(2026-08-28).
 *
 * 이름 대신 서술을 쓴다 — pkg-verbs 가 코드에서 뽑아 둔 그 한 줄이고, 왼쪽 문장이 쓰는 것과
 * 같은 것이다. 없으면 그때만 파일 이름으로 물러선다.
 */
function VerbPicks({ all, value, labels, onChange }: { all: string[]; value: string[]; labels?: Record<string, string>; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const globs = value.filter((v) => v.includes("*"));
  const on = new Set(matchScripts(value, all));
  for (const v of value) if (!v.includes("*") && all.includes(v)) on.add(v);
  const label = (v: string) => labels?.[v] ?? v;
  const state = !all.length ? "아직 기능이 없습니다"
    : on.size === 0 ? "아직 하나도 고르지 않았습니다"
    : on.size === all.length ? `전부 ${all.length}가지를 씁니다`
    : `${all.length}가지 중 ${on.size}가지를 씁니다`;
  return (
    <div className="st-verbs" title="relay.yaml: agents[].scripts">
      <div className="st-verbs-h">
        <Label>쓸 수 있는 기능</Label>
        {all.length ? (
          <Button variant="outline" size="sm" type="button" onClick={() => setOpen((v) => !v)}>{open ? "닫기" : "고르기"}</Button>
        ) : null}
      </div>
      <p className="st-verbs-s">{state}</p>
      {/* 개수만으로는 "무엇을 할 수 있나" 가 안 보인다. 접힌 상태에서도 몇 개는 사람 말로 낸다 */}
      {!open && all.length && on.size ? (
        <p className="st-verbs-p">
          {all.filter((v) => on.has(v)).slice(0, 3).map((v) => (labels?.[v] ?? v).replace(/[.。]\s*$/, "")).join(" · ")}
          {on.size > 3 ? ` · 외 ${on.size - 3}가지` : ""}
        </p>
      ) : null}
      {open && all.length ? (
        <>
          {/* 칩이 아니라 **목록 행**이다. 서술은 문장 길이라("그랜드슬램 오퍼 워크북에서 확정한
              답을 …") 칩에 넣으면 두 줄로 감기고, 칩의 고정폭 글꼴은 한국어 자간을 벌려 놓는다 */}
          <ul className="st-verbl">
            {all.map((v) => {
              const byGlob = !value.includes(v) && on.has(v) ? globs.find((g) => new RegExp("^" + g.split("*").join(".*") + "$").test(v)) : null;
              const checked = value.includes(v) || !!byGlob;
              const t = label(v);
              return (
                <li key={v}>
                  <button
                    type="button"
                    className="st-verbl-r"
                    aria-pressed={checked}
                    disabled={!!byGlob}
                    title={byGlob ? `${byGlob} 묶음으로 켜져 있습니다 — 끄려면 아래 묶음을 빼세요` : v}
                    onClick={() => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v])}
                  >
                    <span className="st-verbl-c" aria-hidden="true">{checked ? "✓" : ""}</span>
                    <span className="st-verbl-t">{t === v ? v : t.replace(/[.。]\s*$/, "")}</span>
                    {t === v ? null : <span className="st-verbl-i">{v}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
          {globs.length ? (
            <>
              <p className="st-verbs-g">묶음 — 이름이 맞는 기능은 나중에 만들어도 저절로 켜집니다</p>
              <div className="st-picks">
                {globs.map((g) => (
                  <button key={g} type="button" className="st-pick" aria-pressed title={`${g.replace("*", "")} 로 시작하는 것 전부 — 누르면 뺍니다`} onClick={() => onChange(value.filter((x) => x !== g))}>
                    {g}
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function AgentItem({ id, ctx, verbLabels }: { id: string; ctx: SectionCtx; verbLabels?: Record<string, string> }) {
  const m = ctx.manifest;
  const idx = (m.agents ?? []).findIndex((a) => a.name === id);
  const a = (m.agents ?? [])[idx];
  if (!a) return <div className="empty">없는 에이전트</div>;
  const src = m.scripts?.source;
  // 고를 수 있는 기능 — scripts.source 바로 아래 *.ts (도우미 파일은 동사가 아니다)
  const verbs = src
    ? ctx.files.filter((f) => f.startsWith(src + "/") && f.endsWith(".ts") && !f.slice(src.length + 1).includes("/")).map((f) => f.slice(src.length + 1, -3))
    : [];
  const others = (m.agents ?? []).filter((x) => x.name !== a.name).map((x) => ({ id: x.name }));
  const personaOk = !!a.persona && ctx.files.includes(a.persona);
  return (
    <div className="st-form">
      {/* 성격과 역할 글 — 이 에이전트의 핵심. 경로 카드가 아니라 "열기" 버튼 */}
      {personaOk ? (
        <PersonaPeek pkg={ctx.pkg} file={a.persona!} onOpen={() => ctx.openFile(a.persona!)} />
      ) : a.persona ? (
        <button type="button" className="st-open missing" onClick={() => ctx.createFile(a.persona!, `당신은 ${a.name}입니다.\n`)}>
          <span className="st-open-t">성격과 역할 쓰기</span>
          <span className="st-open-s">아직 비어 있습니다</span>
        </button>
      ) : null}
      <Field label="첫 인사" k="greeting" value={a.greeting ?? ""} placeholder="무엇을 도와드릴까요?" onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "greeting"], x))} />
      <VerbPicks
        all={verbs}
        value={a.scripts ?? []}
        labels={verbLabels}
        onChange={(v) => ctx.apply((d) => set(d, ["agents", idx, "scripts"], v))}
      />
      {others.length ? (
        <div className="flex flex-col gap-1.5" title="relay.yaml: agents[].dispatch">
          <Label>일을 넘길 도우미</Label>
          <Picks value={a.dispatch ?? []} options={others} empty="" onChange={(v) => ctx.apply((d) => set(d, ["agents", idx, "dispatch"], v))} />
        </div>
      ) : null}
      <SkillList agent={a.name} dir={a.skills} ctx={ctx} />
      {a.commands ? <FileGroup title="명령" dir={a.commands} ctx={ctx} /> : null}
      <Button
        variant="outline"
        size="sm"
        className="self-start st-remove"
        title="선언에서만 뺍니다 — 파일은 남습니다"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["agents", idx]));
          ctx.openItem(null);
        }}
      >
        빼기
      </Button>
    </div>
  );
}

function ScriptsLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const items = def.items!(m, ctx.files);
  const [name, setName] = useState("");
  const src = m.scripts?.source;
  const [busy, make] = useMake(ctx);
  return (
    <>
      {src ? <ItemList def={def} items={items} ctx={ctx} /> : null}
      <div className="lv-in">
        <Input placeholder="기능 이름 (예: report-weekly)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" disabled={busy || !slugOk(name)} onClick={() => { make("script", name); setName(""); }}>
          추가
        </Button>
      </div>
      {!src ? <p className="st-hintline">첫 기능을 만들면 기능 폴더도 같이 생깁니다.</p> : null}
    </>
  );
}

function ScriptItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const src = ctx.manifest.scripts?.source;
  const f = `${src}/${id}.ts`;
  useEffect(() => {
    if (src && ctx.files.includes(f)) ctx.openFile(f);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <div className="empty">{ctx.files.includes(f) ? `${f} — 가운데 칸에서 고칩니다` : `${f} 없음`}</div>;
}

function ServicesLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const items = def.items!(ctx.manifest, ctx.files);
  const [name, setName] = useState("");
  // 문법의 네 형(source | url | api | dir) 그대로 — source 만 컨테이너/프로세스 둘로 갈라 고른다.
  // api 가 빠져 있던 동안(2026-08-28 이전) REST 서비스는 스튜디오에서 만들 수도 고칠 수도 없었다
  const [form, setForm] = useState<"process" | "container" | "url" | "api" | "dir">("process");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <Input placeholder="자원 이름" style={{ maxWidth: 160 }} value={name} onChange={(e) => setName(e.target.value)} />
        <select value={form} onChange={(e) => setForm(e.target.value as never)}>
          <option value="process">프로세스</option>
          <option value="container">컨테이너</option>
          <option value="url">바깥 도구 (원격 MCP)</option>
          <option value="api">바깥 서비스 (REST)</option>
          <option value="dir">폴더</option>
        </select>
        <Button
          size="sm"
          disabled={busy || !slugOk(name)}
          onClick={() => {
            make(`service-${form}`, name);
            setName("");
          }}
        >
          추가
        </Button>
      </div>
    </>
  );
}

function ServiceItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = (m.services ?? []).findIndex((s) => s.name === id);
  const s = (m.services ?? [])[idx];
  if (!s) return <div className="empty">없는 서비스</div>;
  const p = (k: string) => ["services", idx, k];
  const item = { files: ctx.files.filter((f) => (s.source ? f.startsWith(s.source + "/") : false)) };
  return (
    <div className="st-form">
      {s.url != null ? (
        <>
          <Field label="원격 도구 주소" k="url" value={s.url} mono onCommit={(x) => ctx.apply((d) => set(d, p("url"), x))} />
          <Field label="남에게 raw 로 빌려줄 수 있는 도구 (쉼표)" hint="이 서버의 도구 중 다른 앱의 에이전트가 raw 로 만져도 되는 것. 내 에이전트는 이 도구를 직접 보지 않고 동사가 ctx.service(이름).call(도구, 인자) 로 감싸서 씁니다. 상대 앱은 edges 에 agent_access: full 을 선언해야 열립니다" k="tools" value={(s.tools ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, p("tools"), listField(x)))} />
          <AuthEditor idx={idx} s={s} ctx={ctx} />
        </>
      ) : s.api != null ? (
        <>
          <Field label="REST 베이스 주소" hint="동사의 요청은 이 접두 밖으로 나가지 못합니다 — 자격은 기판이 헤더로 붙이고, 동사는 ctx.service(이름).fetch(경로) 로 부릅니다" k="api" value={s.api} mono onCommit={(x) => ctx.apply((d) => set(d, p("api"), x))} />
          <AuthEditor idx={idx} s={s} ctx={ctx} />
        </>
      ) : s.dir != null ? (
        <DirField name={s.name} dir={s.dir} ctx={ctx} onCommit={(x) => ctx.apply((d) => set(d, p("dir"), x))} />
      ) : (
        <>
          <Field label="프로그램 폴더" k="source" value={s.source ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("source"), x))} />
          <Field label="시작 파일" k="entry" value={s.entry ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("entry"), x))} />
          <Field label="Dockerfile" hint="컨테이너로 띄울 때만" k="dockerfile" value={s.dockerfile ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("dockerfile"), x))} />
          <Field label="포트" k="port" value={s.port != null ? String(s.port) : ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("port"), x ? Number(x) : ""))} />
        </>
      )}
      <FileCards item={item} ctx={ctx} />
      <RemoveService name={s.name} isDir={s.dir != null} ctx={ctx} onRemove={() => { ctx.apply((d) => d.deleteIn(["services", idx])); ctx.openItem(null); }} />
    </div>
  );
}

/**
 * 폴더 칸 — 경로는 **가는 곳**이지 다시 타이핑할 문자열이 아니다. [열기] 가 파일 탐색기로 연다
 * (경로는 장부가 답한다: /pkg/<이름>/dir/<서비스>/open).
 *
 * 그리고 고치면 무슨 일이 생기는지 칸 옆에서 말한다. 종전에는 문법만 설명하고("상대경로면 이
 * 앱의 것…") 결과를 말하지 않아, 경로를 바꾸면 파일이 따라 옮겨지는지 아닌지를 알 수 없었다.
 */
function DirField({ name, dir, ctx, onCommit }: { name: string; dir: string; ctx: SectionCtx; onCommit: (v: string) => void }) {
  const [entries, setEntries] = useState<{ path: string; dir: boolean; bytes?: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  // 바꾼 직후 한 줄 — 결과는 **일어난 자리에서** 말한다. 상설 안내문으로 세워 두면 아직 아무것도
  // 안 한 사람에게도 늘 붙어 있어 자리만 먹는다(2026-08-28)
  const [moved, setMoved] = useState<{ from: string; to: string } | null>(null);

  // 무엇이 들어 있나 — 세션이 dir__*__list 로 보는 것과 같은 목록이다
  useEffect(() => {
    let on = true;
    setEntries(null);
    setErr(null);
    void fetch(`/pkg/${encodeURIComponent(ctx.pkg)}/dir/${encodeURIComponent(name)}/list`)
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!on) return;
        if (r.ok) setEntries(b.entries ?? []);
        else setErr(b.error ?? "폴더를 읽지 못했습니다");
      })
      .catch(() => { if (on) setErr("기판에 닿지 않습니다"); });
    return () => { on = false; };
  }, [ctx.pkg, name, dir]);

  // 경로는 타이핑하는 것이 아니라 **고르는** 것이다. 브라우저 API 로는 절대경로를 얻을 수 없어서
  // (showDirectoryPicker·webkitdirectory 둘 다 설계상 주지 않는다) 기판이 네이티브 탐색기를 연다.
  //
  // 직접 쓰는 칸은 두지 않는다. 세상의 dir 선언은 전부 ~/… 이고(상대경로를 쓴 매니페스트가 하나도
  // 없다), 없는 폴더는 탐색기의 [새 폴더]가 만든다. 폼이 표현 못 하는 값이 필요하면 탈출구는
  // 칸을 하나 더 두는 것이 아니라 매니페스트 편집기다 — 그쪽이 문법 전체를 이미 감당한다
  const pick = async () => {
    setErr(null);
    setPicking(true);
    try {
      const r = await fetch("/pick/dir", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: `${name} 폴더를 고르세요` }) });
      const b = await r.json().catch(() => ({}));
      if (b.dir && b.dir !== dir) { setMoved({ from: dir, to: b.dir }); onCommit(b.dir); }
      else if (b.error) setErr(`${b.error} — 기타 파일의 relay.yaml 에서 직접 고칠 수 있습니다`);
      // 취소는 아무 일도 일어나지 않는 것이 맞다
    } catch {
      setErr("기판에 닿지 않습니다");
    } finally {
      setPicking(false);
    }
  };
  const open = () => { void fetch(`/pkg/${encodeURIComponent(ctx.pkg)}/dir/${encodeURIComponent(name)}/open`, { method: "POST" }).catch(() => {}); };

  const files = entries?.filter((e) => !e.dir) ?? [];
  const dirs = entries?.filter((e) => e.dir) ?? [];
  const CAP = 6;
  return (
    <div className="st-dirview">
      {/* 머리 — 무엇이 들어 있나. 경로는 문장에서 이미 눌러서 왔으니 되풀이하지 않는다 */}
      <p className="st-dirview-h">
        {err ? "안을 볼 수 없습니다"
          : entries == null ? "여는 중…"
          : entries.length === 0 ? "아직 비어 있습니다"
          : `파일 ${files.length}개${dirs.length ? ` · 하위 폴더 ${dirs.length}개` : ""}`}
      </p>
      {err ? <p className="st-hintline warn">{err}</p> : null}
      {entries?.length ? (
        <ul className="st-dirview-l">
          {entries.slice(0, CAP).map((e) => (
            <li key={e.path}>
              <span className="st-dirview-n">{e.dir ? `${e.path}/` : e.path}</span>
              {!e.dir && e.bytes != null ? <span className="st-dirview-b">{bytesLabel(e.bytes)}</span> : null}
            </li>
          ))}
          {entries.length > CAP ? <li className="more">{entries.length - CAP}개 더</li> : null}
        </ul>
      ) : null}
      <div className="st-dirview-a">
        <Button variant="outline" size="sm" type="button" onClick={open}>탐색기에서 열기 ↗</Button>
        <Button variant="outline" size="sm" type="button" disabled={picking} title="이 에이전트가 쓸 폴더를 다른 것으로 바꿉니다" onClick={() => void pick()}>
          {picking ? "고르는 중…" : "쓸 폴더 바꾸기"}
        </Button>
      </div>
      {moved ? (
        <p className="st-hintline">이제 <b>{moved.to}</b> 를 씁니다 — {moved.from} 의 파일은 옮겨지지 않고 그대로 있습니다.</p>
      ) : null}
    </div>
  );
}

/** 파일 크기 — 사람이 읽는 자리라 자릿수를 줄인다 */
function bytesLabel(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 빼기 — 무엇이 멈추고 무엇이 남는지 먼저 말한다. 파일은 하나도 지워지지 않는다 */
function RemoveService({ name, isDir, ctx, onRemove }: { name: string; isDir: boolean; ctx: SectionCtx; onRemove: () => void }) {
  const [sure, setSure] = useState(false);
  // 이 폴더를 쓰기로 선언한 에이전트 — 빼면 그 에이전트의 dir__* 도구가 함께 사라진다
  const users = (ctx.manifest.agents ?? []).filter((a) => (a.dirs ?? []).includes(name)).map((a) => a.name);
  if (!sure) {
    return (
      <Button variant="outline" size="sm" className="self-start st-remove" type="button" onClick={() => setSure(true)}>빼기</Button>
    );
  }
  return (
    <div className="st-confirm">
      <p>
        {users.length ? `${users.join(", ")} 이(가) 이 ${isDir ? "폴더" : "자원"}를 못 쓰게 됩니다. ` : ""}
        {isDir ? "폴더와 안의 파일은 그대로 있습니다 — 이 에이전트만 못 보게 됩니다." : "선언만 빠집니다 — 파일은 그대로 있습니다."}
      </p>
      <div className="st-confirm-b">
        <Button variant="outline" size="sm" type="button" onClick={() => setSure(false)}>그만두기</Button>
        <Button variant="outline" size="sm" className="st-remove" type="button" onClick={onRemove}>빼기</Button>
      </div>
    </div>
  );
}

function TriggersLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const items = def.items!(ctx.manifest, ctx.files);
  const [id, setId] = useState("");
  const [kind, setKind] = useState<"cron" | "event">("cron");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <Input placeholder="예약 이름 (예: daily-digest)" value={id} onChange={(e) => setId(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          <option value="cron">정해진 때</option>
          <option value="event">사건이 나면</option>
        </select>
        <Button size="sm" disabled={busy || !slugOk(id)} onClick={() => { make(`trigger-${kind}`, id); setId(""); }}>
          추가
        </Button>
      </div>
    </>
  );
}

/**
 * cron 고르개 — 다섯 칸의 문법 대신 주기·요일·시각을 고른다. 고른 결과를 그 자리에서 사람 말로
 * 되읽어 준다(cronToKorean): 만든 것과 목록에 뜰 말이 같아야 자기가 만든 것을 알아본다.
 * 번역표 밖의 식(0 9 * * 1,3,5)은 고르개를 세우지 않고 날식 칸으로 남는다 — 손으로 쓴 것을
 * 고르개가 조용히 뭉개면 안 된다.
 */
function CronPicker({ value, onChange, onEvent }: { value: string; onChange: (expr: string) => void; onEvent: () => void }) {
  const uid = useId();
  const pick = parseCron(value);
  if (!pick) {
    return (
      <>
        <Field label="시각" hint="직접 쓴 식이라 고르개로 못 바꿉니다" k="cron" value={value} mono onCommit={onChange} />
        <Button variant="outline" size="sm" className="self-start" onClick={() => onChange("0 9 * * *")}>고르개로 바꾸기</Button>
      </>
    );
  }
  const put = (over: Partial<CronPick>) => onChange(buildCron({ ...pick, ...over }));
  const hhmm = `${String(pick.hour ?? 9).padStart(2, "0")}:${String(pick.min ?? 0).padStart(2, "0")}`;
  return (
    <div className="st-field">
      <Label htmlFor={`${uid}-e`}>언제</Label>
      <div className="st-cron">
        <select
          id={`${uid}-e`}
          value={pick.every}
          onChange={(e) => {
            if (e.target.value === "event") return onEvent();
            const every = e.target.value as CronPick["every"];
            onChange(buildCron({ every, dow: pick.dow ?? 1, hour: pick.hour ?? 9, min: pick.min ?? 0, n: pick.n ?? (every === "hours" ? 3 : 10) }));
          }}
        >
          <option value="day">매일</option>
          <option value="weekday">평일(월~금)</option>
          <option value="week">매주</option>
          <option value="hour">매시간</option>
          <option value="hours">몇 시간마다</option>
          <option value="minutes">몇 분마다</option>
          <option value="event">사건이 나면</option>
        </select>
        {pick.every === "week" ? (
          <select value={pick.dow ?? 1} onChange={(e) => put({ dow: Number(e.target.value) })}>
            {DOW_LABEL.map((d) => <option key={d.v} value={d.v}>{d.label}</option>)}
          </select>
        ) : null}
        {pick.every === "day" || pick.every === "weekday" || pick.every === "week" ? (
          <input
            type="time"
            value={hhmm}
            onChange={(e) => {
              const [h, mi] = e.target.value.split(":").map(Number);
              if (Number.isFinite(h) && Number.isFinite(mi)) put({ hour: h, min: mi });
            }}
          />
        ) : null}
        {pick.every === "hour" ? (
          <label className="st-cron-n">매시 <input type="number" min={0} max={59} value={pick.min ?? 0} onChange={(e) => put({ min: Math.max(0, Math.min(59, Number(e.target.value) || 0)) })} /> 분</label>
        ) : null}
        {pick.every === "hours" || pick.every === "minutes" ? (
          <label className="st-cron-n"><input type="number" min={1} max={pick.every === "hours" ? 23 : 59} value={pick.n ?? 1} onChange={(e) => put({ n: Math.max(1, Number(e.target.value) || 1) })} /> {pick.every === "hours" ? "시간마다" : "분마다"}</label>
        ) : null}
      </div>
      {/* 고른 것을 그 자리에서 되읽어 준다 — 목록에 뜰 말과 같은 말이다 */}
      <p className="st-cron-say">{cronToKorean(value) ?? value}</p>
    </div>
  );
}

function TriggerItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = (m.triggers ?? []).findIndex((t) => t.id === id);
  const t = (m.triggers ?? [])[idx];
  const uid = useId();
  if (!t) return <div className="empty">없는 트리거</div>;
  const kind = t.when?.event != null ? "event" : "cron";
  const thenKind = t.then?.script != null ? "script" : "agent";
  return (
    <div className="st-form">
      {kind === "cron" ? (
        <>
          <CronPicker
            value={t.when?.cron ?? ""}
            onChange={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "cron"], x))}
            onEvent={() => ctx.apply((d) => d.setIn(["triggers", idx, "when"], { event: "relay.package.installed" }))}
          />
          <Advanced><Field label="시간대" k="tz" value={t.when?.tz ?? ""} mono placeholder="Asia/Seoul" onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "tz"], x))} /></Advanced>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-when`}>언제</Label>
            <select id={`${uid}-when`} value="event" onChange={() => ctx.apply((d) => d.setIn(["triggers", idx, "when"], { cron: "0 9 * * *", tz: "Asia/Seoul" }))}>
              <option value="event">사건이 나면</option>
              <option value="day">정해진 때 (매일·매주…)</option>
            </select>
          </div>
          <Field label="사건 이름" k="event" value={t.when?.event ?? ""} mono placeholder="relay.package.installed" onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "event"], x))} />
          <Advanced open={t.when?.debounce_ms != null}><Field label="묶어서 기다릴 시간" hint="밀리초" k="debounce_ms" value={t.when?.debounce_ms != null ? String(t.when.debounce_ms) : ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "debounce_ms"], x ? Number(x) : ""))} /></Advanced>
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-then`}>그때 무엇을</Label>
        <select
          id={`${uid}-then`}
          value={thenKind}
          onChange={(e) =>
            ctx.apply((d) =>
              d.setIn(["triggers", idx, "then"], e.target.value === "agent" ? { agent: (m.agents ?? [])[0]?.name ?? "", prompt: "" } : { script: "" }),
            )
          }
        >
          <option value="agent">에이전트를 깨웁니다</option>
          <option value="script">기능 하나를 돌립니다</option>
        </select>
      </div>
      {thenKind === "agent" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-agent`}>누구를</Label>
            <select id={`${uid}-agent`} value={t.then?.agent ?? ""} onChange={(e) => ctx.apply((d) => d.setIn(["triggers", idx, "then", "agent"], e.target.value))}>
              {(m.agents ?? []).map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <Field label="시킬 말" k="prompt" value={t.then?.prompt ?? ""} onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "prompt"], x))} />
          <Field label="결과를 보낼 곳" hint="비우면 안 보냅니다" k="delivery" placeholder="slack:general" value={t.then?.delivery ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "delivery"], x))} />
          <Advanced open={!!t.then?.route}><Field label="열어 줄 화면 경로" k="route" value={t.then?.route ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "route"], x))} /></Advanced>
        </>
      ) : (
        <Field label="돌릴 기능" k="script" value={t.then?.script ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "script"], x))} />
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start st-remove"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["triggers", idx]));
          ctx.openItem(null);
        }}
      >
        빼기
      </Button>
    </div>
  );
}

function MissionsLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const items = def.items!(ctx.manifest, ctx.files);
  const [name, setName] = useState("");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <Input placeholder="미션 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" disabled={busy || !slugOk(name)} onClick={() => { make("mission", name); setName(""); }}>
          추가
        </Button>
      </div>
    </>
  );
}

function MissionItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = (m.missions ?? []).findIndex((x) => x.name === id);
  const ms = (m.missions ?? [])[idx];
  if (!ms) return <div className="empty">없는 미션</div>;
  return (
    <div className="st-form">
      <Field label="이름" k="name" value={ms.name} onCommit={(x) => ctx.apply((d) => set(d, ["missions", idx, "name"], x))} />
      <Field label="설명" hint="일을 맡기는 쪽이 읽습니다" placeholder="이 일이 무엇을 해 주는지 한 줄" k="description" value={ms.description ?? ""} onCommit={(x) => ctx.apply((d) => set(d, ["missions", idx, "description"], x))} />
      <Button
        variant="outline"
        size="sm"
        className="self-start st-remove"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["missions", idx]));
          ctx.openItem(null);
        }}
      >
        빼기
      </Button>
    </div>
  );
}

function EdgesLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const items = def.items!(ctx.manifest, ctx.files);
  const [provider, setProvider] = useState("");
  const [kind, setKind] = useState<"tools" | "mission" | "components">("tools");
  const [mission, setMission] = useState("");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <Input placeholder="빌려 쓸 앱 (@scope/name)" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          <option value="tools">동사 쓰기</option>
          <option value="mission">일 맡기기</option>
          <option value="components">부품 끼우기</option>
        </select>
        {kind === "mission" ? (
          <Input placeholder="미션 이름" style={{ maxWidth: 150 }} value={mission} onChange={(e) => setMission(e.target.value)} />
        ) : null}
        <Button
          size="sm"
          disabled={busy || !provider.trim() || (kind === "mission" && !slugOk(mission))}
          onClick={() => { make(`edge-${kind}`, provider, mission); setProvider(""); setMission(""); }}
        >
          추가
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">여기 적는 것은 신청입니다 — 허락은 설정의 연결 지도에서 합니다.</p>
    </>
  );
}

function EdgeItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = Number(id);
  const e = (m.edges ?? [])[idx];
  const uid = useId();
  if (!e) return <div className="empty">없는 edge</div>;
  // 소비물은 셋 중 정확히 하나다(스키마의 not.anyOf). 세 칸을 나란히 두면 문법이 금지한 조합을
  // 화면이 먼저 권하는 꼴이라, 배타를 라디오로 그린다 — 고르면 나머지 둘은 문서에서 지운다
  const kind: "tools" | "mission" | "components" = e.components ? "components" : e.mission != null ? "mission" : "tools";
  const pick = (k: "tools" | "mission" | "components") =>
    ctx.apply((d) => {
      d.deleteIn(["edges", idx, "tools"]);
      d.deleteIn(["edges", idx, "mission"]);
      d.deleteIn(["edges", idx, "components"]);
      d.deleteIn(["edges", idx, "agent_access"]); // tools 형에만 있는 축 — 형이 바뀌면 같이 지운다
      if (k === "components") d.setIn(["edges", idx, "components"], true);
      else if (k === "mission") d.setIn(["edges", idx, "mission"], "");
      else d.setIn(["edges", idx, "tools"], []);
    });
  return (
    <div className="st-form">
      <Field label="빌려 쓸 앱" placeholder="@scope/name" k="provider" value={e.provider} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "provider"], x))} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-kind`}>무엇을 빌리나</Label>
        <select id={`${uid}-kind`} value={kind} onChange={(ev) => pick(ev.target.value as never)}>
          <option value="tools">기능</option>
          <option value="mission">일 맡기기</option>
          <option value="components">화면 부품</option>
        </select>
        <p className="st-hintline">
          {kind === "tools" ? "그 앱의 기능을 내가 부릅니다" : kind === "mission" ? "그 앱에 일을 통째로 넘깁니다" : "그 앱의 부품을 내 화면에 끼웁니다"}
        </p>
      </div>
      {kind === "tools" ? (
        <>
          <Field label="빌려 쓸 기능 (쉼표)" k="tools" value={(e.tools ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "tools"], listField(x)))} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-access`} className="text-xs text-muted-foreground">에이전트가 만지는 것</Label>
            {/* raw 는 명시 opt-in — 기본(미선언)은 그 앱의 동사뿐이다. 미선언과 scripts-only 를 한 값으로
                그린다: 문서에 기본값을 적어 두면 뜻은 같은데 diff 만 생긴다 */}
            <select
              id={`${uid}-access`}
              value={e.agent_access === "full" ? "full" : "scripts-only"}
              onChange={(ev) =>
                ctx.apply((d) => {
                  if (ev.target.value === "full") d.setIn(["edges", idx, "agent_access"], "full");
                  else d.deleteIn(["edges", idx, "agent_access"]);
                })
              }
            >
              <option value="scripts-only">그 앱의 동사만 (기본)</option>
              <option value="full">그 앱이 열어 둔 raw 도구까지 (full)</option>
            </select>
            <p className="text-xs text-muted-foreground">
              raw 는 그 앱이 url 서비스의 tools 에 열어 둔 원격 MCP 도구를 내 에이전트가 직접 만지는 것입니다. 허락 화면에 raw 로 표시되고, 없으면 raw 전용 기능은 허락 자체가 거부됩니다.
            </p>
          </div>
        </>
      ) : kind === "mission" ? (
        <Field label="맡길 일" placeholder="상대가 내놓은 일의 이름" k="mission" value={e.mission ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "mission"], x))} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {`정할 것이 없습니다. 승인되면 상대 화면에서 import { mount } from "${e.provider}" 로 바로 쓸 수 있고, 주소는 기판이 붙여 줍니다.`}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start st-remove"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["edges", idx]));
          ctx.openItem(null);
        }}
      >
        빼기
      </Button>
    </div>
  );
}

/**
 * credential — 채널 자격의 **형태** 선언. 값이 아니다(값은 vault 에 산다).
 *
 * 이 선언이 곧 연결 화면의 입력 칸이라, 저작자가 여기서 고치는 것은 남이 보게 될 폼이다.
 * 그래서 오른쪽 결과면이 같은 선언으로 그 폼을 그대로 그린다 — 선언과 결과가 한 화면에 있다.
 * 칸 편집기는 서비스 auth.fields 와 한 벌(FieldsEditor) — 채널에는 header 축만 없다
 */
function CredentialFields({ idx, ch, ctx }: { idx: number; ch: { credential?: { fields?: CredentialField[] } }; ctx: SectionCtx }) {
  return <FieldsEditor base={["surfaces", "channels", idx, "credential", "fields"]} fields={ch.credential?.fields ?? []} ctx={ctx} />;
}

/**
 * 바깥 서비스(url·api)의 자격 계약 — 값이 아니라 형태다. 로그인 방식·헤더 접두·필수 여부·발급처·
 * 검증 주소·입력 칸. 이 선언이 곧 연결 화면의 줄과 폼이라, 저작자가 여기서 고치는 것은 남이 보게
 * 될 폼이다. 종전의 "토큰을 넣어 줄 환경변수 이름(auth.env)" 은 llm 자격의 어휘를 서비스에 잘못
 * 얹은 것이었다 — 서비스 자격은 env 로 안 나가고 기판이 호출 시점에 헤더로 붙인다
 */
function AuthEditor({ idx, s, ctx }: { idx: number; s: ServiceDecl; ctx: SectionCtx }) {
  const uid = useId();
  const a = s.auth;
  const kind = a?.kind ?? "none";
  const at = (k: string) => ["services", idx, "auth", k];
  const isApi = s.api != null;
  const injectAt: "header" | "query" | "form" = a?.inject?.query != null ? "query" : a?.inject?.form != null ? "form" : "header";
  const injectName = a?.inject?.query ?? a?.inject?.form ?? "";
  return (
    <div className="st-form">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-auth`} className="text-xs text-muted-foreground">로그인 방식</Label>
        <select
          id={`${uid}-auth`}
          value={kind}
          onChange={(e) =>
            ctx.apply((d) => {
              const v = e.target.value;
              // 형이 바뀌면 그 형에 없는 축은 같이 지운다 — 남겨 두면 판정이 "token 형에서만" 으로 막는다.
              // oauth 형에도 칸은 있다(로그인이 주지 않는 부속 값) — 지울 것은 헤더 접두와 header 표시뿐이다
              if (v === "none") d.setIn(["services", idx, "auth"], { kind: "none" });
              else {
                d.setIn(at("kind"), v);
                if (v === "oauth") {
                  d.deleteIn(at("scheme"));
                  for (let i = 0; i < (s.auth?.fields ?? []).length; i++) d.deleteIn([...at("fields"), i, "header"]);
                }
              }
            })
          }
        >
          <option value="none">없음</option>
          <option value="token">토큰</option>
          <option value="oauth">OAuth 로그인</option>
        </select>
      </div>
      {kind !== "none" ? (
        <>
          <Label className="flex-none text-xs font-normal">
            <Checkbox checked={a?.required !== false} onCheckedChange={(c) => ctx.apply((d) => (c ? d.deleteIn(at("required")) : d.setIn(at("required"), false)))} />
            필수 — 없으면 이 앱의 주 기능이 서지 않습니다 (끄면 선택: 없어도 돌고 그 기능만 꺼집니다)
          </Label>
          <Label className="flex-none text-xs font-normal">
            <Checkbox
              checked={a?.accounts === true}
              onCheckedChange={(c) => ctx.apply((d) => (c ? d.setIn(at("accounts"), true) : d.deleteIn(at("accounts"))))}
            />
            계정이 여럿 — 같은 서비스에 계정마다 자격을 따로 앉힙니다 (동사는 ctx.service(…).account(&lt;계정&gt;) 으로 고릅니다)
          </Label>
          {isApi ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${uid}-inject`} className="text-xs text-muted-foreground">자격이 실리는 자리</Label>
              <select
                id={`${uid}-inject`}
                value={injectAt}
                onChange={(e) =>
                  ctx.apply((d) => {
                    const v = e.target.value;
                    if (v === "header") d.deleteIn(at("inject"));
                    else {
                      // 헤더 접두는 헤더로 나갈 때만 뜻이 있다 — 남겨 두면 판정이 막는다
                      d.deleteIn(at("scheme"));
                      d.setIn(at("inject"), v === "query" ? { query: injectName || "access_token" } : { form: injectName || "access_token" });
                    }
                  })
                }
              >
                <option value="header">인증 헤더 (기본)</option>
                <option value="query">질의 파라미터</option>
                <option value="form">폼 파라미터</option>
              </select>
            </div>
          ) : null}
          {injectAt !== "header" ? (
            <Field
              label="파라미터 이름"
              hint="이 이름으로 자격이 실립니다 (예: access_token)"
              k="auth.inject"
              value={injectName}
              mono
              placeholder="access_token"
              onCommit={(x) => ctx.apply((d) => d.setIn(at("inject"), injectAt === "query" ? { query: x } : { form: x }))}
            />
          ) : null}
          {kind === "token" && injectAt === "header" ? (
            <Field label="인증 헤더 접두" hint="비우면 Bearer. Unsplash 처럼 다른 접두를 요구하면 적습니다 (예: Client-ID)" k="auth.scheme" value={a?.scheme ?? ""} mono placeholder="Bearer" onCommit={(x) => ctx.apply((d) => set(d, at("scheme"), x))} />
          ) : null}
          {kind === "oauth" ? (
            <>
              <Field
                label="등록된 앱의 client_id"
                hint="공개 식별자라 트리에 살 수 있습니다 — 적어 두면 연결 화면이 묻지 않습니다(사람이 넣을 것은 client_secret 뿐)"
                k="auth.oauth_client.client_id"
                value={a?.oauth_client?.client_id ?? ""}
                mono
                onCommit={(x) => ctx.apply((d) => set(d, [...at("oauth_client"), "client_id"], x))}
              />
              <Label className="flex-none text-xs font-normal">
                <Checkbox
                  checked={a?.oauth_client?.https === true}
                  onCheckedChange={(c) => ctx.apply((d) => (c ? d.setIn([...at("oauth_client"), "https"], true) : d.deleteIn([...at("oauth_client"), "https"])))}
                />
                콜백에 HTTPS 를 요구하는 제공자 — 기판의 TLS 문이 없으면 인가가 서지 않습니다
              </Label>
            </>
          ) : null}
          <Field label="발급처 주소" hint="연결 화면이 '발급처 열기' 링크로 그립니다" k="auth.help.url" value={a?.help?.url ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, [...at("help"), "url"], x))} />
          <Field label="안내 한 줄" hint="이 키가 있으면 무엇이 켜지는지 — 연결 화면이 그대로 보여 줍니다" k="auth.help.note" value={a?.help?.note ?? ""} onCommit={(x) => ctx.apply((d) => set(d, [...at("help"), "note"], x))} />
          <Field label="검증 주소" hint="저장된 자격으로 두드려 볼 주소 — 2xx 면 유효. 비우면 저장만 됩니다" k="auth.verify.url" value={a?.verify?.url ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, [...at("verify"), "url"], x))} />
          {/* 칸은 두 형 다 있다 — token 은 자격 그 자체를 받고(그중 하나가 헤더로 나간다),
              oauth 는 로그인이 주지 않는 부속 값만 받는다(헤더로 나가는 것은 번들의 access_token 이라 header 축이 없다) */}
          <FieldsEditor base={at("fields")} fields={a?.fields ?? []} ctx={ctx} header={kind === "token"} oauth={kind === "oauth"} />
        </>
      ) : null}
    </div>
  );
}

/**
 * 자격 입력 칸 편집기 — 채널 credential.fields 와 서비스 auth.fields 가 같은 편집기를 쓴다.
 * 비밀값을 받는 칸의 모양은 그 비밀이 들어오는 문에 쓰이든 나가는 문에 쓰이든 같기 때문이다.
 * header 는 서비스에서만 켜진다 — 그 칸의 값이 Authorization 으로 나간다(key 있는 칸 중 정확히 하나)
 */
function FieldsEditor({ base, fields, ctx, header, oauth }: { base: (string | number)[]; fields: CredentialField[]; ctx: SectionCtx; header?: boolean; oauth?: boolean }) {
  const at = (i: number, k: string) => [...base, i, k];
  const flags = header ? (["secret", "list", "required", "header"] as const) : (["secret", "list", "required"] as const);
  const keyed = fields.length > 0 && fields.every((f) => f.key);
  const headers = fields.filter((f) => f.header).length;
  return (
    <div className="st-form">
      <div className="rc-label">
        {oauth ? "부속 칸 — 로그인이 주지 않는 값(계정 번호·저장소 좌표). 인가와 함께 받습니다" : "로그인 정보 칸 — 연결 화면이 이대로 입력 칸을 그립니다"}
      </div>
      {fields.map((f, i) => (
        <div key={i} className="item">
          <div className="bar">
            <Input
              value={f.key ?? ""}
              placeholder="key — 비우면 값 하나"
              className="font-mono text-xs md:text-xs"
              onChange={(e) => ctx.apply((d) => set(d, at(i, "key"), e.target.value))}
            />
            <Input value={f.label} placeholder="사람이 읽는 이름" onChange={(e) => ctx.apply((d) => d.setIn(at(i, "label"), e.target.value))} />
            <Button variant="ghost" size="icon-xs" className="flex-none text-muted-foreground" title="이 칸 빼기" onClick={() => ctx.apply((d) => d.deleteIn([...base, i]))}>
              ×
            </Button>
          </div>
          <div className="bar text-xs text-muted-foreground">
            {flags.map((k) => (
              <Label key={k} className="flex-none text-xs font-normal" title={k === "header" ? "이 칸의 값이 인증 헤더로 나갑니다 — 하나만" : undefined}>
                <Checkbox checked={!!f[k]} onCheckedChange={(checked) => ctx.apply((d) => (checked ? d.setIn(at(i, k), true) : d.deleteIn(at(i, k))))} />
                {k}
              </Label>
            ))}
          </div>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() =>
          void ctx.apply((d) =>
            push(d, base, oauth ? { key: "user_id", label: "계정 번호" } : header ? { key: "token", label: "API 토큰", header: true } : { key: "token", label: "토큰", secret: true, required: true }),
          )
        }
      >
        + {oauth ? "부속 칸" : "자격 칸"}
      </Button>
      {fields.length ? (
        <p className="text-xs text-muted-foreground">
          {oauth
            ? keyed
              ? "모든 칸에 key 가 있으니 인가 번들 안에 JSON 으로 앉습니다. 비밀 아닌 칸은 동사가 fields() 로 읽습니다 — 헤더로 나가는 것은 번들의 access_token 이라 header 축은 없습니다."
              : "oauth 형의 칸에는 전부 key 가 있어야 합니다 — 번들 안의 JSON 이라 이름이 필요합니다."
            : keyed
              ? header && headers !== 1
                ? `key 있는 칸 중 정확히 하나에 header 를 켜세요 — 그 칸이 자격으로 나갑니다 (지금 ${headers}개).`
                : header
                  ? "모든 칸에 key 가 있으니 vault 에 JSON 으로 앉고, header 칸만 자격으로 나갑니다. 나머지 비밀 아닌 칸은 동사가 fields() 로 읽습니다."
                  : "모든 칸에 key 가 있으니 화면이 JSON 객체로 조립해 넘긴다."
              : fields.length === 1
                ? "key 없는 칸 하나 — 그 값이 곧 자격 문자열이다."
                : "key 있는 칸과 없는 칸을 섞으면 판정 실패다 — 전부 채우거나, 한 칸만 비우세요."}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {oauth ? "부속 칸이 없으면 인가가 주는 것만으로 자격이 완성됩니다." : "칸을 정하지 않으면 연결 화면은 붙여넣기 칸 하나로 물러납니다."}
        </p>
      )}
    </div>
  );
}

/** requires — 설치 관문. 여기까지는 폼이 없어 원문 에디터로 밀려나 있었다 */
function RequiresView({ ctx }: { ctx: SectionCtx }) {
  const req = ctx.manifest.requires;
  const bins = req?.binaries ?? [];
  const [name, setName] = useState("");
  const [busy, make] = useMake(ctx);
  return (
    <div className="st-form">
      <Field
        label="어느 운영체제에서" placeholder="darwin, linux, win32" k="os"
        value={(req?.os ?? []).join(", ")}
        mono
        onCommit={(x) => ctx.apply((d) => set(d, ["requires", "os"], listField(x)))}
      />
      <div className="rc-label">있어야 하는 명령줄 도구</div>
      {bins.map((b, i) => {
        // 엔진이 가리키는 도구는 여기서 뺄 수 없다 — 참조가 뜨면 판정이 설치를 막는다
        const usedBy = (ctx.manifest.harness?.variants ?? []).filter((v) => v.binary === b.name).map((v) => harnessLabel(v.name));
        return (
          <div key={b.name} className="st-file" style={{ cursor: "default" }}>
            <span className="st-file-path">{b.name}</span>
            {b.manager ? <span className="text-xs text-muted-foreground">기판이 깝니다</span> : null}
            {usedBy.length ? <span className="text-xs text-muted-foreground">{usedBy.join(", ")} 엔진이 씁니다</span> : null}
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={usedBy.length > 0}
              title={usedBy.length ? `${usedBy.join(", ")} 엔진을 빼면 함께 걷힙니다` : undefined}
              onClick={() => ctx.apply((d) => d.deleteIn(["requires", "binaries", i]))}
            >
              빼기
            </Button>
          </div>
        );
      })}
      <div className="lv-in">
        <Input placeholder="도구 이름 (예: git)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          size="sm"
          disabled={busy || !slugOk(name) || bins.some((b) => b.name === name.trim())}
          onClick={() => { make("requires-binary", name); setName(""); }}
        >
          추가
        </Button>
      </div>
      <details className="st-hint fold">
        <summary>기판이 대신 깔게 하려면</summary>
        {"이름만 적으면 그 도구가 없을 때 설치가 거부되고 안내가 뜹니다.\nrelay.yaml 에서 manager 와 package 를 함께 적으면 기판이 직접 깔아 줍니다."}
      </details>
    </div>
  );
}

/** host_methods — 고지서에 실리는 캡인데 저작 표면이 없었다 */
function HostMethodsView({ ctx }: { ctx: SectionCtx }) {
  const list = ctx.manifest.host_methods ?? [];
  const [v, setV] = useState("");
  const [busy, make] = useMake(ctx);
  return (
    <div className="st-form">
      {list.map((x, i) => (
        <div key={x} className="st-file" style={{ cursor: "default" }}>
          <span className="st-file-path">{x}</span>
          <Button variant="outline" size="sm" className="ml-auto" onClick={() => ctx.apply((d) => d.deleteIn(["host_methods", i]))}>
            빼기
          </Button>
        </div>
      ))}
      <div className="lv-in">
        <Input placeholder="host.draft_publish" value={v} onChange={(e) => setV(e.target.value)} className="font-mono text-xs md:text-xs" />
        <Button
          size="sm"
          disabled={busy || !/^host\.[A-Za-z0-9]+([._][A-Za-z0-9]+)*$/.test(v.trim()) || list.includes(v.trim())}
          onClick={() => { make("host-method", v); setV(""); }}
        >
          추가
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        선언이 없으면 전체가 열린다(ring-0 결재가 유일한 경계). 하나라도 선언하면 목록 밖 메서드는 거부된다 — 좁히는 선언이지 여는 선언이 아니다.
      </p>
    </div>
  );
}

function YamlOnly({ def }: { def: SectionDef }) {
  return <p className="text-xs text-muted-foreground">이 부분은 아직 폼이 없습니다 — 고급 › 기타 파일에서 relay.yaml 을 열어 직접 적으세요. 문법은 편집기가 잡아 줍니다.</p>;
}

function UnclaimedView({ ctx }: { ctx: SectionCtx }) {
  const extra = unclaimedFiles(ctx.manifest, ctx.files);
  const changed = new Set(ctx.changes.map((c) => c.file));
  return (
    <>
      <p className="text-xs text-muted-foreground">어느 항목에도 속하지 않은 파일. relay.yaml 이 가리키지 않는 파일은 설치본에 실리지 않습니다.</p>
      <div className="st-files">
        {extra.map((f) => (
          <div key={f} className="st-file" onClick={() => ctx.openFile(f)}>
            <span className="st-file-path">{f}</span>
            {changed.has(f) ? <span className="st-dot" /> : null}
          </div>
        ))}
        {!extra.length ? <div className="empty">없음</div> : null}
      </div>
    </>
  );
}

// ── 진입점 ────────────────────────────────────────────────────────────────

export default function SectionView({ sec, item, ctx, verbLabels }: { sec: string; item: string | null; ctx: SectionCtx; verbLabels?: Record<string, string> }) {
  const def = SECTIONS.find((s) => s.key === sec);
  if (sec === "files") return <UnclaimedView ctx={ctx} />;
  if (!def) return <div className="empty">없는 섹션: {sec}</div>;

  const body = (() => {
    if (item) {
      switch (def.key) {
        case "surfaces":
          return <SurfacesItem id={item} ctx={ctx} />;
        case "harness":
          return <HarnessItem id={item} ctx={ctx} />;
        case "agents":
          return <AgentItem id={item} ctx={ctx} verbLabels={verbLabels} />;
        case "scripts":
          return <ScriptItem id={item} ctx={ctx} />;
        case "services":
          return <ServiceItem id={item} ctx={ctx} />;
        case "triggers":
          return <TriggerItem id={item} ctx={ctx} />;
        case "missions":
          return <MissionItem id={item} ctx={ctx} />;
        case "edges":
          return <EdgeItem id={item} ctx={ctx} />;
        default:
          return <YamlOnly def={def} />;
      }
    }
    switch (def.key) {
      case "identity":
        return <IdentityView ctx={ctx} />;
      case "requires":
        return <RequiresView ctx={ctx} />;
      case "host_methods":
        return <HostMethodsView ctx={ctx} />;
      case "surfaces":
        return <SurfacesLanding def={def} ctx={ctx} />;
      case "harness":
        return <HarnessLanding def={def} ctx={ctx} />;
      case "agents":
        return <AgentsLanding def={def} ctx={ctx} />;
      case "scripts":
        return <ScriptsLanding def={def} ctx={ctx} />;
      case "services":
        return <ServicesLanding def={def} ctx={ctx} />;
      case "triggers":
        return <TriggersLanding def={def} ctx={ctx} />;
      case "missions":
        return <MissionsLanding def={def} ctx={ctx} />;
      case "edges":
        return <EdgesLanding def={def} ctx={ctx} />;
      default:
        return <YamlOnly def={def} />;
    }
  })();

  return (
    <div className="st-section">
      {!item ? <Hint def={def} ctx={ctx} /> : null}
      {body}
    </div>
  );
}

"use client";

import type React from "react";
import { useEffect, useId, useState } from "react";
import type { Document } from "yaml";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { creatable, push, slugOk, type Made } from "@/lib/create";
import { SECTIONS, schemaHint, unclaimedFiles, type SectionDef, type SectionItem } from "@/lib/sections";
import type { Manifest } from "@/lib/types";
import type { DraftChange } from "@/lib/studio";

// depth 2: 섹션 랜딩(항목 목록 또는 폼)과 항목 폼 + 파일 카드.
// 폼의 정본은 relay.yaml 텍스트다 — 편집은 Document 패치로 들어가 사용자의 주석을 보존하고,
// 결과 텍스트가 apply() 로 올라가 저장된다. 폼은 그 텍스트의 뷰일 뿐이다.

export interface SectionCtx {
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

const HARNESS_TEMPLATES = ["claude-code", "codex", "pi", "kimi"];

/** blur 시점에만 커밋하는 입력 — 키 입력마다 YAML 재직렬화가 도는 churn 을 막는다 */
function Field({
  label,
  k,
  value,
  placeholder,
  mono,
  onCommit,
}: {
  /** 사람 말 이름 */
  label: string;
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
    <div className="flex flex-col gap-1.5" title={k ? `relay.yaml: ${k}` : undefined}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
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

function IdentityView({ ctx }: { ctx: SectionCtx }) {
  const m = ctx.manifest;
  return (
    <div className="st-form">
      <Field label="이름" k="display_name" value={m.display_name ?? ""} onCommit={(v) => ctx.apply((d) => set(d, ["display_name"], v))} />
      <Field label="한 줄 소개" k="description" value={m.description ?? ""} onCommit={(v) => ctx.apply((d) => set(d, ["description"], v))} />
      <Advanced>
        <Field label="고유 이름 (설치·배포에 쓰는 id)" k="name" value={m.name ?? ""} mono placeholder="@local/my-agent" onCommit={(v) => ctx.apply((d) => set(d, ["name"], v))} />
        <Field label="버전" k="version" value={m.version ?? ""} mono placeholder="0.1.0" onCommit={(v) => ctx.apply((d) => set(d, ["version"], v))} />
        <Field label="아이콘 파일" k="icon" value={m.icon ?? ""} mono placeholder="assets/icon.svg" onCommit={(v) => ctx.apply((d) => set(d, ["icon"], v))} />
      </Advanced>
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
        <Field label="화면 소스 폴더" k="source" value={v?.source ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "view", "source"], x))} />
        <Field label="빌드 결과 폴더 — 비우면 소스를 그대로 냅니다" k="out" value={v?.out ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "view", "out"], x))} />
        <FileCards item={item} ctx={ctx} missing={v && !item.files.length ? [{ path: `${v.source}/index.html`, make: () => ctx.createFile(`${v.source}/index.html`, `<!doctype html><meta charset="utf-8"><title>view</title>`) }] : []} />
        <Button variant="outline" size="sm" className="self-start" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "view"]))}>
          화면 빼기
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
        <Field label="부품 소스 폴더" k="source" value={c.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "components", "source"], x))} />
        <Field label="빌드 결과 폴더 — 비우면 소스를 그대로 냅니다" k="out" value={c.out ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "components", "out"], x))} />
        <p className="text-xs text-muted-foreground whitespace-pre-wrap">
          {"계약은 수출 하나다 — export function mount(el, props): { unmount() }\n"}
          {`진입점은 ${entry} 이고 그 파일 하나가 전부다(스타일 동봉). 번들은 자기 런타임을 안고 나온다 — 소비자에게 프레임워크를 요구하지 마라.`}
        </p>
        <FileCards
          item={item}
          ctx={ctx}
          missing={!ctx.files.some((f) => f.startsWith(c.source + "/")) ? [{ path: `${c.source}/index.js`, make: () => ctx.createFile(`${c.source}/index.js`, `export function mount(el, props = {}) {\n  el.textContent = props.title ?? "안녕하세요";\n  return { unmount() { el.textContent = ""; } };\n}\n`) }] : []}
        />
        <Button variant="outline" size="sm" className="self-start" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "components"]))}>
          부품 빼기
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
      <Field label="배지 이미지 (선택)" k="icon" value={ch.icon ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "channels", idx, "icon"], x))} />
      <CredentialFields idx={idx} ch={ch} ctx={ctx} />
      <FileCards
        item={item}
        ctx={ctx}
        missing={!ctx.files.includes(`${ch.source}/${ch.entry}`) ? [{ path: `${ch.source}/${ch.entry}`, make: () => ctx.createFile(`${ch.source}/${ch.entry}`, `// ${name} 채널 어댑터\n`) }] : []}
      />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["surfaces", "channels", idx]));
          ctx.openItem(null);
        }}
      >
        채널 빼기
      </Button>
    </div>
  );
}

const HARNESS_LABEL: Record<string, string> = { "claude-code": "Claude", codex: "Codex", pi: "Pi", kimi: "Kimi" };

/** 어떤 엔진으로 돌릴 수 있나 — 후보 목록·드롭다운·추가 버튼 대신 칩 하나로. 켜면 붙고, 켜진 것을 누르면 상세 */
function HarnessLanding({ ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const have = new Set((m.harness?.variants ?? []).map((v) => v.name));
  const [busy, make] = useMake(ctx);
  return (
    <div className="st-form">
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs text-muted-foreground">돌릴 수 있는 엔진 — 누르면 붙고, 붙은 것을 누르면 자세히</Label>
        <div className="st-picks">
          {HARNESS_TEMPLATES.map((t) => (
            <button key={t} type="button" className="st-pick" aria-pressed={have.has(t)} disabled={busy} title={have.has(t) ? `${t} — 자세히 보기` : `${t} 붙이기`} onClick={() => (have.has(t) ? ctx.openItem(t) : make("harness", t))}>
              {HARNESS_LABEL[t] ?? t}
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
      <div className="st-picks-empty"><b>{HARNESS_LABEL[v.name] ?? v.name}</b> 어댑터 — 보통 손댈 일이 없습니다.</div>
      <Field label="도구 어댑터 폴더" k="source" value={v.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "source"], x))} />
      <Field label="시작 파일" k="entry" value={v.entry ?? "run"} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "entry"], x))} />
      <Field label="모델 제공자" k="llm.provider" value={v.llm?.provider ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "llm", "provider"], x))} />
      <FileCards item={item} ctx={ctx} />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["harness", "variants", idx]));
          ctx.openItem(null);
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
        <Input placeholder="대화 상대 이름 (첫 번째는 패키지 이름과 같게)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button size="sm" disabled={busy || !slugOk(name)} onClick={() => { make("agent", name); setName(""); }}>
          추가
        </Button>
      </div>
    </>
  );
}

/** 여러 개 고르기 — 쉼표 입력 대신 칩. 목록에 없는 값(글롭 등)은 그대로 칩으로 보여 주고 뺄 수 있다 */
function Picks({ value, options, onChange, empty }: { value: string[]; options: { id: string; label?: string }[]; onChange: (v: string[]) => void; empty: string }) {
  const known = new Set(options.map((o) => o.id));
  const extra = value.filter((v) => !known.has(v));
  if (!options.length && !extra.length) return <div className="st-picks-empty">{empty}</div>;
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="st-picks">
      {options.map((o) => (
        <button key={o.id} type="button" className="st-pick" aria-pressed={value.includes(o.id)} onClick={() => toggle(o.id)} title={o.id}>
          {o.label ?? o.id}
        </button>
      ))}
      {extra.map((v) => (
        <button key={v} type="button" className="st-pick" aria-pressed onClick={() => toggle(v)} title="누르면 뺍니다">
          {v}
        </button>
      ))}
    </div>
  );
}

function AgentItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
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
  const extraFiles = [
    ...ctx.files.filter((f) => (a.skills ? f.startsWith(a.skills + "/") : false)),
    ...ctx.files.filter((f) => (a.commands ? f.startsWith(a.commands + "/") : false)),
  ];
  return (
    <div className="st-form">
      {/* 성격과 역할 글 — 이 에이전트의 핵심. 경로 카드가 아니라 "열기" 버튼 */}
      {personaOk ? (
        <button type="button" className="st-open" onClick={() => ctx.openFile(a.persona!)} title={a.persona}>
          <span className="st-open-t">성격과 역할 글 열기</span>
          <span className="st-open-s">누구인지, 무엇을 어떻게 하는지 적은 글 — 가운데 칸에서 고칩니다</span>
        </button>
      ) : a.persona ? (
        <button type="button" className="st-open missing" onClick={() => ctx.createFile(a.persona!, `당신은 ${a.name}입니다.\n`)}>
          <span className="st-open-t">성격과 역할 글 만들기</span>
          <span className="st-open-s">아직 파일이 없습니다 — 누르면 만들어서 엽니다</span>
        </button>
      ) : null}
      <Field label="첫 인사 — 빈 대화에 먼저 보이는 말" k="greeting" value={a.greeting ?? ""} placeholder="무엇을 도와드릴까요?" onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "greeting"], x))} />
      <div className="flex flex-col gap-1.5" title="relay.yaml: agents[].scripts">
        <Label className="text-xs text-muted-foreground">쓸 수 있는 기능 — 누르면 켜고 끕니다</Label>
        <Picks
          value={a.scripts ?? []}
          options={verbs.map((v) => ({ id: v }))}
          empty="아직 기능이 없습니다 — 기능 묶음의 ＋ 추가로 만드세요"
          onChange={(v) => ctx.apply((d) => set(d, ["agents", idx, "scripts"], v))}
        />
      </div>
      {others.length ? (
        <div className="flex flex-col gap-1.5" title="relay.yaml: agents[].dispatch">
          <Label className="text-xs text-muted-foreground">일을 넘길 수 있는 보조 에이전트</Label>
          <Picks value={a.dispatch ?? []} options={others} empty="" onChange={(v) => ctx.apply((d) => set(d, ["agents", idx, "dispatch"], v))} />
        </div>
      ) : null}
      <Advanced open={!!(a.skills || a.commands)}>
        <Field label="성격 글 파일 경로" k="persona" value={a.persona ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "persona"], x))} />
        <Field label="기술(스킬) 폴더" k="skills" value={a.skills ?? ""} mono placeholder={`agents/${a.name}/skills`} onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "skills"], x))} />
        <Field label="명령 폴더" k="commands" value={a.commands ?? ""} mono placeholder={`agents/${a.name}/commands`} onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "commands"], x))} />
        {a.skills ? (
          <Button variant="outline" size="sm" className="self-start" onClick={() => ctx.createFile(`${a.skills}/new-skill/SKILL.md`, `---\nname: new-skill\ndescription: 무엇을 하는 스킬인지 한 줄\n---\n\n# new-skill\n`)}>
            + 기술 하나 만들기
          </Button>
        ) : null}
        <FileCards item={{ files: extraFiles }} ctx={ctx} />
      </Advanced>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["agents", idx]));
          ctx.openItem(null);
        }}
      >
        이 에이전트 빼기 (파일은 남습니다)
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
      {!src ? <p className="text-xs text-muted-foreground">첫 기능을 만들면 기능 폴더(scripts/)도 같이 생깁니다.</p> : null}
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
  const [form, setForm] = useState<"process" | "container" | "url" | "dir">("process");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <Input placeholder="자원 이름" style={{ maxWidth: 160 }} value={name} onChange={(e) => setName(e.target.value)} />
        <select value={form} onChange={(e) => setForm(e.target.value as never)}>
          <option value="process">프로세스</option>
          <option value="container">컨테이너</option>
          <option value="url">바깥 도구 (원격)</option>
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
  const uid = useId();
  if (!s) return <div className="empty">없는 서비스</div>;
  const p = (k: string) => ["services", idx, k];
  const item = { files: ctx.files.filter((f) => (s.source ? f.startsWith(s.source + "/") : false)) };
  return (
    <div className="st-form">
      {s.url != null ? (
        <>
          <Field label="원격 도구 주소" k="url" value={s.url} mono onCommit={(x) => ctx.apply((d) => set(d, p("url"), x))} />
          <Field label="빌려 쓸 도구 (쉼표)" k="tools" value={(s.tools ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, p("tools"), listField(x)))} />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-auth`} className="text-xs text-muted-foreground">로그인 방식</Label>
            <select id={`${uid}-auth`} value={(s as any).auth?.kind ?? "none"} onChange={(e) => ctx.apply((d) => d.setIn([...p("auth"), "kind"], e.target.value))}>
              <option value="none">없음</option>
              <option value="token">토큰</option>
              <option value="oauth">OAuth 로그인</option>
            </select>
          </div>
          {(s as any).auth?.kind === "token" ? (
            <Field label="토큰을 넣어 줄 환경변수 이름" k="auth.env" value={(s as any).auth?.env ?? ""} mono placeholder={`${s.name.toUpperCase().replace(/-/g, "_")}_TOKEN`} onCommit={(x) => ctx.apply((d) => set(d, [...p("auth"), "env"], x))} />
          ) : null}
        </>
      ) : s.dir != null ? (
        <Field label="폴더 — 상대경로면 이 앱의 것, ~ 로 시작하면 설치할 때 허락받습니다" k="dir" value={s.dir} mono onCommit={(x) => ctx.apply((d) => set(d, p("dir"), x))} />
      ) : (
        <>
          <Field label="프로그램 폴더" k="source" value={s.source ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("source"), x))} />
          <Field label="시작 파일 (프로세스)" k="entry" value={s.entry ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("entry"), x))} />
          <Field label="Dockerfile (컨테이너)" k="dockerfile" value={s.dockerfile ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("dockerfile"), x))} />
          <Field label="포트" k="port" value={s.port != null ? String(s.port) : ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("port"), x ? Number(x) : ""))} />
        </>
      )}
      <FileCards item={item} ctx={ctx} />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["services", idx]));
          ctx.openItem(null);
        }}
      >
        자원 빼기
      </Button>
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
        <Input placeholder="이름 (예: daily-digest)" value={id} onChange={(e) => setId(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          <option value="cron">정해진 시각에</option>
          <option value="event">사건이 나면</option>
        </select>
        <Button size="sm" disabled={busy || !slugOk(id)} onClick={() => { make(`trigger-${kind}`, id); setId(""); }}>
          추가
        </Button>
      </div>
    </>
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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-when`} className="text-xs text-muted-foreground">언제</Label>
        <select
          id={`${uid}-when`}
          value={kind}
          onChange={(e) =>
            ctx.apply((d) =>
              d.setIn(["triggers", idx, "when"], e.target.value === "cron" ? { cron: "0 9 * * *", tz: "Asia/Seoul" } : { event: "relay.package.installed" }),
            )
          }
        >
          <option value="cron">정해진 시각에</option>
          <option value="event">사건이 나면</option>
        </select>
      </div>
      {kind === "cron" ? (
        <>
          <Field label="시각 — cron 식 (예: 0 9 * * * = 매일 9시)" k="cron" value={t.when?.cron ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "cron"], x))} />
          <Advanced><Field label="시간대" k="tz" value={t.when?.tz ?? ""} mono placeholder="Asia/Seoul" onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "tz"], x))} /></Advanced>
        </>
      ) : (
        <>
          <Field label="사건 이름" k="event" value={t.when?.event ?? ""} mono placeholder="relay.package.installed" onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "event"], x))} />
          <Advanced open={t.when?.debounce_ms != null}><Field label="연달아 생기면 묶어서 기다릴 시간 (밀리초)" k="debounce_ms" value={t.when?.debounce_ms != null ? String(t.when.debounce_ms) : ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "debounce_ms"], x ? Number(x) : ""))} /></Advanced>
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-then`} className="text-xs text-muted-foreground">무엇을</Label>
        <select
          id={`${uid}-then`}
          value={thenKind}
          onChange={(e) =>
            ctx.apply((d) =>
              d.setIn(["triggers", idx, "then"], e.target.value === "agent" ? { agent: (m.agents ?? [])[0]?.name ?? "", prompt: "" } : { script: "" }),
            )
          }
        >
          <option value="agent">대화 상대를 깨운다</option>
          <option value="script">기능 하나를 돌린다</option>
        </select>
      </div>
      {thenKind === "agent" ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${uid}-agent`} className="text-xs text-muted-foreground">누구를</Label>
            <select id={`${uid}-agent`} value={t.then?.agent ?? ""} onChange={(e) => ctx.apply((d) => d.setIn(["triggers", idx, "then", "agent"], e.target.value))}>
              {(m.agents ?? []).map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <Field label="깨울 때 건넬 말" k="prompt" value={t.then?.prompt ?? ""} onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "prompt"], x))} />
          <Field label="결과를 보낼 곳 — 채널이름:대화 (비우면 안 보냄)" k="delivery" value={t.then?.delivery ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "delivery"], x))} />
          <Advanced open={!!t.then?.route}><Field label="열어 줄 화면 경로" k="route" value={t.then?.route ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "route"], x))} /></Advanced>
        </>
      ) : (
        <Field label="돌릴 기능" k="script" value={t.then?.script ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "script"], x))} />
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["triggers", idx]));
          ctx.openItem(null);
        }}
      >
        예약 빼기
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
      <Field label="설명 — 일을 맡기는 쪽이 읽습니다" k="description" value={ms.description ?? ""} onCommit={(x) => ctx.apply((d) => set(d, ["missions", idx, "description"], x))} />
      <Button
        variant="outline"
        size="sm"
        className="self-start"
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
        <Input placeholder="빌려 쓸 앱의 고유 이름 (@scope/name)" value={provider} onChange={(e) => setProvider(e.target.value)} />
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
      if (k === "components") d.setIn(["edges", idx, "components"], true);
      else if (k === "mission") d.setIn(["edges", idx, "mission"], "");
      else d.setIn(["edges", idx, "tools"], []);
    });
  return (
    <div className="st-form">
      <Field label="빌려 쓸 앱" k="provider" value={e.provider} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "provider"], x))} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${uid}-kind`} className="text-xs text-muted-foreground">무엇을 빌리나 (하나만)</Label>
        <select id={`${uid}-kind`} value={kind} onChange={(ev) => pick(ev.target.value as never)}>
          <option value="tools">기능 — 그 앱의 기능을 부릅니다</option>
          <option value="mission">일 맡기기 — 그 앱에 일을 넘깁니다</option>
          <option value="components">화면 부품 — 그 앱의 부품을 내 화면에 끼웁니다</option>
        </select>
      </div>
      {kind === "tools" ? (
        <Field label="빌려 쓸 기능 (쉼표)" k="tools" value={(e.tools ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "tools"], listField(x)))} />
      ) : kind === "mission" ? (
        <Field label="맡길 일" k="mission" value={e.mission ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "mission"], x))} />
      ) : (
        <p className="text-xs text-muted-foreground">
          {`결재되면 기판이 소비자 문서에 import map 을 심는다 — 화면은 import { mount } from "${e.provider}" 만 쓰고 주소를 조립하지 않는다.`}
        </p>
      )}
      <Button
        variant="outline"
        size="sm"
        className="self-start"
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
 * credential — 자격의 **형태** 선언. 값이 아니다(값은 vault 에 산다).
 *
 * 이 선언이 곧 연결 화면의 입력 칸이라, 저작자가 여기서 고치는 것은 남이 보게 될 폼이다.
 * 그래서 오른쪽 결과면이 같은 선언으로 그 폼을 그대로 그린다 — 선언과 결과가 한 화면에 있다.
 */
function CredentialFields({ idx, ch, ctx }: { idx: number; ch: { credential?: { fields?: { key?: string; label: string; secret?: boolean; list?: boolean; required?: boolean }[] } }; ctx: SectionCtx }) {
  const fields = ch.credential?.fields ?? [];
  const at = (i: number, k: string) => ["surfaces", "channels", idx, "credential", "fields", i, k];
  return (
    <div className="st-form">
      <div className="rc-label">로그인 정보 칸 — 연결 화면이 이대로 입력 칸을 그립니다</div>
      {fields.map((f, i) => (
        <div key={i} className="item">
          <div className="bar">
            <Input
              value={f.key ?? ""}
              placeholder="key (비우면 자격이 문자열 하나)"
              className="font-mono text-xs md:text-xs"
              onChange={(e) => ctx.apply((d) => set(d, at(i, "key"), e.target.value))}
            />
            <Input value={f.label} placeholder="사람이 읽는 이름" onChange={(e) => ctx.apply((d) => d.setIn(at(i, "label"), e.target.value))} />
            <Button variant="ghost" size="icon-xs" className="flex-none text-muted-foreground" title="이 칸 빼기" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "channels", idx, "credential", "fields", i]))}>
              ×
            </Button>
          </div>
          <div className="bar text-xs text-muted-foreground">
            {(["secret", "list", "required"] as const).map((k) => (
              <Label key={k} className="flex-none text-xs font-normal">
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
        onClick={() => void ctx.apply((d) => push(d, ["surfaces", "channels", idx, "credential", "fields"], { key: "token", label: "토큰", secret: true, required: true }))}
      >
        + 자격 칸
      </Button>
      {fields.length ? (
        <p className="text-xs text-muted-foreground">
          {fields.every((f) => f.key)
            ? "모든 칸에 key 가 있으니 화면이 JSON 객체로 조립해 넘긴다."
            : fields.length === 1
              ? "key 없는 칸 하나 — 그 값이 곧 자격 문자열이다."
              : "key 있는 칸과 없는 칸을 섞으면 판정 실패다 — 전부 채우거나, 한 칸만 비우세요."}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">칸을 정하지 않으면 연결 화면은 붙여넣기 칸 하나로 물러납니다.</p>
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
        label="운영체제 (쉼표 — darwin, linux, win32)" k="os"
        value={(req?.os ?? []).join(", ")}
        mono
        onCommit={(x) => ctx.apply((d) => set(d, ["requires", "os"], listField(x)))}
      />
      <div className="rc-label">있어야 하는 명령줄 도구 — 전부 있어야 설치됩니다</div>
      {bins.map((b, i) => (
        <div key={b.name} className="st-file" style={{ cursor: "default" }}>
          <span className="st-file-path">{b.name}</span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => ctx.apply((d) => d.deleteIn(["requires", "binaries", i]))}
          >
            빼기
          </Button>
        </div>
      ))}
      <div className="lv-in">
        <Input placeholder="명령줄 도구 이름 (예: git)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button
          size="sm"
          disabled={busy || !slugOk(name) || bins.some((b) => b.name === name.trim())}
          onClick={() => { make("requires-binary", name); setName(""); }}
        >
          추가
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        manager + package 를 함께 적으면 기판이 직접 깐다(레시피). 이름만 적으면 없을 때 설치가 거부되고 install 안내가 뜬다 — 원문 에디터에서 붙이세요.
      </p>
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

export default function SectionView({ sec, item, ctx }: { sec: string; item: string | null; ctx: SectionCtx }) {
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
          return <AgentItem id={item} ctx={ctx} />;
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

"use client";

import { useEffect, useState } from "react";
import type { Document } from "yaml";
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
  value,
  placeholder,
  mono,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  mono?: boolean;
  onCommit: (v: string) => void;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <label className="st-field">
      <span>{label}</span>
      <input
        value={v}
        placeholder={placeholder}
        style={mono ? { fontFamily: "var(--rc-mono)", fontSize: 12 } : undefined}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
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
          <button className="rc-btn" onClick={x.make}>
            만들기
          </button>
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
          {it.files.length ? <span className="rc-chip gray">{it.files.length} 파일</span> : null}
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

function Hint({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const hint = schemaHint(ctx.schema, def.yamlKey) ?? def.hint;
  return <div className="st-hint">{hint}</div>;
}

// ── 섹션별 캔버스 ─────────────────────────────────────────────────────────

function IdentityView({ ctx }: { ctx: SectionCtx }) {
  const m = ctx.manifest;
  return (
    <div className="st-form">
      <Field label="name (혈통, @scope/이름)" value={m.name ?? ""} mono placeholder="@local/my-agent" onCommit={(v) => ctx.apply((d) => set(d, ["name"], v))} />
      <Field label="version" value={m.version ?? ""} mono placeholder="0.1.0" onCommit={(v) => ctx.apply((d) => set(d, ["version"], v))} />
      <Field label="표시 이름" value={m.display_name ?? ""} onCommit={(v) => ctx.apply((d) => set(d, ["display_name"], v))} />
      <Field label="카드 한 줄 설명" value={m.description ?? ""} onCommit={(v) => ctx.apply((d) => set(d, ["description"], v))} />
      <Field label="icon (패키지 상대경로)" value={m.icon ?? ""} mono placeholder="assets/icon.svg" onCommit={(v) => ctx.apply((d) => set(d, ["icon"], v))} />
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
      <ItemList def={def} items={items} ctx={ctx} onAdd={() => setAdding(true)} addLabel="채널 어댑터" />
      {adding ? (
        <div className="lv-in">
          <input placeholder="채널 이름 (예: discord)" value={chName} onChange={(e) => setChName(e.target.value)} autoFocus />
          <button className="rc-btn accent" disabled={busy || !slugOk(chName)} onClick={() => make("channel", chName)}>
            추가
          </button>
        </div>
      ) : null}
      {!m.surfaces?.view ? (
        <button className="rc-btn add" disabled={busy} onClick={() => make("view", "")}>
          + 이 앱의 화면
        </button>
      ) : null}
      {!m.surfaces?.components ? (
        <button className="rc-btn add" disabled={busy} onClick={() => make("components", "")}>
          + 다른 앱 화면에 끼울 부품
        </button>
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
        <Field label="source (화면 소스 디렉토리)" value={v?.source ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "view", "source"], x))} />
        <Field label="out (빌드 산출 디렉토리, 비우면 정적 서빙)" value={v?.out ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "view", "out"], x))} />
        <FileCards item={item} ctx={ctx} missing={v && !item.files.length ? [{ path: `${v.source}/index.html`, make: () => ctx.createFile(`${v.source}/index.html`, `<!doctype html><meta charset="utf-8"><title>view</title>`) }] : []} />
        <button className="rc-btn" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "view"]))}>
          view 선언 삭제
        </button>
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
        <Field label="source (번들 소스 디렉토리)" value={c.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "components", "source"], x))} />
        <Field label="out (빌드 산출, 비우면 source 를 그대로 서빙)" value={c.out ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "components", "out"], x))} />
        <div className="st-hint">
          {"계약은 수출 하나다 — export function mount(el, props): { unmount() }\n"}
          {`진입점은 ${entry} 이고 그 파일 하나가 전부다(스타일 동봉). 번들은 자기 런타임을 안고 나온다 — 소비자에게 프레임워크를 요구하지 마라.`}
        </div>
        <FileCards
          item={item}
          ctx={ctx}
          missing={!ctx.files.some((f) => f.startsWith(c.source + "/")) ? [{ path: `${c.source}/index.js`, make: () => ctx.createFile(`${c.source}/index.js`, `export function mount(el, props = {}) {\n  el.textContent = props.title ?? "안녕하세요";\n  return { unmount() { el.textContent = ""; } };\n}\n`) }] : []}
        />
        <button className="rc-btn" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "components"]))}>
          components 선언 삭제
        </button>
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
      <Field label="source" value={ch.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "channels", idx, "source"], x))} />
      <Field label="entry" value={ch.entry} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "channels", idx, "entry"], x))} />
      <Field label="icon (배지 이미지, 선택)" value={ch.icon ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["surfaces", "channels", idx, "icon"], x))} />
      <CredentialFields idx={idx} ch={ch} ctx={ctx} />
      <FileCards
        item={item}
        ctx={ctx}
        missing={!ctx.files.includes(`${ch.source}/${ch.entry}`) ? [{ path: `${ch.source}/${ch.entry}`, make: () => ctx.createFile(`${ch.source}/${ch.entry}`, `// ${name} 채널 어댑터\n`) }] : []}
      />
      <button
        className="rc-btn"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["surfaces", "channels", idx]));
          ctx.openItem(null);
        }}
      >
        채널 선언 삭제
      </button>
    </div>
  );
}

function HarnessLanding({ def, ctx }: { def: SectionDef; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const items = def.items!(m, ctx.files);
  const have = new Set((m.harness?.variants ?? []).map((v) => v.name));
  const left = HARNESS_TEMPLATES.filter((t) => !have.has(t));
  const [tpl, setTpl] = useState(left[0] ?? "");
  const [busy, make] = useMake(ctx);
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      {left.length ? (
        <div className="lv-in">
          <select value={left.includes(tpl) ? tpl : left[0]} onChange={(e) => setTpl(e.target.value)}>
            {left.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button className="rc-btn accent" disabled={busy} onClick={() => make("harness", left.includes(tpl) ? tpl : left[0])}>
            + 이 앱을 돌릴 다른 도구
          </button>
        </div>
      ) : (
        <div className="st-hint">네 가지 후보를 다 붙였습니다.</div>
      )}
      <div className="st-form" style={{ marginTop: 4 }}>
        <Field label="workdir (세션 cwd 의 workspace 하위 상대경로)" value={m.harness?.workdir ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "workdir"], x))} />
      </div>
    </>
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
      <Field label="source" value={v.source} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "source"], x))} />
      <Field label="entry" value={v.entry ?? "run"} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "entry"], x))} />
      <Field label="llm provider" value={v.llm?.provider ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["harness", "variants", idx, "llm", "provider"], x))} />
      <FileCards item={item} ctx={ctx} />
      <button
        className="rc-btn"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["harness", "variants", idx]));
          ctx.openItem(null);
        }}
      >
        후보 삭제
      </button>
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
        <input placeholder="에이전트 이름 (착지 = 패키지 짧은 이름)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="rc-btn accent" disabled={busy || !slugOk(name)} onClick={() => { make("agent", name); setName(""); }}>
          추가
        </button>
      </div>
    </>
  );
}

function AgentItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = (m.agents ?? []).findIndex((a) => a.name === id);
  const a = (m.agents ?? [])[idx];
  if (!a) return <div className="empty">없는 에이전트</div>;
  const item = {
    files: [
      ...(a.persona && ctx.files.includes(a.persona) ? [a.persona] : []),
      ...ctx.files.filter((f) => (a.skills ? f.startsWith(a.skills + "/") : false)),
      ...ctx.files.filter((f) => (a.commands ? f.startsWith(a.commands + "/") : false)),
    ],
  };
  const missing: { path: string; make: () => void }[] = [];
  if (a.persona && !ctx.files.includes(a.persona)) {
    missing.push({ path: a.persona, make: () => ctx.createFile(a.persona!, `당신은 ${a.name}입니다.\n`) });
  }
  return (
    <div className="st-form">
      <Field label="persona (마크다운 파일)" value={a.persona ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "persona"], x))} />
      <Field label="인사말 (선택 — 빈 대화의 첫 줄)" value={a.greeting ?? ""} placeholder="무엇을 도와드릴까요?" onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "greeting"], x))} />
      <Field label="skills 디렉토리 (선택)" value={a.skills ?? ""} mono placeholder={`agents/${a.name}/skills`} onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "skills"], x))} />
      <Field label="commands 디렉토리 (선택)" value={a.commands ?? ""} mono placeholder={`agents/${a.name}/commands`} onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "commands"], x))} />
      <Field label="dispatch (서브에이전트, 쉼표)" value={(a.dispatch ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "dispatch"], listField(x)))} />
      <Field label="scripts scope (동사, 쉼표 — 접두 glob 허용)" value={(a.scripts ?? []).join(", ")} mono placeholder="log-*, report" onCommit={(x) => ctx.apply((d) => set(d, ["agents", idx, "scripts"], listField(x)))} />
      <div className="st-hint">스킬 추가: skills 디렉토리 선언 후 파일 카드에서 {"<스킬>"}/SKILL.md 를 만드세요.</div>
      {a.skills ? (
        <button className="rc-btn add" onClick={() => ctx.createFile(`${a.skills}/new-skill/SKILL.md`, `---\nname: new-skill\ndescription: 무엇을 하는 스킬인지 한 줄\n---\n\n# new-skill\n`)}>
          + 스킬 스캐폴드
        </button>
      ) : null}
      <FileCards item={item} ctx={ctx} missing={missing} />
      <button
        className="rc-btn"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["agents", idx]));
          ctx.openItem(null);
        }}
      >
        에이전트 선언 삭제 (파일은 남는다)
      </button>
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
        <input placeholder="동사 이름 (예: report-weekly)" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="rc-btn accent" disabled={busy || !slugOk(name)} onClick={() => { make("script", name); setName(""); }}>
          추가
        </button>
      </div>
      {!src ? <div className="st-hint">첫 동사를 만들면 scripts.source 선언(scripts/)도 같이 생깁니다.</div> : null}
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
  return <div className="empty">{f} 여는 중…</div>;
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
        <input placeholder="서비스 이름" style={{ maxWidth: 160 }} value={name} onChange={(e) => setName(e.target.value)} />
        <select value={form} onChange={(e) => setForm(e.target.value as never)}>
          <option value="process">프로세스</option>
          <option value="container">컨테이너</option>
          <option value="url">원격 MCP</option>
          <option value="dir">폴더</option>
        </select>
        <button
          className="rc-btn accent"
          disabled={busy || !slugOk(name)}
          onClick={() => {
            make(`service-${form}`, name);
            setName("");
          }}
        >
          추가
        </button>
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
          <Field label="url (원격 MCP 접점)" value={s.url} mono onCommit={(x) => ctx.apply((d) => set(d, p("url"), x))} />
          <Field label="tools (쉼표)" value={(s.tools ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, p("tools"), listField(x)))} />
          <label className="st-field">
            <span>auth.kind</span>
            <select value={(s as any).auth?.kind ?? "none"} onChange={(e) => ctx.apply((d) => d.setIn([...p("auth"), "kind"], e.target.value))}>
              <option value="none">none</option>
              <option value="token">token</option>
              <option value="oauth">oauth</option>
            </select>
          </label>
          {(s as any).auth?.kind === "token" ? (
            <Field label="auth.env (주입 환경변수 이름)" value={(s as any).auth?.env ?? ""} mono placeholder={`${s.name.toUpperCase().replace(/-/g, "_")}_TOKEN`} onCommit={(x) => ctx.apply((d) => set(d, [...p("auth"), "env"], x))} />
          ) : null}
        </>
      ) : s.dir != null ? (
        <Field label="dir (상대 = 자기 소유, ~ = 설치 결재로 바인딩)" value={s.dir} mono onCommit={(x) => ctx.apply((d) => set(d, p("dir"), x))} />
      ) : (
        <>
          <Field label="source (서비스 몸 디렉토리)" value={s.source ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("source"), x))} />
          <Field label="entry (프로세스 형)" value={s.entry ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("entry"), x))} />
          <Field label="dockerfile (컨테이너 형)" value={s.dockerfile ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("dockerfile"), x))} />
          <Field label="port" value={s.port != null ? String(s.port) : ""} mono onCommit={(x) => ctx.apply((d) => set(d, p("port"), x ? Number(x) : ""))} />
        </>
      )}
      <FileCards item={item} ctx={ctx} />
      <button
        className="rc-btn"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["services", idx]));
          ctx.openItem(null);
        }}
      >
        서비스 선언 삭제
      </button>
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
        <input placeholder="트리거 id (예: daily-digest)" value={id} onChange={(e) => setId(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          <option value="cron">정해진 시각에</option>
          <option value="event">사건이 나면</option>
        </select>
        <button className="rc-btn accent" disabled={busy || !slugOk(id)} onClick={() => { make(`trigger-${kind}`, id); setId(""); }}>
          추가
        </button>
      </div>
    </>
  );
}

function TriggerItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = (m.triggers ?? []).findIndex((t) => t.id === id);
  const t = (m.triggers ?? [])[idx];
  if (!t) return <div className="empty">없는 트리거</div>;
  const kind = t.when?.event != null ? "event" : "cron";
  const thenKind = t.then?.script != null ? "script" : "agent";
  return (
    <div className="st-form">
      <label className="st-field">
        <span>when</span>
        <select
          value={kind}
          onChange={(e) =>
            ctx.apply((d) =>
              d.setIn(["triggers", idx, "when"], e.target.value === "cron" ? { cron: "0 9 * * *", tz: "Asia/Seoul" } : { event: "relay.package.installed" }),
            )
          }
        >
          <option value="cron">cron (시간)</option>
          <option value="event">event (사건)</option>
        </select>
      </label>
      {kind === "cron" ? (
        <>
          <Field label="cron" value={t.when?.cron ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "cron"], x))} />
          <Field label="tz" value={t.when?.tz ?? ""} mono placeholder="Asia/Seoul" onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "tz"], x))} />
        </>
      ) : (
        <>
          <Field label="event" value={t.when?.event ?? ""} mono placeholder="relay.package.installed" onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "event"], x))} />
          <Field label="debounce_ms" value={t.when?.debounce_ms != null ? String(t.when.debounce_ms) : ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "when", "debounce_ms"], x ? Number(x) : ""))} />
        </>
      )}
      <label className="st-field">
        <span>then</span>
        <select
          value={thenKind}
          onChange={(e) =>
            ctx.apply((d) =>
              d.setIn(["triggers", idx, "then"], e.target.value === "agent" ? { agent: (m.agents ?? [])[0]?.name ?? "", prompt: "" } : { script: "" }),
            )
          }
        >
          <option value="agent">agent (세션)</option>
          <option value="script">script (headless 동사)</option>
        </select>
      </label>
      {thenKind === "agent" ? (
        <>
          <label className="st-field">
            <span>agent</span>
            <select value={t.then?.agent ?? ""} onChange={(e) => ctx.apply((d) => d.setIn(["triggers", idx, "then", "agent"], e.target.value))}>
              {(m.agents ?? []).map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <Field label="prompt" value={t.then?.prompt ?? ""} onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "prompt"], x))} />
          <Field label="delivery (선톡 좌표 <채널>:<대화키>, 선택)" value={t.then?.delivery ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "delivery"], x))} />
          <Field label="route (설치 화면 이동 경로, 선택)" value={t.then?.route ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "route"], x))} />
        </>
      ) : (
        <Field label="script (동사 이름)" value={t.then?.script ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["triggers", idx, "then", "script"], x))} />
      )}
      <button
        className="rc-btn"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["triggers", idx]));
          ctx.openItem(null);
        }}
      >
        트리거 삭제
      </button>
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
        <input placeholder="미션 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="rc-btn accent" disabled={busy || !slugOk(name)} onClick={() => { make("mission", name); setName(""); }}>
          추가
        </button>
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
      <Field label="이름" value={ms.name} onCommit={(x) => ctx.apply((d) => set(d, ["missions", idx, "name"], x))} />
      <Field label="설명 (위임자가 읽는다)" value={ms.description ?? ""} onCommit={(x) => ctx.apply((d) => set(d, ["missions", idx, "description"], x))} />
      <button
        className="rc-btn"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["missions", idx]));
          ctx.openItem(null);
        }}
      >
        미션 삭제
      </button>
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
        <input placeholder="@scope/name (provider 혈통)" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <select value={kind} onChange={(e) => setKind(e.target.value as never)}>
          <option value="tools">동사 쓰기</option>
          <option value="mission">일 맡기기</option>
          <option value="components">부품 끼우기</option>
        </select>
        {kind === "mission" ? (
          <input placeholder="미션 이름" style={{ maxWidth: 150 }} value={mission} onChange={(e) => setMission(e.target.value)} />
        ) : null}
        <button
          className="rc-btn accent"
          disabled={busy || !provider.trim() || (kind === "mission" && !slugOk(mission))}
          onClick={() => { make(`edge-${kind}`, provider, mission); setProvider(""); setMission(""); }}
        >
          추가
        </button>
      </div>
      <div className="st-hint">선언은 신청이다 — 활성화(결재)는 콘솔 그래프에서 한다.</div>
    </>
  );
}

function EdgeItem({ id, ctx }: { id: string; ctx: SectionCtx }) {
  const m = ctx.manifest;
  const idx = Number(id);
  const e = (m.edges ?? [])[idx];
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
      <Field label="provider" value={e.provider} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "provider"], x))} />
      <label className="st-field">
        <span>소비물 (셋 중 하나)</span>
        <select value={kind} onChange={(ev) => pick(ev.target.value as never)}>
          <option value="tools">tools — 남의 동사를 부른다 (런타임 결재)</option>
          <option value="mission">mission — a2a 위임을 보낸다 (런타임 결재)</option>
          <option value="components">components — 남의 번들을 내 화면이 마운트한다 (설치 시점 결재)</option>
        </select>
      </label>
      {kind === "tools" ? (
        <Field label="tools (쉼표)" value={(e.tools ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "tools"], listField(x)))} />
      ) : kind === "mission" ? (
        <Field label="mission" value={e.mission ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "mission"], x))} />
      ) : (
        <div className="st-hint">
          {`결재되면 기판이 소비자 문서에 import map 을 심는다 — 화면은 import { mount } from "${e.provider}" 만 쓰고 주소를 조립하지 않는다.`}
        </div>
      )}
      <button
        className="rc-btn"
        onClick={() => {
          ctx.apply((d) => d.deleteIn(["edges", idx]));
          ctx.openItem(null);
        }}
      >
        edge 삭제
      </button>
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
      <div className="rc-label">credential.fields — 연결 화면이 이 선언으로 칸을 그린다</div>
      {fields.map((f, i) => (
        <div key={i} className="item">
          <div className="bar">
            <input
              value={f.key ?? ""}
              placeholder="key (비우면 자격이 문자열 하나)"
              style={{ fontFamily: "var(--rc-mono)", fontSize: 12 }}
              onChange={(e) => ctx.apply((d) => set(d, at(i, "key"), e.target.value))}
            />
            <input value={f.label} placeholder="사람이 읽는 이름" onChange={(e) => ctx.apply((d) => d.setIn(at(i, "label"), e.target.value))} />
            <button className="x" title="이 칸 빼기" onClick={() => ctx.apply((d) => d.deleteIn(["surfaces", "channels", idx, "credential", "fields", i]))}>
              ×
            </button>
          </div>
          <div className="bar" style={{ fontSize: 12, color: "var(--rc-soft)" }}>
            {(["secret", "list", "required"] as const).map((k) => (
              <label key={k} style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
                <input type="checkbox" style={{ width: "auto" }} checked={!!f[k]} onChange={(e) => ctx.apply((d) => (e.target.checked ? d.setIn(at(i, k), true) : d.deleteIn(at(i, k))))} />
                {k}
              </label>
            ))}
          </div>
        </div>
      ))}
      <button
        className="rc-btn add"
        onClick={() => void ctx.apply((d) => push(d, ["surfaces", "channels", idx, "credential", "fields"], { key: "token", label: "토큰", secret: true, required: true }))}
      >
        + 자격 칸
      </button>
      {fields.length ? (
        <div className="st-hint">
          {fields.every((f) => f.key)
            ? "모든 칸에 key 가 있으니 화면이 JSON 객체로 조립해 넘긴다."
            : fields.length === 1
              ? "key 없는 칸 하나 — 그 값이 곧 자격 문자열이다."
              : "key 있는 칸과 없는 칸을 섞으면 판정 실패다 — 전부 채우거나, 한 칸만 비우세요."}
        </div>
      ) : (
        <div className="st-hint">선언이 없으면 연결 화면은 원시 붙여넣기 칸으로 물러난다 — 제3자 어댑터가 선언 없이도 연결될 수 있어야 하기 때문이다.</div>
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
        label="os (쉼표 — darwin, linux, win32)"
        value={(req?.os ?? []).join(", ")}
        mono
        onCommit={(x) => ctx.apply((d) => set(d, ["requires", "os"], listField(x)))}
      />
      <div className="rc-label">binaries — 설치가 끝나면 목록 전부가 실재한다 (AND)</div>
      {bins.map((b, i) => (
        <div key={b.name} className="st-file" style={{ cursor: "default" }}>
          <span className="st-file-path">{b.name}</span>
          <button
            className="rc-btn"
            style={{ marginLeft: "auto" }}
            onClick={() => ctx.apply((d) => d.deleteIn(["requires", "binaries", i]))}
          >
            빼기
          </button>
        </div>
      ))}
      <div className="lv-in">
        <input placeholder="바이너리 이름 (예: git)" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="rc-btn accent"
          disabled={busy || !slugOk(name) || bins.some((b) => b.name === name.trim())}
          onClick={() => { make("requires-binary", name); setName(""); }}
        >
          추가
        </button>
      </div>
      <div className="st-hint">
        manager + package 를 함께 적으면 기판이 직접 깐다(레시피). 이름만 적으면 없을 때 설치가 거부되고 install 안내가 뜬다 — 원문 에디터에서 붙이세요.
      </div>
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
          <button className="rc-btn" style={{ marginLeft: "auto" }} onClick={() => ctx.apply((d) => d.deleteIn(["host_methods", i]))}>
            빼기
          </button>
        </div>
      ))}
      <div className="lv-in">
        <input placeholder="host.draft_publish" value={v} onChange={(e) => setV(e.target.value)} style={{ fontFamily: "var(--rc-mono)", fontSize: 12 }} />
        <button
          className="rc-btn accent"
          disabled={busy || !/^host\.[A-Za-z0-9]+([._][A-Za-z0-9]+)*$/.test(v.trim()) || list.includes(v.trim())}
          onClick={() => { make("host-method", v); setV(""); }}
        >
          추가
        </button>
      </div>
      <div className="st-hint">
        선언이 없으면 전체가 열린다(ring-0 결재가 유일한 경계). 하나라도 선언하면 목록 밖 메서드는 거부된다 — 좁히는 선언이지 여는 선언이 아니다.
      </div>
    </div>
  );
}

function YamlOnly({ def }: { def: SectionDef }) {
  return <div className="st-hint">이 섹션은 아직 전용 폼이 없다 — 개요의 relay.yaml 에디터에서 직접 선언하세요. 스키마 lint 가 문법을 잡아 준다.</div>;
}

function UnclaimedView({ ctx }: { ctx: SectionCtx }) {
  const extra = unclaimedFiles(ctx.manifest, ctx.files);
  const changed = new Set(ctx.changes.map((c) => c.file));
  return (
    <>
      <div className="st-hint">어떤 선언에도 잡히지 않은 파일. 매니페스트에서 도달 불가능한 파일은 설치본에서 존재하지 않는 것과 같다.</div>
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

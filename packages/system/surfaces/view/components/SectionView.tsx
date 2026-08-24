"use client";

import { useEffect, useState } from "react";
import type { Document } from "yaml";
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
  apply(mutate: (doc: Document) => void): void;
  createFile(path: string, content: string): void;
  openFile(path: string): void;
  openItem(item: string | null): void;
  /** system 패키지의 하네스 템플릿 복사 (선언과 실체를 같이 만든다) */
  seedHarness(source: string, entry: string): void;
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
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} onAdd={() => setAdding(true)} addLabel="채널 어댑터" />
      {adding ? (
        <div className="lv-in">
          <input placeholder="채널 이름 (예: discord)" value={chName} onChange={(e) => setChName(e.target.value)} />
          <button
            className="rc-btn accent"
            onClick={() => {
              const n = chName.trim();
              if (!n) return;
              ctx.apply((d) => d.addIn(["surfaces", "channels"], { name: n, source: `channels/${n}`, entry: "index.ts" }));
              ctx.createFile(`channels/${n}/index.ts`, `// ${n} 채널 어댑터 — 계약은 relay.manifest.yaml surfaces.channels 참조\n`);
              setAdding(false);
              setChName("");
            }}
          >
            추가
          </button>
        </div>
      ) : null}
      {!m.surfaces?.view ? (
        <button className="rc-btn add" onClick={() => ctx.apply((d) => set(d, ["surfaces", "view"], { source: "surfaces/view" }))}>
          + view 표면 선언
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
  const [tpl, setTpl] = useState(HARNESS_TEMPLATES[0]);
  const have = new Set((m.harness?.variants ?? []).map((v) => v.name));
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <select value={tpl} onChange={(e) => setTpl(e.target.value)}>
          {HARNESS_TEMPLATES.filter((t) => !have.has(t)).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <button
          className="rc-btn accent"
          onClick={() => {
            if (have.has(tpl)) return;
            ctx.apply((d) => d.addIn(["harness", "variants"], { name: tpl, source: `harness/${tpl}`, entry: "run" }));
            ctx.seedHarness(`harness/${tpl}`, "run");
          }}
        >
          + 하네스 후보
        </button>
      </div>
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
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <input placeholder="에이전트 이름 (착지 = 패키지 짧은 이름)" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="rc-btn accent"
          onClick={() => {
            const n = name.trim();
            if (!n || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(n)) return;
            ctx.apply((d) => d.addIn(["agents"], { name: n, persona: `agents/${n}/AGENT.md` }));
            ctx.createFile(`agents/${n}/AGENT.md`, `당신은 ${n}입니다.\n\n# 역할\n\n# 소통\n\n# 경계\n`);
            setName("");
          }}
        >
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
  return (
    <>
      {!src ? (
        <button className="rc-btn add" onClick={() => ctx.apply((d) => d.setIn(["scripts"], { source: "scripts" }))}>
          + scripts.source 선언 (scripts/)
        </button>
      ) : (
        <>
          <ItemList def={def} items={items} ctx={ctx} />
          <div className="lv-in">
            <input placeholder="동사 이름 (예: report-weekly)" value={name} onChange={(e) => setName(e.target.value)} />
            <button
              className="rc-btn accent"
              onClick={() => {
                const n = name.trim();
                if (!n || !/^[a-z0-9][a-z0-9-]*$/.test(n)) return;
                ctx.createFile(`${src}/${n}.ts`, `export default async function (input: any, ctx: any) {\n  return { ok: true, input };\n}\n`);
                setName("");
              }}
            >
              추가
            </button>
          </div>
        </>
      )}
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
          onClick={() => {
            const n = name.trim();
            if (!n || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(n)) return;
            if (form === "url") ctx.apply((d) => d.addIn(["services"], { name: n, url: "https://example.com/mcp", auth: { kind: "none" } }));
            else if (form === "dir") ctx.apply((d) => d.addIn(["services"], { name: n, dir: `~/Documents/${n}` }));
            else {
              ctx.apply((d) =>
                d.addIn(["services"], form === "container" ? { name: n, source: `services/${n}`, dockerfile: "Dockerfile" } : { name: n, source: `services/${n}`, entry: "index.ts" }),
              );
              ctx.createFile(`services/${n}/${form === "container" ? "Dockerfile" : "index.ts"}`, form === "container" ? `FROM alpine\nCMD ["sleep", "infinity"]\n` : `console.log("${n} 서비스 기동");\nsetInterval(() => {}, 60000);\n`);
            }
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
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <input placeholder="트리거 id (예: daily-digest)" value={id} onChange={(e) => setId(e.target.value)} />
        <button
          className="rc-btn accent"
          onClick={() => {
            const n = id.trim();
            if (!n || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(n)) return;
            const landing = (ctx.manifest.agents ?? [])[0]?.name ?? "agent";
            ctx.apply((d) => d.addIn(["triggers"], { id: n, when: { cron: "0 9 * * *", tz: "Asia/Seoul" }, then: { agent: landing, prompt: "정기 점검을 수행해 주세요." } }));
            setId("");
          }}
        >
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
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <input placeholder="미션 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="rc-btn accent"
          onClick={() => {
            const n = name.trim();
            if (!n) return;
            ctx.apply((d) => d.addIn(["missions"], { name: n, description: "" }));
            setName("");
          }}
        >
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
  return (
    <>
      <ItemList def={def} items={items} ctx={ctx} />
      <div className="lv-in">
        <input placeholder="@scope/name (provider 혈통)" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <button
          className="rc-btn accent"
          onClick={() => {
            const n = provider.trim();
            if (!n) return;
            ctx.apply((d) => d.addIn(["edges"], { provider: n }));
            setProvider("");
          }}
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
  return (
    <div className="st-form">
      <Field label="provider" value={e.provider} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "provider"], x))} />
      <Field label="tools (mcp 소비, 쉼표 — mission 과 배타)" value={(e.tools ?? []).join(", ")} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "tools"], listField(x)))} />
      <Field label="mission (a2a 위임 — tools 와 배타)" value={e.mission ?? ""} mono onCommit={(x) => ctx.apply((d) => set(d, ["edges", idx, "mission"], x))} />
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

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Graph from "@/components/Graph";
import { edgesData } from "@/lib/api";
import type { Material } from "@/lib/sections";
import { draftBuild, draftRun, type DraftStatus } from "@/lib/studio";
import type { Manifest, Registry } from "@/lib/types";

// 결과면 — 저작 중인 선언이 **세상에서 무엇이 되는지**를 그 자리에서 보여 준다.
//
// 이 면이 없던 동안 스튜디오에는 결과로 가는 문이 하나뿐이었다: [적용] 을 눌러 릴리스를 띄운
// 뒤 새 탭으로 여는 실행본. 그건 미리보기가 아니라 발행물이라, 저작의 되먹임 고리가
// "고친다 → 도는 판을 갈아치운다 → 본다" 였다. 여기서 끊는다.
//
// 모양은 재료가 정한다(lib/sections.ts Material). 하나의 UX 로 통일하지 않는 것이 요점이다 —
// 그림·배선·시간·말·동사·계약은 사람이 손으로 다루는 방식이 서로 다르고, 그 차이를 지우면
// 전부 "폼과 텍스트" 로 수렴한다(지금이 그 상태다).

export interface PreviewCtx {
  pkg: string;
  manifest: Manifest;
  status: DraftStatus;
  sec: string | null;
  item: string | null;
  reg: Registry | null;
  /** draft 의 변경 지문 — 바뀌면 프레임이 스스로 새로 읽는다(즉시성의 실체) */
  rev: string;
  say(kind: "ok" | "err" | "info", text: string): void;
  refresh(): Promise<void>;
}

/** 이 선택이 어떤 재료인지 — 섹션의 재료를 항목이 좁힌다(surfaces 는 항목마다 다르다) */
export function materialOf(material: Material | undefined, sec: string | null, item: string | null): Material {
  if (sec === "surfaces") {
    if (item === "view" || item === "components") return "그림";
    if (item?.startsWith("channel:")) return "계약";
  }
  return material ?? "계약";
}

export default function Preview({ ctx, material }: { ctx: PreviewCtx; material: Material }) {
  if (material === "그림") {
    return ctx.item === "components" ? <MountPane ctx={ctx} /> : <FramePane ctx={ctx} />;
  }
  if (material === "배선") return <WirePane ctx={ctx} />;
  if (material === "시간") return <TimePane ctx={ctx} />;
  if (material === "말") return <AgentPane ctx={ctx} />;
  if (material === "동사") return <RunPane ctx={ctx} />;
  return <CardsPane ctx={ctx} />;
}

// ── 공통 조각 ───────────────────────────────────────────────────────────────

function Head({ chip, url, children }: { chip: string; url?: string; children?: React.ReactNode }) {
  return (
    <div className="pv-head">
      <span className="rc-chip">{chip}</span>
      {url ? <span className="pv-url mono">{url}</span> : <span className="st-sp" />}
      {children}
    </div>
  );
}

function Note({ children, kind }: { children: React.ReactNode; kind?: "warn" }) {
  return <div className={`st-hint${kind === "warn" ? " pv-warn" : ""}`}>{children}</div>;
}

/** out 을 선언한 표면은 굽지 않으면 미리볼 것이 없다 — 굽기를 이 면이 직접 들고 있다 */
function BuildButton({ ctx, onDone }: { ctx: PreviewCtx; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="rc-btn"
      disabled={busy}
      title="작업 사본의 화면을 미리보기용으로 만듭니다 — 돌아가는 판은 그대로입니다"
      onClick={async () => {
        setBusy(true);
        try {
          const r = await draftBuild(ctx.pkg);
          ctx.say("ok", r.out || "미리보기를 만들었습니다");
          onDone();
        } catch (e) {
          ctx.say("err", `미리보기 만들기 실패: ${String(e instanceof Error ? e.message : e)}`);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "만드는 중…" : "미리보기 만들기"}
    </button>
  );
}

// ── 그림 · 화면 ─────────────────────────────────────────────────────────────

function FramePane({ ctx }: { ctx: PreviewCtx }) {
  const view = ctx.manifest.surfaces?.view;
  const [narrow, setNarrow] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // 파일이 바뀌면 프레임이 스스로 새로 읽는다. 빌드가 필요한 표면(out 선언)은 굽기 전까지
  // 옛 산출이 서므로 여기서 갱신되는 것은 "굽고 나서" 다 — 정적 소스는 곧바로다
  useEffect(() => { reload(); }, [ctx.rev, reload]);

  if (!view) {
    return (
      <div className="pv">
        <Head chip="미리보기" />
        <div className="empty">
          <span>view 표면이 선언되지 않았습니다.</span>
          <Note>선언하면 이 자리에 작업 사본의 화면이 뜹니다 — 발행 전에, 새 탭 없이.</Note>
        </div>
      </div>
    );
  }
  const src = `/draft/${encodeURIComponent(ctx.pkg)}/view/?_rev=${nonce}`;
  return (
    <div className="pv">
      <Head chip="발행 전" url={`/draft/${ctx.pkg}/view/`}>
        <div className="seg">
          <button aria-pressed={!narrow} onClick={() => setNarrow(false)}>넓게</button>
          <button aria-pressed={narrow} onClick={() => setNarrow(true)}>좁게</button>
        </div>
        <button className="rc-btn" onClick={reload} title="다시 읽기">↻</button>
        {view.out ? <BuildButton ctx={ctx} onDone={reload} /> : null}
      </Head>
      <div className="pv-body flush">
        <div className={`pv-frame${narrow ? " narrow" : ""}`}>
          <iframe key={nonce} src={src} title="작업 사본 미리보기" />
        </div>
      </div>
      <div className="pv-foot">
        {view.out
          ? `빌드가 필요한 화면입니다 — 소스를 고친 뒤 [미리보기 만들기] 를 눌러야 이 프레임이 새 판을 냅니다.`
          : `빌드 없는 화면이라 파일을 저장하면 이 프레임이 곧바로 새로 읽습니다.`}
      </div>
    </div>
  );
}

// ── 그림 · 컴포넌트 ─────────────────────────────────────────────────────────

const DEFAULT_PROPS = `{\n  "title": "안녕하세요"\n}`;

/**
 * 마운트 미리보기. 계약이 수출 하나(mount(el, props))뿐이라 **빈 문서에 마운트한 것이 곧
 * 미리보기**다 — 소비자 런타임 전제가 없어서 이 축이 오히려 제일 싸게 선다.
 *
 * props 칸은 저작물이 아니다. 소비자가 넘길 값을 흔들어 보는 시험대이고, 그래서 매니페스트에
 * 저장되지 않는다(브라우저 안에만 산다).
 */
function MountPane({ ctx }: { ctx: PreviewCtx }) {
  const comp = ctx.manifest.surfaces?.components;
  const [text, setText] = useState(DEFAULT_PROPS);
  const [nonce, setNonce] = useState(0);
  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false as const, error: String(e instanceof Error ? e.message : e) };
    }
  }, [text]);

  useEffect(() => { setNonce((n) => n + 1); }, [ctx.rev]);

  if (!comp) return <div className="empty">components 선언이 없습니다</div>;

  const bundle = `/draft/${encodeURIComponent(ctx.pkg)}/components/index.js?_rev=${nonce}`;
  // srcdoc 은 부모 오리진을 물려받으므로 절대경로 모듈 import 가 그대로 선다.
  // 실패를 삼키지 않는 것이 중요하다 — 빈 사각형은 "아직 안 그렸다"와 구별되지 않는다
  const doc = `<!doctype html><meta charset="utf-8">
<style>
  :root{color-scheme:light}
  body{margin:0;padding:14px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;background:#fff;color:#16181b}
  #err{white-space:pre-wrap;font:12px/1.6 ui-monospace,monospace;color:#c0392b;background:#fdf2f1;border-radius:8px;padding:10px}
  #err:empty{display:none}
</style>
<div id="root"></div><div id="err"></div>
<script type="module">
  const show = (e) => { document.getElementById("err").textContent = String(e && e.stack || e); };
  window.addEventListener("error", (e) => show(e.error ?? e.message));
  try {
    const mod = await import(${JSON.stringify(bundle)});
    if (typeof mod.mount !== "function") throw new Error("계약 위반: mount 를 수출하지 않습니다 (export function mount(el, props))");
    mod.mount(document.getElementById("root"), ${JSON.stringify(parsed.ok ? parsed.value : {})});
  } catch (e) { show(e); }
</script>`;

  return (
    <div className="pv">
      <Head chip="자립 번들" url={`import { mount } from "${ctx.manifest.name ?? ctx.pkg}"`}>
        <button className="rc-btn" onClick={() => setNonce((n) => n + 1)} title="다시 마운트">↻</button>
        {comp.out ? <BuildButton ctx={ctx} onDone={() => setNonce((n) => n + 1)} /> : null}
      </Head>
      <div className="pv-body">
        <div className="pv-mount">
          <iframe key={nonce + text} srcDoc={doc} title="마운트 미리보기" />
        </div>
        <label className="st-field">
          <span>시험용 props — 저작물이 아닙니다. 소비자가 넘길 값을 흔들어 봅니다</span>
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
        </label>
        {!parsed.ok ? <Note kind="warn">JSON 아님: {parsed.error}</Note> : null}
        <Note>
          계약은 수출 하나입니다 — {"mount(el, props): { unmount() }"}. 번들은 자기 런타임을 안고 나오므로 이 프레임에는 아무 프레임워크도 깔려 있지 않습니다.
        </Note>
      </div>
    </div>
  );
}

// ── 계약 · 이 문장이 되는 화면들 ────────────────────────────────────────────

function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

function CardsPane({ ctx }: { ctx: PreviewCtx }) {
  const m = ctx.manifest;
  const ch = ctx.item?.startsWith("channel:") ? (m.surfaces?.channels ?? []).find((c) => `channel:${c.name}` === ctx.item) : null;
  if (ch) return <CredentialPane name={ch.name} fields={ch.credential?.fields ?? []} help={ch.credential?.help} />;

  const label = m.display_name ?? ctx.pkg;
  const desc = m.description ?? "";
  const color = `hsl(${hueOf(m.name ?? ctx.pkg)} 46% 34%)`;
  const initial = label.trim().charAt(0) || "?";
  const req = m.requires;

  return (
    <div className="pv">
      <Head chip="이 문장이 되는 것들" />
      <div className="pv-body">
        <div className="pv-row">
          <span className="rc-label">지도의 카드</span>
          <div className="pv-card">
            <span className="pv-ic" style={{ background: color }}>{initial}</span>
            <span>
              <span className="pv-nm">{label}</span>
              <span className="pv-ds">{desc}</span>
              <span className="pv-lg mono">{m.name} · v{m.version} · {ctx.status.installed ? "설치됨" : "미발행"}</span>
            </span>
          </div>
        </div>
        <div className="pv-row">
          <span className="rc-label">설치 화면의 머리</span>
          <div className="pv-card">
            <span className="pv-ic" style={{ background: color }}>{initial}</span>
            <span>
              <span className="pv-nm">{label} 설치</span>
              <span className="pv-ds">
                {[
                  (m.services ?? []).some((s) => s.dir) ? `폴더 ${(m.services ?? []).filter((s) => s.dir).length}곳` : null,
                  (m.services ?? []).some((s) => s.url || s.api) ? "외부 접점" : null,
                  (m.triggers ?? []).length ? "시간·사건 깨움" : null,
                  (m.edges ?? []).length ? "남의 것 소비" : null,
                  m.host_methods?.length ? "기판 브리지" : null,
                ].filter(Boolean).join(" · ") || "요구하는 것 없음"}
              </span>
            </span>
          </div>
        </div>
        {req ? (
          <div className="pv-row">
            <span className="rc-label">설치 관문 — 이 기판에서의 요구</span>
            <div className="st-files">
              {(req.os ?? []).length ? (
                <div className="st-file" style={{ cursor: "default" }}>
                  <span className="st-file-path">os: {(req.os ?? []).join(", ")}</span>
                  <span className="rc-chip gray" style={{ marginLeft: "auto" }}>설치가 판정</span>
                </div>
              ) : null}
              {(req.binaries ?? []).map((b) => (
                <div key={b.name} className="st-file" style={{ cursor: "default" }}>
                  <span className="st-file-path">{b.name}</span>
                  <span className="rc-chip gray" style={{ marginLeft: "auto" }}>설치가 판정</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className="pv-row">
          <span className="rc-label">스토어 등재 카드</span>
          <div className="pv-card col">
            <div className="pv-card-row">
              <span className="pv-ic" style={{ background: color }}>{initial}</span>
              <span>
                <span className="pv-nm">{label}</span>
                <span className="pv-lg mono">{m.name}</span>
              </span>
            </div>
            <span className="pv-ds">{desc}</span>
          </div>
        </div>
        <Note>세 화면이 같은 두 문장(표시 이름·설명)을 씁니다 — 여기서 고치면 저기가 바뀐다는 것이 확인 없이 믿어져야 합니다.</Note>
      </div>
    </div>
  );
}

/** 자격의 형태 선언이 그리는 폼 — 연결 화면(ChannelDialog)이 읽는 것과 같은 선언이다 */
function CredentialPane({ name, fields, help }: { name: string; fields: { key?: string; label: string; placeholder?: string; secret?: boolean; list?: boolean; required?: boolean }[]; help?: { url?: string; note?: string } }) {
  const mixed = fields.length > 1 && fields.some((f) => !f.key);
  return (
    <div className="pv">
      <Head chip="연결 화면" url={`${name} 자격`} />
      <div className="pv-body">
        {fields.length ? (
          <div className="st-form">
            {fields.map((f, i) => (
              <label key={i} className="st-field">
                <span>
                  {f.label || "(이름 없는 칸)"}
                  {f.required ? " *" : ""}
                  {f.list ? " — 쉼표로 여럿" : ""}
                </span>
                <input type={f.secret ? "password" : "text"} placeholder={f.placeholder ?? (f.list ? "1234, 5678" : "")} readOnly />
              </label>
            ))}
            <div className="detail-foot">
              <button className="rc-btn accent" disabled>연결</button>
              <button className="rc-btn" disabled>검증만</button>
            </div>
          </div>
        ) : (
          <Note>
            credential 선언이 없어 연결 화면은 <b>원시 붙여넣기 칸</b>으로 물러납니다 — 제3자 어댑터가 선언 없이도 연결될 수 있어야 하기 때문입니다.
          </Note>
        )}
        {mixed ? <Note kind="warn">key 있는 칸과 없는 칸이 섞였습니다 — 조립 규칙상 판정 실패입니다.</Note> : null}
        {help?.note || help?.url ? <Note>{help?.note} {help?.url}</Note> : null}
        <Note>값은 여기 살지 않습니다. 매니페스트는 형태만 선언하고 값은 vault 에 앉습니다 — 이 폼은 그 형태의 거울입니다.</Note>
      </div>
    </div>
  );
}

// ── 배선 ────────────────────────────────────────────────────────────────────

/**
 * 배선은 새로 그리지 않는다 — 콘솔의 지도(Graph.tsx)를 **이 패키지의 시야로 좁혀** 쓴다.
 * 두 벌 그리면 두 벌이 갈라지고, 그 갈라짐은 "콘솔에서는 결재됐는데 스튜디오에서는 아니다"
 * 같은 형태로 나타난다.
 */
function WirePane({ ctx }: { ctx: PreviewCtx }) {
  const scoped = useMemo(() => {
    if (!ctx.reg) return null;
    const near = new Set<string>([ctx.pkg]);
    for (const e of ctx.manifest.edges ?? []) {
      const short = e.provider.split("/").pop();
      for (const p of ctx.reg.packages) if (p.name === short || p.manifest?.name === e.provider) near.add(p.name);
    }
    // 나를 소비하는 쪽도 이웃이다 — 미션·번들은 받는 쪽 선언이라 절반이 저쪽에 있다
    for (const p of ctx.reg.packages) {
      for (const e of p.manifest?.edges ?? []) {
        const short = e.provider.split("/").pop();
        if (short === ctx.pkg || e.provider === ctx.manifest.name) near.add(p.name);
      }
    }
    return { packages: ctx.reg.packages.filter((p) => near.has(p.name)), grants: ctx.reg.grants };
  }, [ctx.reg, ctx.manifest, ctx.pkg]);

  if (!scoped) return <div className="empty"><span className="rc-ring" /></div>;
  const edges = edgesData(scoped);
  const pending = edges.filter((e) => !e.granted).length;

  return (
    <div className="pv">
      <Head chip="이 패키지의 안팎">
        {pending ? <span className="rc-chip gray">결재 대기 {pending}</span> : <span className="rc-chip">전부 결재됨</span>}
      </Head>
      <div className="pv-body flush">
        <div className="pv-graph">
          <Graph reg={scoped} edges={edges} sel={ctx.pkg} onSelect={() => {}} onChanged={() => void ctx.refresh()} />
        </div>
      </div>
      <div className="pv-foot">선언은 신청이고 활성화는 결재입니다 — 점선은 아직 결재되지 않은 선언입니다.</div>
    </div>
  );
}

// ── 시간 ────────────────────────────────────────────────────────────────────

/** cron 5필드의 흔한 부분집합(*, 목록, 범위, 스텝)만 읽는다. 못 읽으면 null — 지어내지 않는다 */
function cronField(spec: string, lo: number, hi: number): number[] | null {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step < 1) return null;
    let a = lo;
    let b = hi;
    if (range !== "*") {
      const m = range.match(/^(\d+)(?:-(\d+))?$/);
      if (!m) return null;
      a = Number(m[1]);
      b = m[2] != null ? Number(m[2]) : Number(m[1]);
    }
    if (a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return [...out].sort((x, y) => x - y);
}

export function nextFires(cron: string, from: Date, count: number): Date[] | null {
  const f = cron.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const mins = cronField(f[0], 0, 59);
  const hours = cronField(f[1], 0, 23);
  const doms = cronField(f[2], 1, 31);
  const mons = cronField(f[3], 1, 12);
  const dows = cronField(f[4], 0, 7);
  if (!mins || !hours || !doms || !mons || !dows) return null;
  const dowSet = new Set(dows.map((d) => d % 7));
  const domAny = f[2] === "*";
  const dowAny = f[4] === "*";
  const out: Date[] = [];
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  // 1년을 분 단위로 훑지 않는다 — 날짜를 먼저 거르고 그날의 시각만 짠다
  for (let d = 0; d < 400 && out.length < count; d++) {
    const day = new Date(t.getFullYear(), t.getMonth(), t.getDate() + d);
    if (!mons.includes(day.getMonth() + 1)) continue;
    // cron 의 dom·dow 는 둘 다 제한이면 OR 다(둘 다 * 가 아니면 어느 한쪽만 맞아도 돈다)
    const okDom = doms.includes(day.getDate());
    const okDow = dowSet.has(day.getDay());
    const ok = domAny && dowAny ? true : domAny ? okDow : dowAny ? okDom : okDom || okDow;
    if (!ok) continue;
    for (const h of hours) {
      for (const mi of mins) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, mi, 0, 0);
        if (at <= from) continue;
        out.push(at);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

const DAYS = ["일", "월", "화", "수", "목", "금", "토"];

function TimePane({ ctx }: { ctx: PreviewCtx }) {
  const trig = useMemo(() => {
    const list = ctx.manifest.triggers ?? [];
    return (ctx.item ? list.find((t) => t.id === ctx.item) : null) ?? list[0] ?? null;
  }, [ctx.manifest, ctx.item]);
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => { setNow(new Date()); }, [ctx.rev]);

  if (!trig) {
    return (
      <div className="pv">
        <Head chip="일정" />
        <div className="empty"><span>트리거가 없습니다.</span><Note>선언하면 언제 도는지가 여기 격자와 목록으로 뜹니다.</Note></div>
      </div>
    );
  }
  if (trig.when?.event) {
    return (
      <div className="pv">
        <Head chip="사건" url={trig.when.event} />
        <div className="pv-body">
          <Note>
            사건은 시각이 없습니다 — 이 트리거는 <b>{trig.when.event}</b> 이 기판에 발생할 때 돕니다.
            {trig.when.debounce_ms ? ` 같은 사건이 몰리면 ${trig.when.debounce_ms}ms 동안 하나로 묶습니다.` : ""}
          </Note>
          <ThenLine trig={trig} />
        </div>
      </div>
    );
  }

  const cron = trig.when?.cron ?? "";
  const fires = now ? nextFires(cron, now, 5) : null;
  const hours = cron ? cronField(cron.trim().split(/\s+/)[1] ?? "", 0, 23) : null;
  const dowRaw = cron.trim().split(/\s+/)[4] ?? "*";
  const dows = cron ? cronField(dowRaw, 0, 7) : null;
  const daySet = new Set((dows ?? []).map((d) => d % 7));
  const dayAny = dowRaw === "*";

  return (
    <div className="pv">
      <Head chip="언제 도는가" url={`${cron}${trig.when?.tz ? ` · ${trig.when.tz}` : ""}`} />
      <div className="pv-body">
        {fires === null ? (
          <Note kind="warn">이 cron 표현은 화면이 읽지 못했습니다 — 다음 발화를 짐작해 보여 주지 않습니다. 기판은 그대로 해석합니다.</Note>
        ) : (
          <>
            <div className="pv-row">
              <span className="rc-label">주간 격자</span>
              <div className="pv-week">
                <div className="hd" />
                {DAYS.map((d, i) => (
                  <div key={d} className={`hd${dayAny || daySet.has(i) ? " on" : ""}`}>{d}</div>
                ))}
                {Array.from({ length: 24 }, (_, h) => (
                  <Row key={h} h={h} hours={hours} dayAny={dayAny} daySet={daySet} />
                ))}
              </div>
            </div>
            <div className="pv-row">
              <span className="rc-label">다음 5회</span>
              <div className="pv-next">
                {fires.length ? (
                  fires.map((t, i) => (
                    <div key={i}>
                      <span>{t.getMonth() + 1}.{String(t.getDate()).padStart(2, "0")} {DAYS[t.getDay()]}</span>
                      <span>{String(t.getHours()).padStart(2, "0")}:{String(t.getMinutes()).padStart(2, "0")}</span>
                      <span className="rel">{relLabel(t, now!)}</span>
                    </div>
                  ))
                ) : (
                  <div>앞으로 400일 안에 도는 시각이 없습니다</div>
                )}
              </div>
            </div>
          </>
        )}
        <ThenLine trig={trig} />
        {trig.when?.tz ? null : <Note kind="warn">tz 미선언 — 기판이 도는 기계의 시간대를 씁니다. 옮기면 발화 시각이 바뀝니다.</Note>}
      </div>
    </div>
  );
}

function Row({ h, hours, dayAny, daySet }: { h: number; hours: number[] | null; dayAny: boolean; daySet: Set<number> }) {
  return (
    <>
      <div className="hr">{h % 6 === 0 ? h : ""}</div>
      {DAYS.map((_, d) => {
        const onDay = dayAny || daySet.has(d);
        const onHour = hours?.includes(h) ?? false;
        return <div key={d} className={`cell${onDay && onHour ? " on" : onDay ? " dayon" : ""}`} title={`${DAYS[d]} ${h}시`} />;
      })}
    </>
  );
}

function relLabel(t: Date, from: Date): string {
  const h = Math.round((t.getTime() - from.getTime()) / 3600000);
  if (h < 1) return "곧";
  if (h < 24) return `${h}시간 뒤`;
  return `${Math.round(h / 24)}일 뒤`;
}

function ThenLine({ trig }: { trig: { then?: { agent?: string; script?: string; prompt?: string; delivery?: string } } }) {
  const t = trig.then ?? {};
  return (
    <Note>
      {t.script
        ? `깨어나면 ${t.script} 동사가 headless 로 돕니다 — 대화 없이.`
        : `깨어나면 ${t.agent ?? "(에이전트 미선언)"} 의 세션이 열려 이 말을 받습니다: "${t.prompt ?? ""}"`}
      {t.delivery ? ` 결과는 ${t.delivery} 로 배달됩니다.` : t.script ? "" : " delivery 를 선언하면 결과가 채널 대화로 배달됩니다."}
    </Note>
  );
}

// ── 말 ──────────────────────────────────────────────────────────────────────

/** 아주 작은 마크다운 — 페르소나는 제목·목록·강조가 거의 전부다. 의존성을 늘리지 않는다 */
function renderPersona(md: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = md.split("\n");
  let buf: string[] = [];
  const flush = (k: number) => {
    if (!buf.length) return;
    out.push(<p key={`p${k}`}>{inline(buf.join(" "))}</p>);
    buf = [];
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flush(i);
      const lvl = h[1].length;
      out.push(lvl <= 2 ? <h4 key={i}>{inline(h[2])}</h4> : <h5 key={i}>{inline(h[2])}</h5>);
      return;
    }
    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      flush(i);
      out.push(<div key={i} className="pv-li">{inline(li[1])}</div>);
      return;
    }
    if (!line.trim()) { flush(i); return; }
    buf.push(line);
  });
  flush(lines.length);
  return out;
}

function inline(s: string): React.ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) return <b key={i}>{p.slice(2, -2)}</b>;
    if (p.startsWith("`") && p.endsWith("`")) return <code key={i} className="mono">{p.slice(1, -1)}</code>;
    return p;
  });
}

/** 선언 → 이 세션이 보게 될 도구 이름. 조립 문법의 정본은 runner/protocol.ts 다 */
function derivedTools(m: Manifest, agentName: string, files: string[]): string[] {
  const agent = (m.agents ?? []).find((a) => a.name === agentName);
  if (!agent) return [];
  const inPlay = [agent, ...(agent.dispatch ?? []).map((n) => (m.agents ?? []).find((a) => a.name === n)).filter(Boolean)] as typeof agent[];
  const out = new Set<string>();
  const src = m.scripts?.source;
  const verbs = src
    ? files.filter((f) => f.startsWith(src + "/") && f.endsWith(".ts")).map((f) => f.slice(src.length + 1).replace(/\.ts$/, ""))
    : [];
  for (const a of inPlay) {
    for (const pat of a.scripts ?? []) {
      const re = new RegExp("^" + pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      for (const v of verbs) if (re.test(v)) out.add(v);
    }
    for (const d of a.dirs ?? []) for (const op of ["list", "read", "write", "remove"]) out.add(`dir__${d}__${op}`);
  }
  for (const e of m.edges ?? []) {
    const provider = e.provider.split("/").pop() ?? e.provider;
    if (e.mission) out.add(`a2a__${provider}__${e.mission.replace(/[^a-zA-Z0-9_-]/g, "-")}`);
    for (const t of e.tools ?? []) out.add(`edge__${provider}__${t}`);
  }
  return [...out].sort();
}

function AgentPane({ ctx }: { ctx: PreviewCtx }) {
  const agents = ctx.manifest.agents ?? [];
  const agent = (ctx.item ? agents.find((a) => a.name === ctx.item) : null) ?? agents[0] ?? null;
  const [persona, setPersona] = useState<string | null>(null);

  useEffect(() => {
    if (!agent?.persona) { setPersona(null); return; }
    let on = true;
    void fetch(`/pkg/${encodeURIComponent(ctx.pkg)}/script/draft-read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { name: ctx.pkg, file: agent.persona } }),
    })
      .then((r) => r.json())
      .then((d) => { if (on) setPersona(d?.result?.content ?? null); })
      .catch(() => { if (on) setPersona(null); });
    return () => { on = false; };
  }, [ctx.pkg, agent?.persona, ctx.rev]);

  if (!agent) {
    return <div className="pv"><Head chip="시연 대화" /><div className="empty"><span>에이전트가 없습니다.</span></div></div>;
  }
  const tools = derivedTools(ctx.manifest, agent.name, ctx.status.files);

  return (
    <div className="pv">
      <Head chip="대화가 될 모습" url={`${agent.name} · draft`}>
        {ctx.status.installed ? (
          <a className="rc-btn" href={`/pkg/${encodeURIComponent(ctx.pkg)}/view/`} target="_blank" rel="noreferrer" title="도는 판의 대화를 새 탭에서 엽니다">
            도는 판과 대화
          </a>
        ) : null}
      </Head>
      <div className="pv-body">
        <div className="pv-row">
          <span className="rc-label">빈 대화의 첫 줄</span>
          <div className="pv-chat">
            <div className="msg bot">{agent.greeting || "(인사말 미선언 — 빈 대화가 아무 말 없이 열립니다)"}</div>
          </div>
        </div>
        <div className="pv-row">
          <span className="rc-label">선언에서 도출된 도구 {tools.length}개 — 이 세션이 보게 될 것</span>
          <div className="pv-chips">
            {tools.length ? (
              tools.map((t) => <span key={t} className="rc-chip gray mono">{t}</span>)
            ) : (
              <span className="st-hint">scripts scope 도 dirs 도 edges 도 없습니다 — 이 세션은 말만 합니다.</span>
            )}
          </div>
        </div>
        <div className="pv-row">
          <span className="rc-label">페르소나 {agent.persona ? `· ${agent.persona}` : ""}</span>
          <div className="pv-persona">
            {persona == null ? <span className="st-hint">페르소나 파일을 읽지 못했습니다.</span> : renderPersona(persona)}
          </div>
        </div>
        <Note kind="warn">
          한 턴 돌려보기는 아직 없습니다 — 하네스 번들이 릴리스 스냅샷에서 구워지므로, 지금 도는 대화는 <b>발행된 인격</b>입니다.
          위 세 가지(첫 줄·도구 목록·페르소나)는 작업 사본의 것입니다.
        </Note>
      </div>
    </div>
  );
}

// ── 동사 ────────────────────────────────────────────────────────────────────

function RunPane({ ctx }: { ctx: PreviewCtx }) {
  const src = ctx.manifest.scripts?.source;
  const verbs = useMemo(
    () =>
      src
        ? ctx.status.files.filter((f) => f.startsWith(src + "/") && f.endsWith(".ts")).map((f) => f.slice(src.length + 1).replace(/\.ts$/, ""))
        : [],
    [ctx.status.files, src],
  );
  const [verb, setVerb] = useState<string>("");
  const [input, setInput] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ ok: boolean; ms: number; body: string } | null>(null);
  const picked = verb || (ctx.item && verbs.includes(ctx.item) ? ctx.item : verbs[0]) || "";
  const lastItem = useRef<string | null>(null);
  useEffect(() => {
    if (ctx.item && ctx.item !== lastItem.current) { lastItem.current = ctx.item; setVerb(""); setOut(null); }
  }, [ctx.item]);

  if (!src) {
    return <div className="pv"><Head chip="실행" /><div className="empty"><span>scripts 가 선언되지 않았습니다.</span></div></div>;
  }

  const run = async () => {
    let parsed: unknown = {};
    try {
      parsed = input.trim() ? JSON.parse(input) : {};
    } catch (e) {
      setOut({ ok: false, ms: 0, body: `입력이 JSON 이 아닙니다: ${String(e instanceof Error ? e.message : e)}` });
      return;
    }
    setBusy(true);
    try {
      const r = await draftRun(ctx.pkg, picked, parsed);
      setOut({ ok: r.ok, ms: r.ms, body: r.ok ? JSON.stringify(r.result, null, 2) : (r.error ?? "실패") });
      await ctx.refresh(); // 쓰기가 있는 동사면 트리가 그것을 보여야 한다
    } catch (e) {
      setOut({ ok: false, ms: 0, body: String(e instanceof Error ? e.message : e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pv">
      <Head chip="돌려보기" url={`${src}/${picked || "?"}.ts`} />
      <div className="pv-body">
        <label className="st-field">
          <span>동사</span>
          <select value={picked} onChange={(e) => { setVerb(e.target.value); setOut(null); }}>
            {verbs.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        </label>
        <label className="st-field">
          <span>input (JSON)</span>
          <textarea rows={4} value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} />
        </label>
        <div className="detail-foot">
          <button className="rc-btn accent" disabled={busy || !picked} onClick={() => void run()}>
            {busy ? "도는 중…" : "돌려보기"}
          </button>
          {out ? (
            <span className="pv-receipt">
              <span className={`rc-chip${out.ok ? "" : " err"}`}>{out.ms}ms</span>
              {out.ok ? " 통과" : " 실패"}
            </span>
          ) : (
            <span className="pv-receipt">아직 돌린 적 없음</span>
          )}
        </div>
        <div className="pv-row">
          <span className="rc-label">결과</span>
          <pre className={`pv-out${out && !out.ok ? " err" : ""}`}>
            {out ? out.body : "코드는 작업 사본, 맥락(작업 폴더·자격·서비스)은 설치본입니다.\n미리보기가 새 살림이면 여기서 통과한 것이 발행 뒤에도 통과한다는 보장이 없습니다."}
          </pre>
        </div>
        <Note kind="warn">쓰기가 있는 동사는 <b>진짜로 씁니다</b> — 시늉이 아닙니다. 맥락이 설치본의 것이기 때문입니다.</Note>
      </div>
    </div>
  );
}

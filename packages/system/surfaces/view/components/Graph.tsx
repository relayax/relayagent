"use client";

/* 배포 그래프 캔버스 — relayos-claude monitor graph 이식.
   직선 엣지 + 상태 스타일, 카드 = manifest 선언의 합성, 팬/줌/드래그,
   "+" 포트 드래그 연결, LOD, a2a 레벨 기반 오토레이아웃.
   좌표는 전부 카드 중심값이고 렌더에서 top-left 로 변환한다 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AddEdgeDialog, { type EdgePrefill } from "@/components/AddEdgeDialog";
import HarnessDialog from "@/components/HarnessDialog";
import ChannelDialog from "@/components/ChannelDialog";
import ServiceDialog from "@/components/ServiceDialog";
import { Button } from "@/components/ui/button";
import { isOutward, serviceForm, SERVICE_FORM_LABEL, type EdgeView, type Pkg, type Registry } from "@/lib/types";

const W = 1180;
const CARD_W = 200;
const CARD_H = 96;
const SMIN = 0.4;
/** 처음 맞출 때의 하한 — 다 보이자고 0.59 까지 줄이면 글씨가 안 읽혔다(2026-08-27). 넘치면 끌어서 본다 */
const FIT_MIN = 0.85;
const SMAX = 2;
const LOD_FAR = 0.7;
const LAYOUT_KEY = "relay.graph.layout.v1";

type P = { x: number; y: number };

interface Line {
  a: string;
  b: string;
  k: "mcp" | "a2a";
  granted: boolean;
  tools?: string[];
  mission?: string;
  /** 소비자가 raw 도구까지 선언했다(agent_access: full) — 지도가 라벨에 적는다 */
  raw?: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function spread(n: number, lo: number, hi: number, gap: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [(lo + hi) / 2];
  const g = Math.min(gap, (hi - lo) / (n - 1));
  const start = (lo + hi) / 2 - (g * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => start + i * g);
}

// 순수 데이터 → 좌표. DOM 을 재지 않는다 — 레이아웃은 렌더 전에 결정적이어야 한다
function estHeight(p: Pkg): number {
  const m = p.manifest;
  let h = 44;
  if ((m?.agents?.length ?? 0) > 0) h += 21;
  const svc = Math.min(m?.services?.length ?? 0, 3);
  if (svc > 0) h += 3 + svc * 24;
  if (m?.surfaces?.view) h += 21;
  h += 18;
  return Math.max(h, CARD_H);
}

function autoLayout(pkgs: Pkg[], lines: Line[]): { pos: Record<string, P>; h: number; lane: { y: number; n: number } | null } {
  const pos: Record<string, P> = {};
  const sys = pkgs.filter((p) => p.ring === 0);
  const usr = pkgs.filter((p) => p.ring !== 0);

  const sxs = spread(sys.length, 140, W - 140, 236);
  sys.forEach((p, i) => (pos[p.name] = { x: sxs[i], y: 70 }));
  let bodyTop = 168;
  for (const p of sys) bodyTop = Math.max(bodyTop, 70 - 21 + estHeight(p) + 44);

  // 레벨은 a2a(위임)만 만든다. mcp 는 "연결됐는가"만 센다. 12회 완화 = 순환 수렴 캡
  const lvl: Record<string, number> = {};
  const a2a = lines.filter((l) => l.k === "a2a");
  for (const l of a2a) {
    lvl[l.a] = lvl[l.a] ?? 0;
    lvl[l.b] = lvl[l.b] ?? 0;
  }
  for (let pass = 0; pass < 12; pass++) {
    for (const l of a2a) if (lvl[l.b] < lvl[l.a] + 1) lvl[l.b] = lvl[l.a] + 1;
  }
  const touched = new Set(lines.flatMap((l) => [l.a, l.b]));
  const maxL = Math.max(0, ...Object.values(lvl));
  const tiers: Pkg[][] = Array.from({ length: maxL + 3 }, () => []);
  const isolated: Pkg[] = [];
  for (const p of usr) {
    if (!touched.has(p.name)) isolated.push(p);
    else if (p.name in lvl) tiers[lvl[p.name] + 1].push(p);
    else if (lines.some((l) => l.a === p.name)) tiers[0].push(p);
    else tiers[maxL + 2].push(p);
  }

  let cursor = bodyTop;
  const place = (row: Pkg[]) => {
    const rowW = row.length * CARD_W + (row.length - 1) * 40;
    const x0 = (W - rowW) / 2 + CARD_W / 2;
    row.forEach((p, i) => (pos[p.name] = { x: x0 + i * (CARD_W + 40), y: cursor + CARD_H / 2 }));
    cursor += Math.max(...row.map(estHeight)) + 44;
  };
  for (const tier of tiers) {
    for (let i = 0; i < tier.length; i += 5) place(tier.slice(i, i + 5));
  }
  let lane: { y: number; n: number } | null = null;
  if (isolated.length) {
    cursor += 6;
    lane = { y: cursor, n: isolated.length };
    cursor += 34;
    for (let i = 0; i < isolated.length; i += 5) place(isolated.slice(i, i + 5));
  }
  return { pos, h: Math.max(900, cursor - 44 + 64), lane };
}

// 앵커: 가로 우세면 좌우변, 세로 우세면 상하변에서 나간다
function anchors(a: P, b: P): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const s = Math.sign(dx) || 1;
    return { x1: a.x + (s * CARD_W) / 2, y1: a.y, x2: b.x - (s * CARD_W) / 2, y2: b.y };
  }
  const s = Math.sign(dy) || 1;
  return { x1: a.x, y1: a.y + (s * CARD_H) / 2, x2: b.x, y2: b.y - (s * CARD_H) / 2 };
}

function loadSaved(): Record<string, P> {
  try {
    return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export default function Graph({
  reg,
  edges,
  sel,
  onSelect,
  onChanged,
}: {
  reg: Registry;
  edges: EdgeView[];
  sel: string | null;
  onSelect: (name: string | null) => void;
  onChanged: () => void;
}) {
  const viewRef = useRef<HTMLDivElement>(null);
  const [pan, setPan] = useState<P>({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [saved, setSaved] = useState<Record<string, P>>({});
  const [hot, setHot] = useState<string | null>(null);
  const [ghost, setGhost] = useState<{ from: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<EdgePrefill | null>(null);
  const [harnessDlg, setHarnessDlg] = useState<Pkg | null>(null);
  const [channelDlg, setChannelDlg] = useState<Pkg | null>(null);
  const [serviceDlg, setServiceDlg] = useState<Pkg | null>(null);
  const persistT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panRef = useRef(pan);
  const scaleRef = useRef(scale);
  panRef.current = pan;
  scaleRef.current = scale;

  useEffect(() => setSaved(loadSaved()), []);

  const lines = useMemo<Line[]>(() => {
    const out: Line[] = [];
    for (const e of edges) {
      if (!e.provider || e.provider === e.consumer) continue;
      out.push({ a: e.consumer, b: e.provider, k: e.mission ? "a2a" : "mcp", granted: e.granted, tools: e.tools, mission: e.mission, raw: e.agent_access === "full" });
    }
    for (const g of reg.grants) {
      if (g.consumer === g.provider) continue;
      const declared = edges.some((e) => e.consumer === g.consumer && e.provider === g.provider && (g.mission ? e.mission === g.mission : true));
      if (!declared) out.push({ a: g.consumer, b: g.provider, k: g.mission ? "a2a" : "mcp", granted: true, tools: g.tools, mission: g.mission });
    }
    return out;
  }, [reg, edges]);

  const layout = useMemo(() => autoLayout(reg.packages, lines.filter((l) => l.granted)), [reg, lines]);
  const positions = useMemo(() => ({ ...layout.pos, ...saved }), [layout, saved]);
  const contentH = useMemo(
    () => Object.values(positions).reduce((h, p) => Math.max(h, p.y + 140), layout.h),
    [positions, layout.h],
  );

  const toContent = useCallback((clientX: number, clientY: number): P => {
    const el = viewRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: (clientX - r.left - panRef.current.x) / scaleRef.current, y: (clientY - r.top - panRef.current.y) / scaleRef.current };
  }, []);

  const applyScale = useCallback((target: number, cx: number, cy: number) => {
    const s = scaleRef.current;
    const s2 = clamp(target, SMIN, SMAX);
    if (s2 === s) return;
    const r = s2 / s;
    setPan((p) => ({ x: cx - r * (cx - p.x), y: cy - r * (cy - p.y) }));
    setScale(s2);
  }, []);

  const fit = useCallback(() => {
    const el = viewRef.current;
    if (!el) return;
    const pts = Object.values(positions);
    if (!pts.length) return;
    const x0 = Math.min(...pts.map((p) => p.x)) - CARD_W / 2;
    const x1 = Math.max(...pts.map((p) => p.x)) + CARD_W / 2;
    const y0 = Math.min(...pts.map((p) => p.y)) - CARD_H / 2;
    const y1 = Math.max(...pts.map((p) => p.y)) + CARD_H / 2 + 60;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const s = clamp(Math.min((vw - 64) / (x1 - x0), (vh - 64) / (y1 - y0), 1), FIT_MIN, SMAX);
    setScale(s);
    // 넘치면 가운데가 아니라 왼쪽 위부터 — 가운데 맞춤은 양끝이 잘려 첫 줄부터 못 읽는다
    const cx = (vw - (x1 - x0) * s) / 2, cy = (vh - (y1 - y0) * s) / 2;
    setPan({ x: Math.max(cx, 24) - x0 * s, y: Math.max(cy, 24) - y0 * s });
  }, [positions]);

  const fitted = useRef(false);
  useEffect(() => {
    if (!fitted.current && reg.packages.length) {
      fitted.current = true;
      fit();
    }
  }, [reg.packages.length, fit]);

  // wheel 은 non-passive 로 걸어야 preventDefault 가 산다. 트랙패드 핀치도 wheel 로 온다
  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      applyScale(scaleRef.current * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyScale]);

  function persist(next: Record<string, P>) {
    if (persistT.current) clearTimeout(persistT.current);
    persistT.current = setTimeout(() => localStorage.setItem(LAYOUT_KEY, JSON.stringify(next)), 500);
  }

  // 배경 = 팬 (움직이지 않은 pointerup 은 선택 해제), 카드 = 4px 데드존 지나면 드래그
  function bgDown(e: React.PointerEvent) {
    // 카드·선·버튼만 제외하고 전부 배경 취급 — svg 캔버스와 레인 라벨 위 클릭도 해제로 이어진다
    const t = e.target as Element;
    if (t.closest(".gx-node, .gx-edge, .gx-zoom, button")) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const p0 = panRef.current;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 2) moved = true;
      if (moved) setPan({ x: p0.x + (ev.clientX - sx), y: p0.y + (ev.clientY - sy) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) onSelect(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function cardDown(e: React.PointerEvent, name: string) {
    e.stopPropagation();
    const start = toContent(e.clientX, e.clientY);
    const c = positions[name];
    const ox = start.x - c.x;
    const oy = start.y - c.y;
    let moved = false;
    const move = (ev: PointerEvent) => {
      const p = toContent(ev.clientX, ev.clientY);
      if (!moved && Math.abs(p.x - start.x) + Math.abs(p.y - start.y) < 4) return;
      moved = true;
      setSaved((prev) => {
        const next = { ...prev, [name]: { x: p.x - ox, y: p.y - oy } };
        persist(next);
        return next;
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!moved) onSelect(name);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // "+" 포트: 다른 카드로 드래그하면 그 쌍이 미리 채워진 연결 다이얼로그가 열린다
  function portDown(e: React.PointerEvent, from: string) {
    e.stopPropagation();
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const p = toContent(ev.clientX, ev.clientY);
      setGhost({ from, x: p.x, y: p.y });
      const target = reg.packages.find((t) => {
        if (t.name === from) return false;
        const c = positions[t.name];
        return c && Math.abs(p.x - c.x) < CARD_W / 2 + 8 && Math.abs(p.y - c.y) < CARD_H / 2 + 8;
      });
      setHot(target?.name ?? null);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      const p = toContent(ev.clientX, ev.clientY);
      const target = reg.packages.find((t) => {
        if (t.name === from) return false;
        const c = positions[t.name];
        return c && Math.abs(p.x - c.x) < CARD_W / 2 + 8 && Math.abs(p.y - c.y) < CARD_H / 2 + 8;
      });
      setGhost(null);
      setHot(null);
      if (target) setDialog({ consumer: from, provider: target.name });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // 같은 쌍의 병렬 엣지는 법선 방향으로 20px 씩 부챗살
  const pairOffsets = useMemo(() => {
    const groups = new Map<string, number[]>();
    lines.forEach((l, i) => {
      const key = [l.a, l.b].sort().join("|");
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(i);
    });
    const off: number[] = lines.map(() => 0);
    for (const [key, idxs] of groups) {
      if (idxs.length < 2) continue;
      idxs.forEach((idx, i) => {
        const l = lines[idx];
        const canonical = [l.a, l.b].sort().join("|") === key && l.a <= l.b;
        off[idx] = (i - (idxs.length - 1) / 2) * 20 * (canonical ? 1 : -1);
      });
    }
    return off;
  }, [lines]);

  const grantsOut = (n: string) => reg.grants.filter((g) => g.consumer === n).length;
  const grantsIn = (n: string) => reg.grants.filter((g) => g.provider === n).length;
  const lodFar = scale < LOD_FAR;

  return (
    <div className="rc-card graph-wrap gx-shell">
      <div className="gx-bar">
        <b>연결 지도</b>
        <span className="gx-counts">
          {reg.packages.length}개 · {reg.grants.length ? `연결 ${reg.grants.length}` : "아직 연결 없음"}
        </span>
        <span className="gx-sp" />
        <Button variant="outline" size="sm" onClick={() => setDialog({})}>+ 연결</Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setSaved({});
            localStorage.removeItem(LAYOUT_KEY);
            fitted.current = false;
          }}
        >
          자동 배치
        </Button>
      </div>
      <div className="gx-view" ref={viewRef} onPointerDown={bgDown} data-lod={lodFar ? "far" : "near"}>
        <div
          className="gx-wrap"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, width: W, height: contentH }}
        >
          <svg className="gx-svg" width={W} height={contentH}>
            <defs>
              <marker id="gx-arrow" viewBox="0 0 8 8" refX="6.5" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
              </marker>
            </defs>
            {lines.map((l, i) => {
              const a = positions[l.a];
              const b = positions[l.b];
              if (!a || !b) return null;
              const { x1, y1, x2, y2 } = anchors(a, b);
              const len = Math.hypot(x2 - x1, y2 - y1) || 1;
              const nx = (-(y2 - y1) / len) * pairOffsets[i];
              const ny = ((x2 - x1) / len) * pairOffsets[i];
              const cls = l.k === "a2a" ? "gx-e-a2a" : l.granted ? "gx-e-ok" : "gx-e-decl";
              return (
                <g key={i} className={`gx-edge ${cls}${l.granted ? "" : " ghost"}`}>
                  {l.granted ? (
                    <path d={`M ${x1 + nx},${y1 + ny} L ${x2 + nx},${y2 + ny}`} className="gx-hit" />
                  ) : null}
                  <path
                    d={`M ${x1 + nx},${y1 + ny} L ${x2 + nx},${y2 + ny}`}
                    markerEnd="url(#gx-arrow)"
                    onClick={() =>
                      l.granted
                        ? onSelect(l.a)
                        : setDialog({ consumer: l.a, provider: l.b, mission: l.mission, tools: l.tools })
                    }
                  />
                </g>
              );
            })}
            {ghost && positions[ghost.from] ? (
              <path
                className="gx-ghostline"
                d={`M ${positions[ghost.from].x},${positions[ghost.from].y} L ${ghost.x},${ghost.y}`}
              />
            ) : null}
          </svg>

          {!lodFar &&
            lines.map((l, i) => {
              if (!l.granted) return null;
              const a = positions[l.a];
              const b = positions[l.b];
              if (!a || !b) return null;
              const { x1, y1, x2, y2 } = anchors(a, b);
              const len = Math.hypot(x2 - x1, y2 - y1) || 1;
              const nx = (-(y2 - y1) / len) * pairOffsets[i];
              const ny = ((x2 - x1) / len) * pairOffsets[i];
              const text = l.k === "a2a" ? `${l.mission} 위임` : `${(l.tools ?? [])[0] ?? "mcp"}${(l.tools?.length ?? 0) > 1 ? `+${l.tools!.length - 1}` : ""} 조회${l.raw ? " · raw" : ""}`;
              return (
                <div
                  key={`lb${i}`}
                  className={`gx-elabel${l.k === "a2a" ? " a2a" : " ok"}`}
                  style={{ left: (x1 + x2) / 2 + nx, top: (y1 + y2) / 2 + ny }}
                  title={`${text} · 클릭해 consumer 상세`}
                  onClick={() => onSelect(l.a)}
                >
                  {text}
                </div>
              );
            })}

          {layout.lane ? (
            <div className="gx-lane" style={{ top: layout.lane.y }}>
              연결 없음 · {layout.lane.n}
            </div>
          ) : null}

          {reg.packages.map((p) => {
            const c = positions[p.name];
            if (!c) return null;
            const m = p.manifest;
            const agents = m?.agents ?? [];
            const services = m?.services ?? [];
            const out = grantsOut(p.name);
            const inn = grantsIn(p.name);
            return (
              <div
                key={p.name}
                className={`gx-node${sel === p.name ? " sel" : ""}${hot === p.name ? " hot" : ""}${p.error ? " bad" : ""}`}
                style={{ transform: `translate(${c.x - CARD_W / 2}px, ${c.y - CARD_H / 2}px)` }}
                onPointerDown={(e) => cardDown(e, p.name)}
                title={`${m?.name ?? p.name} v${m?.version ?? "?"}`}
              >
                {/* 후보는 기판이 답한다 — 동봉 선언만 보면 풀로만 도는 패키지(스캐폴드 기본)에
                    알약이 통째로 안 뜬다. 아이콘 주소도 기판이 조립해 준다(풀 자산은 패키지 밑에 없다) */}
                {(p.harnessCandidates?.length || m?.harness?.variants?.length)
                  ? (() => {
                      const cands = p.harnessCandidates?.length
                        ? p.harnessCandidates
                        : (m!.harness!.variants!).map((v) => ({ name: v.name, provider: v.llm?.provider ?? null, icon: v.icon ? `/pkg/${encodeURIComponent(p.name)}/asset/${v.icon}` : null, llmIcon: v.llm?.icon ? `/pkg/${encodeURIComponent(p.name)}/asset/${v.llm.icon}` : null }));
                      const av = cands.find((v) => v.name === (p.harnessRunning ?? p.harness)) ?? cands[0];
                      const asset = (rel: string) => (rel.startsWith("/") ? rel : `/pkg/${encodeURIComponent(p.name)}/asset/${rel}`);
                      return (
                        <span
                          className="gx-pill llm"
                          title={`하네스 ${p.harness ?? av.name} · 모델 ${p.model ?? "어댑터 기본"} · 클릭해 설정`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setHarnessDlg(p);
                          }}
                        >
                          {av.icon ? <img src={asset(av.icon)} alt="" /> : null}
                          <span className="gx-pill-tx">{p.harnessRunning ?? p.harness ?? av.name}</span>
                          {p.model ? (
                            <>
                              {av.llmIcon ? <img src={asset(av.llmIcon)} alt="" /> : <span>·</span>}
                              <span className="gx-pill-tx">{p.model}</span>
                            </>
                          ) : null}
                        </span>
                      );
                    })()
                  : null}
                {(() => {
                  // 오른쪽 필 둘 — 창구(채널)와 바깥 서비스. 성질이 다른 두 문이라 필도 둘이고 글리프도 다르다
                  // (채널 = 동그라미·아이콘, 서비스 = 네모). 한 묶음(.gx-pills)에 나란히 세운다 — 종전엔 둘 다
                  // right:8px 절대좌표라 둘 다 있는 패키지에서 포개졌다(2026-08-28)
                  const chans = m?.surfaces?.channels ?? [];
                  // 자격 축이 있는 것은 밖으로 나가는 두 형(url·api)뿐이다 — source(몸)·dir(폴더)에는 auth 자리가 없다
                  const svcs = (m?.services ?? []).filter(
                    (sv) => isOutward(sv) && sv.auth != null && sv.auth.kind !== "none",
                  );
                  if (!chans.length && !svcs.length) return null;
                  return (
                    <span className="gx-pills">
                      {chans.length ? (
                        <span
                          className="gx-pill dep ch"
                          title={`창구(채널) ${chans.map((c) => c.name).join(" · ")} · 클릭해 연결·상태`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setChannelDlg(p);
                          }}
                        >
                          {chans.map((ch) =>
                            ch.icon ? (
                              <img key={ch.name} src={`/pkg/${encodeURIComponent(p.name)}/asset/${ch.icon}`} alt={ch.name} />
                            ) : (
                              <i key={ch.name}>{ch.name.slice(0, 1).toUpperCase()}</i>
                            ),
                          )}
                        </span>
                      ) : null}
                      {svcs.length ? (
                        <span
                          className="gx-pill dep svc"
                          title={`바깥 서비스 ${svcs.map((sv) => `${sv.name}${sv.auth?.required === false ? "(선택)" : ""}`).join(" · ")} · 클릭해 연결`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setServiceDlg(p);
                          }}
                        >
                          {svcs.map((sv) => (
                            <i key={sv.name}>{sv.name.slice(0, 1).toUpperCase()}</i>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  );
                })()}
                <div className="gx-head">
                  <span className="gx-avatar">
                    {m?.icon ? (
                      <img
                        src={`/pkg/${encodeURIComponent(p.name)}/asset/${m.icon}`}
                        alt=""
                        onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
                      />
                    ) : null}
                    {p.ring === 0 ? "S" : (m?.display_name ?? p.name).slice(0, 1)}
                  </span>
                  <b>{m?.display_name ?? p.name}</b>
                  {p.ring === 0 ? <i className="gx-ring0">ring-0</i> : null}
                  <span className="gx-ver">v{m?.version ?? "?"}</span>
                </div>
                {agents.length ? (
                  <div className="gx-facet">
                    <span className="gx-main">
                      {agents[0].name}
                      {agents.length > 1 ? `+${agents.length - 1}` : ""}
                    </span>
                    {m?.missions?.length ? (
                      <span className="gx-meta" title="relay.yaml missions[] · a2a 로 위임받을 수 있는 미션">
                        미션 {m.missions.length}
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {services.length ? (
                  <div className="gx-stores">
                    {services.slice(0, 3).map((s) => (
                      <div key={s.name} className="gx-store" title={`서비스 ${s.name} · ${SERVICE_FORM_LABEL[serviceForm(s)]}`}>
                        <b>{s.name}</b>
                        <span>{SERVICE_FORM_LABEL[serviceForm(s)]}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {m?.surfaces?.view ? (
                  <div className="gx-facet">
                    <span className="gx-main">화면 view</span>
                    <span className="gx-meta">{m.surfaces.view.out ? "빌드" : "정적"}</span>
                  </div>
                ) : null}
                {out || inn ? (
                  <div className="gx-foot">
                    <span className="gx-chip" title="연결된 프로그램 · 내가 쓰는 것(↗) / 나를 쓰는 것(↘)">
                      연결{out ? ` ↗${out}` : ""}{inn ? ` ↘${inn}` : ""}
                    </span>
                  </div>
                ) : null}
                <button
                  className="gx-port"
                  title="다른 카드로 드래그하면 프로그램 연결"
                  onPointerDown={(e) => portDown(e, p.name)}
                />
              </div>
            );
          })}
        </div>

        <div className="gx-zoom">
          <button disabled={scale <= SMIN} title="축소" onClick={() => zoomBtn(1 / 1.2)}>
            -
          </button>
          <button className="pct" title="화면에 맞춤" onClick={fit}>
            {Math.round(scale * 100)}%
          </button>
          <button disabled={scale >= SMAX} title="확대" onClick={() => zoomBtn(1.2)}>
            +
          </button>
        </div>
      </div>

      {dialog ? (
        <AddEdgeDialog
          reg={reg}
          prefill={dialog}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            onChanged();
          }}
        />
      ) : null}
      {harnessDlg ? (
        <HarnessDialog pkg={harnessDlg} onClose={() => setHarnessDlg(null)} onChanged={onChanged} />
      ) : null}
      {channelDlg ? (
        <ChannelDialog pkg={channelDlg} onClose={() => setChannelDlg(null)} onChanged={onChanged} />
      ) : null}
      {serviceDlg ? (
        <ServiceDialog pkg={serviceDlg} onClose={() => setServiceDlg(null)} onChanged={onChanged} />
      ) : null}
    </div>
  );

  function zoomBtn(factor: number) {
    const el = viewRef.current;
    if (!el) return;
    applyScale(scaleRef.current * factor, el.clientWidth / 2, el.clientHeight / 2);
  }
}

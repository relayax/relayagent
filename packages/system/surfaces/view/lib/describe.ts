import { unclaimedFiles } from "./sections.ts";
import type { EdgeView, Manifest } from "./types";

// 매니페스트 → 사람 말. 패키지 화면의 1층 "읽기"가 이 줄들을 그린다. 순수 함수 — 화면 밖에서
// 시험한다(node --experimental-strip-types 로 바로 돌므로 @/ alias 를 쓰지 않는다).
// 여기의 답에는 매니페스트 어휘(agents · scripts · edges …)가 나오면 안 된다 — 빌더 페르소나가
// 지키는 규칙("시스템 내부 이름을 답에 쓰지 마라")을 화면도 지킨다.

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
  if (!/^\d+$/.test(min)) return null;
  // 매시 N분 — 고르개가 만들 수 있는 식이므로 번역표도 알아야 한다. 둘이 어긋나면 방금 만든
  // 예약이 목록에서 "30 * * * *" 날식으로 떠서, 만든 사람이 자기가 만든 것을 못 알아본다
  if (hour === "*" && dow === "*") return Number(min) === 0 ? "매시 정각" : `매시 ${Number(min)}분`;
  if (!/^\d+$/.test(hour)) return null;
  const m = Number(min), h = Number(hour);
  if (m > 59 || h > 23) return null;
  const at = hourWord(h, m);
  if (dow === "*") return `매일 ${at}`;
  if (dow === "1-5") return `평일 ${at}`;
  if (/^[0-6]$/.test(dow)) return `매주 ${DAY[Number(dow)]}요일 ${at}`;
  return null;
}

/**
 * cron 을 사람이 고를 수 있는 것으로 — **읽기(cronToKorean)의 역방향**이다.
 *
 * "0 9 * * 1" 을 손으로 쓸 수 있는 사람만 예약을 만들 수 있었다. 다섯 칸의 문법은 이 화면에서
 * 가장 어려운 것이었고, 그나마 힌트가 "cron 식 — 예: 0 9 * * * 는 매일 9시" 한 줄이었다.
 * 고르개가 다루는 것은 cronToKorean 이 **번역할 수 있는 것과 정확히 같은 집합**이다 — 고른 것이
 * 곧 화면의 사람 말이 되고, 번역표 밖의 식(0 9 * * 1,3,5)은 고르개를 못 세우고 날식으로 남는다.
 */
export type CronEvery = "day" | "weekday" | "week" | "hour" | "minutes" | "hours";
export interface CronPick {
  every: CronEvery;
  /** week — 0(일) ~ 6(토) */
  dow?: number;
  hour?: number;
  min?: number;
  /** minutes · hours — N 분/시간마다 */
  n?: number;
}

export function buildCron(p: CronPick): string {
  const m = p.min ?? 0, h = p.hour ?? 9;
  switch (p.every) {
    case "day": return `${m} ${h} * * *`;
    case "weekday": return `${m} ${h} * * 1-5`;
    case "week": return `${m} ${h} * * ${p.dow ?? 1}`;
    case "hour": return `${m} * * * *`;
    case "minutes": return `*/${p.n ?? 10} * * * *`;
    case "hours": return `0 */${p.n ?? 3} * * *`;
  }
}

/** 고르개로 세울 수 있는 식인가. 아니면 null — 그때는 날식 칸이 정본이다 */
export function parseCron(expr: string): CronPick | null {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== "*" || mon !== "*") return null;
  const every = (x: string) => (/^\*\/\d+$/.test(x) ? Number(x.slice(2)) : null);
  if (every(min) != null && hour === "*" && dow === "*") return { every: "minutes", n: every(min)! };
  if (min === "0" && every(hour) != null && dow === "*") return { every: "hours", n: every(hour)! };
  if (!/^\d+$/.test(min)) return null;
  const m = Number(min);
  if (m > 59) return null;
  if (hour === "*" && dow === "*") return { every: "hour", min: m };
  if (!/^\d+$/.test(hour)) return null;
  const h = Number(hour);
  if (h > 23) return null;
  if (dow === "*") return { every: "day", hour: h, min: m };
  if (dow === "1-5") return { every: "weekday", hour: h, min: m };
  if (/^[0-6]$/.test(dow)) return { every: "week", dow: Number(dow), hour: h, min: m };
  return null;
}

export const DOW_LABEL = DAY.map((d, i) => ({ v: i, label: `${d}요일` }));

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

/** draft 의 평평한 파일 목록에서 같은 것 — 동사는 scripts.source 바로 아래 *.ts 뿐 */
export function scriptNamesFromFiles(files: string[], source: string | undefined): string[] {
  if (!source) return [];
  const head = source.replace(/\/$/, "") + "/";
  return files
    .filter((f) => f.startsWith(head) && f.endsWith(".ts") && !f.slice(head.length).includes("/"))
    .map((f) => f.slice(head.length, -3));
}

const PROVIDER: Record<string, string> = { anthropic: "Claude", openai: "OpenAI", moonshot: "Kimi", google: "Gemini" };
export function providerLabel(provider: string): string {
  return PROVIDER[provider.toLowerCase()] ?? provider;
}

export interface RowItem { text: string; sub?: string }
export interface Row {
  key: "identity" | "verbs" | "when" | "dirs" | "talk" | "faces" | "links" | "missions" | "engine" | "needs" | "host" | "org" | "files";
  /** 왼쪽 질문 */
  q: string;
  items: RowItem[];
  /** 비었을 때 오른쪽에 놓을 문구 */
  empty: string;
  /** 누르면 펼쳐지는 스튜디오 섹션 (lib/sections.ts 의 key) */
  sec: string;
  /** 고급 — 접힌 묶음 아래 */
  advanced?: boolean;
}

export interface DescribeCtx {
  workspace: string;
  /** scripts.source 아래 동사 이름 — 설치본은 pkg-read 트리에서, draft 는 파일 목록에서 */
  scripts: string[];
  /** 이 패키지가 consumer 인 edges */
  edges: EdgeView[];
  /** 착지 에이전트 이름 (faces.ts landingAgent) */
  landing: string | null;
  /** 장부의 활성 하네스 이름 (Pkg.harness) */
  activeHarness: string | null;
  /** 설치 이름 → 표시 이름 */
  labelOf: (name: string) => string;
  /** 패키지의 파일 목록 — "기타 파일" 줄의 재료. 모르면 빈 배열 */
  files: string[];
  /** 동사 이름 → 짧은 서술(pkg-verbs). 있으면 서술을 크게, 이름을 작게 */
  verbLabels?: Record<string, string>;
  /** 이 패키지의 부품을 결재해 쓰는 설치본들(셸 nav 의 mounted_in) — 사이드바에서 그 밑으로 접히는 근거. 모르면 빈 배열 */
  mountedIn?: string[];
}

/**
 * 모든 선언 섹션이 줄 하나씩 갖는다 — 2층(고치기)으로 가는 문이 줄이므로, 줄이 없는 섹션은
 * 고칠 수 없다. `editing` 이면 빈 줄도 전부 보인다(누르면 거기서 만든다). 보기만 할 때는
 * 비어 있는 엔진·요구·고급 줄을 생략해 설명서를 짧게 둔다.
 */
export function describe(m: Manifest, ctx: DescribeCtx, opt: { editing?: boolean } = {}): Row[] {
  const editing = !!opt.editing;
  const rows: Row[] = [];

  rows.push({ key: "identity", q: "이름과 버전", sec: "identity", empty: "아직 없음", items: [{ text: m.name ?? "(이름 없음)", sub: m.version }] });

  rows.push({ key: "verbs", q: "시킬 수 있는 일", sec: "scripts", empty: "아직 없음", items: ctx.scripts.map((s) => (ctx.verbLabels?.[s] ? { text: ctx.verbLabels[s], sub: s } : { text: s })) });

  rows.push({
    key: "when", q: "스스로 움직이는 때", sec: "triggers", empty: "아직 없음 — 부르면 움직입니다",
    items: (m.triggers ?? []).map((t) =>
      t.when.cron != null
        ? { text: cronToKorean(t.when.cron) ?? t.when.cron, sub: t.when.tz }
        : { text: `${t.when.event ?? t.id} 이 생기면`, sub: undefined },
    ),
  });

  rows.push({
    key: "dirs", q: "손대는 폴더", sec: "services", empty: "아직 없음",
    items: [
      ...(ctx.workspace ? [{ text: "작업 폴더", sub: ctx.workspace }] : []),
      ...(m.services ?? []).filter((s) => s.dir != null).map((s) => ({ text: s.name, sub: s.dir })),
    ],
  });

  rows.push({
    key: "talk", q: "대화하는 곳", sec: "agents", empty: "대화 없음",
    items: [
      ...(ctx.landing ? [{ text: "이 화면" }] : []),
      ...(m.agents ?? []).filter((a) => a.name !== ctx.landing).map((a) => ({ text: a.name, sub: "보조" })),
    ],
  });

  // 사이드바 자리 — 접힐지는 기판이 결재를 보고 정한다. 여기서는 그 결과(어느 앱 밑인가)와 선언(숨김·최상위)만
  // 말하고, 기본 상태(최상위·결재 없음)는 줄을 늘리지 않는다
  const nav = m.shell?.nav ?? "auto";
  const mountedIn = ctx.mountedIn ?? [];
  const seat =
    nav === "never" ? { text: "사이드바에 숨김", sub: "상세와 직접 주소로 열림" }
    : nav === "always" ? { text: "사이드바 늘 최상위", sub: "부품을 쓰는 앱이 있어도" }
    : mountedIn.length ? { text: `${mountedIn.map(ctx.labelOf).join(", ")} 안에서 쓰임`, sub: "사이드바에서 그 밑으로 접힘" }
    : null;
  rows.push({
    key: "faces", q: "화면과 채널", sec: "surfaces", empty: "아직 없음",
    items: [
      ...(m.surfaces?.view ? [{ text: "화면", sub: m.surfaces.view.source }] : []),
      ...(m.surfaces?.components ? [{ text: "부품", sub: m.surfaces.components.source }] : []),
      ...(m.surfaces?.channels ?? []).map((c) => ({ text: c.name, sub: "채널" })),
      ...(seat ? [seat] : []),
    ],
  });

  rows.push({
    key: "links", q: "바깥 연결", sec: "edges", empty: "아직 없음",
    items: [
      ...(m.services ?? []).filter((s) => s.url != null || s.api != null).map((s) => ({ text: s.name, sub: s.url ?? s.api })),
      ...ctx.edges.map((e) => ({
        // raw 는 따로 말한다 — "빌렸다"와 "에이전트가 raw 로 만진다"는 고지가 갈라야 하는 두 사실이다
        text: e.mission
          ? `${ctx.labelOf(e.provider ?? e.ref)}에 일을 맡김`
          : `${ctx.labelOf(e.provider ?? e.ref)}의 도구를 빌려 씀${e.agent_access === "full" ? " (raw 도구까지)" : ""}`,
        sub: e.mission ?? e.tools?.join(", "),
      })),
    ],
  });

  rows.push({
    key: "missions", q: "맡길 수 있는 일", sec: "missions", empty: "아직 없음",
    items: (m.missions ?? []).map((x) => ({ text: x.name, sub: x.description })),
  });

  const active = (m.harness?.variants ?? []).find((v) => v.name === ctx.activeHarness) ?? m.harness?.variants?.[0];
  rows.push({
    key: "engine", q: "동작 엔진", sec: "harness", empty: "아직 없음",
    items: active?.llm?.provider ? [{ text: providerLabel(active.llm.provider), sub: undefined }] : [],
  });

  rows.push({
    key: "needs", q: "필요한 것", sec: "requires", empty: "없음",
    items: (m.requires?.binaries ?? []).map((b) => ({ text: b.name, sub: undefined })),
  });

  rows.push({ key: "host", q: "기판 기능 허용", sec: "host_methods", empty: "제한 없음 — 기판 기능을 전부 쓸 수 있습니다", advanced: true, items: (m.host_methods ?? []).map((x) => ({ text: x })) });
  rows.push({ key: "org", q: "조직 설정", sec: "org", empty: "없음", advanced: true, items: m.org ? [{ text: "있음" }] : [] });
  rows.push({ key: "files", q: "기타 파일", sec: "files", empty: "없음", advanced: true, items: unclaimedFiles(m, ctx.files).map((f) => ({ text: f })) });

  const optional = new Set<Row["key"]>(["engine", "needs", "host", "org", "files"]);
  return editing ? rows : rows.filter((r) => r.items.length || !optional.has(r.key));
}

// ── 한눈 요약 ────────────────────────────────────────────────────────────────
// "이 에이전트가 어떤 구조로 어떻게 구성되어 있고 무슨 일을 할 수 있나" 를 3초에 읽히게 하는
// 재료다. 목록을 다 읽어야 알 수 있던 것(화면이 있나 · 스스로 도나 · 몇 가지를 하나)을 칩
// 몇 개로 앞세운다. 칩은 그 섹션으로 데려가는 문이기도 하므로 sec 을 함께 낸다.

const CHANNEL: Record<string, string> = { slack: "슬랙", discord: "디스코드", telegram: "텔레그램", kakao: "카카오톡", line: "라인" };
export function channelLabel(name: string): string {
  return CHANNEL[name.toLowerCase()] ?? name;
}

/** agents[].scripts 는 글로브를 받는다(set-* 처럼). 실제 동사 이름에 맞춰 편 것 */
export function matchScripts(patterns: string[] | undefined, all: string[]): string[] {
  if (!patterns?.length) return [];
  const res = patterns.map((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").split("*").join(".*") + "$"));
  return all.filter((s) => res.some((r) => r.test(s)));
}

/** 자동 실행 한 줄이 실제로 무엇을 부르는가 — then 의 대상. **이름만** 낸다: "깨우기 · 실행" 같은
 *  동사는 화살표(→)가 이미 말하고 있어 글자만 늘렸다(2026-08-28) */
export function triggerTarget(t: { then?: { agent?: string; script?: string } }): string | null {
  if (t.then?.script) return t.then.script;
  if (t.then?.agent) return t.then.agent;
  return null;
}

/** 도우미 줄의 부제 — "기능 2" 는 무엇의 2인지 말하지 않았다 */
export function agentSub(a: { scripts?: string[]; dispatch?: string[]; dirs?: string[] }, allScripts: string[]): string | undefined {
  const parts = [
    matchScripts(a.scripts, allScripts).length ? `기능 ${matchScripts(a.scripts, allScripts).length}개` : null,
    a.dispatch?.length ? `도우미 ${a.dispatch.length}명` : null,
    a.dirs?.length ? `폴더 ${a.dirs.length}개` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}

export interface Fact { text: string; sec: string; title?: string }

/**
 * 머리의 요약 칩 — 흐름 순서다(어디서 만나나 → 언제 도나 → 몇 가지를 하나 → 누구와 무엇을 쓰나).
 * 없는 것은 칩을 내지 않는다: "없음" 칩이 늘어서면 있는 것이 묻힌다.
 */
export function facts(m: Manifest, ctx: { scripts: string[]; landing: string | null; edges: EdgeView[] }): Fact[] {
  const out: Fact[] = [];
  if (m.surfaces?.view) out.push({ text: "웹 화면", sec: "surfaces" });
  else if (ctx.landing) out.push({ text: "대화만", sec: "agents" });

  const chans = m.surfaces?.channels ?? [];
  if (chans.length) out.push({ text: chans.map((c) => channelLabel(c.name)).join("·"), sec: "surfaces" });

  const trg = m.triggers ?? [];
  if (trg.length) {
    const first = trg[0].when?.cron ? cronToKorean(trg[0].when.cron) : trg[0].when?.event ? `${trg[0].when.event} 이 생기면` : null;
    out.push({ text: first ? `${first} 자동${trg.length > 1 ? ` 외 ${trg.length - 1}` : ""}` : `자동 실행 ${trg.length}개`, sec: "triggers" });
  }

  if (ctx.scripts.length) out.push({ text: `기능 ${ctx.scripts.length}개`, sec: "scripts" });

  const helpers = (m.agents ?? []).filter((a) => a.name !== ctx.landing);
  if (helpers.length) out.push({ text: `도우미 ${helpers.length}명`, sec: "agents", title: helpers.map((a) => a.name).join(", ") });

  const dirs = (m.services ?? []).filter((s) => s.dir != null);
  if (dirs.length) out.push({ text: `폴더 ${dirs.length}개`, sec: "services", title: dirs.map((s) => s.dir).join(", ") });

  if (ctx.edges.length) out.push({ text: `다른 앱 ${new Set(ctx.edges.map((e) => e.provider ?? e.ref)).size}개`, sec: "edges" });
  if ((m.missions ?? []).length) out.push({ text: `빌려주는 일 ${m.missions!.length}개`, sec: "missions" });

  return out;
}

// ── 문장 ────────────────────────────────────────────────────────────────────
// 왼쪽 패널의 정본. 목록이 아니라 **에이전트가 자기를 소개하는 다섯 줄**이고, 밑줄 그은 낱말이
// 곧 고치는 문이다. 목록은 "무엇이 있나"만 말하고 "어떻게 움직이나"는 못 말한다 — 항목을 다
// 읽어도 구조가 안 잡히던 이유다(2026-08-28).
//
// **조사 규칙**: 값이 들어가는 자리 뒤에는 받침을 따지는 조사(로/으로 · 을/를 · 와/과 · 이/가)를
// 절대 두지 않는다. 값은 "슬랙"일 수도 "organizer"일 수도 있어 받침 판정이 성립하지 않는다
// (로마자는 한국어 발음이 따로다 — organizer 는 "오거나이저"로 끝나 받침이 없다). 그래서 값 뒤에는
//   ① 받침과 무관한 조사(에서 · 에 · 의 · 도), 또는
//   ② 고정 명사(엔진 · 도우미 · 폴더 · 일)
// 만 온다. "Claude 엔진으로", "organizer 도우미와", "memos 폴더에", "5가지 일을" — 조사가 붙는
// 말은 전부 이쪽이 고정어다.

/** 문장 속의 누를 수 있는 낱말 — 누르면 그 선언의 폼이 이 문장 아래로 펼쳐진다 */
export interface Tok {
  t: string;
  sec: string;
  item?: string | null;
  /** 낱말이 **값이 아니라 붙박이 이름**이다("성격과 역할"). 조사 규칙은 값에만 걸린다 —
   *  값은 "슬랙"일지 "organizer"일지 모르지만, 붙박이 이름은 내가 쓴 그 글자 그대로다 */
  fixed?: boolean;
}
/** 없는 것 — 문단 아래 점선 한 줄. "붙일 수 있다"를 말하는 자리다 */
export interface Add { sec: string; label: string }
export interface Para { key: string; parts: (string | Tok)[]; adds: Add[] }

const ENGINE_LABEL: Record<string, string> = { "claude-code": "Claude", codex: "Codex", pi: "Pi", kimi: "Kimi" };
export function engineLabel(name: string): string {
  return ENGINE_LABEL[name] ?? name;
}

/** 낱말들을 " · " 로 잇는다 — 값과 값 사이라 조사가 끼지 않는다 */
function join(toks: Tok[]): (string | Tok)[] {
  const out: (string | Tok)[] = [];
  toks.forEach((t, i) => { if (i) out.push(" · "); out.push(t); });
  return out;
}

/** 바깥 서비스가 닿는 곳 — 사람이 아는 것은 선언 이름이 아니라 이 호스트다.
 *  주소가 아니면(템플릿·환경변수) null 이고, 그때만 선언 이름으로 물러선다 */
function hostOf(url: string): string | null {
  try { return new URL(url).host || null; } catch { return null; }
}

export function sentences(m: Manifest, ctx: DescribeCtx): Para[] {
  const out: Para[] = [];

  // ① 어디서 만나고 언제 움직이나
  const doors: Tok[] = [];
  if (m.surfaces?.view) doors.push({ t: "웹 화면", sec: "surfaces", item: "view" });
  for (const c of m.surfaces?.channels ?? []) doors.push({ t: channelLabel(c.name), sec: "surfaces", item: `channel:${c.name}` });
  if (!doors.length && ctx.landing) doors.push({ t: "대화", sec: "agents", item: ctx.landing });
  const times: Tok[] = (m.triggers ?? []).map((t) => ({
    t: t.when?.cron ? (cronToKorean(t.when.cron) ?? t.when.cron) : `${t.when?.event ?? t.id}`,
    sec: "triggers",
    item: t.id,
  }));
  // 깨움이 대화의 문이 아니라 도우미를 직접 부르는 앱이 흔하다(아침 브리핑의 briefer). "알아서
  // 움직입니다" 는 그것을 감췄다 — 누가 깨는지가 이 문장에서 가장 알고 싶은 것이다(2026-08-28).
  // 깨우는 도우미가 하나로 정해질 때만 이름을 낸다. 여럿이거나 동사만 부르면 종전 문구로 물러선다
  const woken = [...new Set((m.triggers ?? []).map((t) => t.then?.agent).filter((a): a is string => !!a && a !== ctx.landing))];
  const wake: (string | Tok)[] = woken.length === 1
    ? ["에 ", { t: woken[0]!, sec: "agents", item: woken[0]! }, " 도우미를 깨웁니다."]
    : ["에 알아서 움직입니다."];
  const meetParts: (string | Tok)[] =
    doors.length && times.length ? [...join(doors), "에서 만나고, ", ...join(times), ...wake]
    : doors.length ? [...join(doors), "에서 만납니다."]
    : times.length ? [...join(times), ...wake]
    : ["아직 만날 곳이 없습니다."];
  out.push({
    key: "meet",
    parts: meetParts,
    adds: ([
      ...(m.surfaces?.view || (m.surfaces?.channels ?? []).length ? [] : [{ sec: "surfaces", label: "웹 화면이나 슬랙으로 만나기" }]),
      ...(times.length ? [] : [{ sec: "triggers", label: "정해진 때 알아서 움직이기" }]),
    ]),
  });

  // ①-a 사이드바에서의 자리 — 기본(최상위·결재 없음)은 말하지 않는다. 접혔거나 숨겼거나 못박았을 때만
  // 한 줄. "왜 사이드바에 없지"가 이 화면에서 가장 먼저 풀려야 할 물음이라서다. 낱말은 기본 정보(자리 선택)로 간다
  const seatNav = m.shell?.nav ?? "auto";
  const seatIn = ctx.mountedIn ?? [];
  const seatParts: (string | Tok)[] | null =
    seatNav === "never" ? [{ t: "사이드바", sec: "identity" }, "에는 숨겨져 있습니다 — 상세와 직접 주소로만 엽니다."]
    : seatNav === "always" ? [{ t: "사이드바", sec: "identity" }, "에 늘 최상위로 섭니다."]
    : seatIn.length ? [{ t: "사이드바", sec: "identity" }, `에서는 ${seatIn.map(ctx.labelOf).join(", ")} 밑에 접혀 있습니다.`]
    : null;
  if (seatParts) out.push({ key: "seat", parts: seatParts, adds: [] });

  // ② 누가 무엇을 하나
  // 엔진은 **하나**다. harness.variants 는 후보 목록이고 실제로 도는 것은 그중 하나뿐이라,
  // 넷을 나열하면 "넷으로 동시에 돈다" 는 틀린 말이 된다. 게다가 낱말 넷이 전부 같은 카드를
  // 여는 문이어서, 밑줄 넷이 서로 다른 목적지처럼 보였다(2026-08-28). 후보는 그 카드가 보여준다.
  const variants = m.harness?.variants ?? [];
  const activeName = ctx.activeHarness && variants.some((v) => v.name === ctx.activeHarness) ? ctx.activeHarness : variants[0]?.name;
  const engines: Tok[] = activeName ? [{ t: engineLabel(activeName), sec: "harness", item: activeName }] : [];
  const helpers: Tok[] = (m.agents ?? []).filter((a) => a.name !== ctx.landing).map((a) => ({ t: a.name, sec: "agents", item: a.name }));
  const verb: Tok | null = ctx.scripts.length ? { t: `${ctx.scripts.length}가지 일`, sec: "scripts" } : null;
  const doParts: (string | Tok)[] = [];
  if (engines.length) doParts.push(...join(engines), (verb || helpers.length) ? " 엔진으로 돌아가고, " : " 엔진으로 돌아갑니다.");
  if (helpers.length) doParts.push(...join(helpers), verb ? " 도우미와 함께 " : " 도우미를 둡니다.");
  if (verb) doParts.push(verb, "을 합니다.");
  if (!doParts.length) doParts.push("아직 할 수 있는 일이 없습니다.");
  out.push({
    key: "do",
    parts: doParts,
    adds: ([
      ...(verb ? [] : [{ sec: "scripts", label: "시키면 하는 일 만들기" }]),
      ...(engines.length ? [] : [{ sec: "harness", label: "돌릴 엔진 고르기" }]),
      ...(helpers.length || !verb ? [] : [{ sec: "agents", label: "일 나눌 도우미 두기" }]),
    ]),
  });

  // ③ 자기 자신 — 말투와 역할. 이 자리에 "성격과 역할은 따로 글로 적어 두었습니다" 같은
  // **파일 정리 상태**를 적어 두었었다: 사람에게 아무 쓸모가 없는 문장이다. 성격 글은 요약할
  // 것이 아니라 **그 글 자체가 답**이라, 화면이 첫 줄을 그대로 낸다(AgentPanel personaLead).

  // ④ 무엇을 쓰나 · 주고받나
  // 폴더와 바깥 서비스는 **이름이 아니라 실체**로 부른다. services[].name 은 도구 이름을 짓는
  // 손잡이(dir__memos__read)이지 사람이 아는 것이 아니다 — "memos" 는 매니페스트 안에서만 뜻이
  // 있고, 사람이 아는 것은 파인더에서 여는 그 폴더(~/Relay/memo)와 닿는 그 서버다(2026-08-28).
  const dirs: Tok[] = (m.services ?? []).filter((s) => s.dir != null).map((s) => ({ t: s.dir!, sec: "services", item: s.name }));
  const outward: Tok[] = (m.services ?? [])
    .filter((s) => s.url != null || s.api != null)
    .map((s) => ({ t: hostOf(s.url ?? s.api!) ?? s.name, sec: "services", item: s.name }));
  const seen = new Set<string>();
  const providers: Tok[] = [];
  for (const e of ctx.edges) {
    const name = e.provider ?? e.ref;
    if (seen.has(name)) continue;
    seen.add(name);
    providers.push({ t: ctx.labelOf(name), sec: "edges", item: name });
  }
  const useParts: (string | Tok)[] = [];
  if (dirs.length) useParts.push(...join(dirs), " 폴더를 읽고 씁니다. ");
  if (outward.length) useParts.push(...join(outward), "에 연결합니다. ");
  if (providers.length) useParts.push(...join(providers), "의 기능을 빌려 씁니다. ");
  if ((m.missions ?? []).length) useParts.push({ t: `${m.missions!.length}가지 일`, sec: "missions" }, "을 다른 앱에 빌려줍니다.");
  if (!useParts.length) useParts.push("쓰는 폴더나 연결이 없습니다.");
  out.push({
    key: "use",
    parts: useParts,
    adds: ([
      ...(dirs.length ? [] : [{ sec: "services", label: "읽고 쓸 폴더 두기" }]),
      ...(providers.length ? [] : [{ sec: "edges", label: "다른 앱의 기능 빌려오기" }]),
      ...((m.missions ?? []).length ? [] : [{ sec: "missions", label: "다른 앱에 일 빌려주기" }]),
    ]),
  });

  return out;
}

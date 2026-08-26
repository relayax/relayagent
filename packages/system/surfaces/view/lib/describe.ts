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
  if (!/^\d+$/.test(min) || !/^\d+$/.test(hour)) return null;
  const m = Number(min), h = Number(hour);
  if (m > 59 || h > 23) return null;
  const at = hourWord(h, m);
  if (dow === "*") return `매일 ${at}`;
  if (dow === "1-5") return `평일 ${at}`;
  if (/^[0-6]$/.test(dow)) return `매주 ${DAY[Number(dow)]}요일 ${at}`;
  return null;
}

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

  rows.push({
    key: "faces", q: "화면과 채널", sec: "surfaces", empty: "아직 없음",
    items: [
      ...(m.surfaces?.view ? [{ text: "화면", sub: m.surfaces.view.source }] : []),
      ...(m.surfaces?.components ? [{ text: "끼울 부품", sub: m.surfaces.components.source }] : []),
      ...(m.surfaces?.channels ?? []).map((c) => ({ text: c.name, sub: "채널" })),
    ],
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

  rows.push({ key: "host", q: "기판 브리지 캡", sec: "host_methods", empty: "전체 허용", advanced: true, items: (m.host_methods ?? []).map((x) => ({ text: x })) });
  rows.push({ key: "org", q: "조직 설정", sec: "org", empty: "없음", advanced: true, items: m.org ? [{ text: "있음" }] : [] });
  rows.push({ key: "files", q: "기타 파일", sec: "files", empty: "없음", advanced: true, items: unclaimedFiles(m, ctx.files).map((f) => ({ text: f })) });

  const optional = new Set<Row["key"]>(["engine", "needs", "host", "org", "files"]);
  return editing ? rows : rows.filter((r) => r.items.length || !optional.has(r.key));
}

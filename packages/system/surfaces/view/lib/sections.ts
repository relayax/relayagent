import type { Manifest } from "./types";

// 선언 트리의 정본. 좌측 패널은 파일 탐색기가 아니라 relay.yaml 선언 트리다 —
// 매니페스트에서 도달 불가능한 파일은 존재하지 않는 것과 같다는 원칙의 UI 형태.
// 트리는 섹션과 항목 2단까지만 그리고, 항목이 가리키는 파일은 캔버스에서 카드로 연다.

export interface SectionItem {
  id: string;
  title: string;
  sub?: string;
  /** 이 선언이 가리키는 실재 파일 (draft 파일 목록과 교집합) */
  files: string[];
}

export interface SectionDef {
  key: string;
  label: string;
  /** relay.manifest.yaml 의 최상위 키. 스키마 description 조회와 YAML 조각 표시에 쓴다 */
  yamlKey?: string;
  hint: string;
  declared(m: Manifest): boolean;
  items?(m: Manifest, files: string[]): SectionItem[];
  /** 섹션 자체가 가리키는 파일 (항목 밖) */
  files?(m: Manifest, files: string[]): string[];
}

const under = (files: string[], dir?: string | null): string[] =>
  dir ? files.filter((f) => f === dir || f.startsWith(dir.replace(/\/$/, "") + "/")) : [];

const exist = (files: string[], ...paths: (string | undefined | null)[]): string[] =>
  paths.filter((p): p is string => !!p && files.includes(p));

export const SECTIONS: SectionDef[] = [
  {
    key: "identity",
    label: "신분",
    hint: "이름, 버전, 표시 이름, 설명, 아이콘. 카드와 지도, 설치 화면이 이 문장을 그대로 쓴다.",
    declared: () => true,
    files: (m, files) => exist(files, "relay.yaml", m.icon),
  },
  {
    key: "requires",
    label: "requires",
    yamlKey: "requires",
    hint: "호스트 환경 요구 = 설치 관문. OS, PATH 바이너리, 데스크톱 앱. 설치가 실체를 판정해 미충족이면 fail-loud.",
    declared: (m) => !!m.requires,
  },
  {
    key: "surfaces",
    label: "surfaces",
    yamlKey: "surfaces",
    hint: "패키지가 세상에 내미는 창구. view 화면, components 번들 수출, channels 외부 대화 어댑터. 직접 대화는 선언이 아니라 agents[] 에서 도출된다.",
    declared: (m) => !!m.surfaces,
    items: (m, files) => {
      const out: SectionItem[] = [];
      if (m.surfaces?.view) {
        out.push({
          id: "view",
          title: "view",
          sub: m.surfaces.view.out ? `${m.surfaces.view.source} (빌드: ${m.surfaces.view.out})` : `${m.surfaces.view.source} (정적)`,
          files: under(files, m.surfaces.view.source),
        });
      }
      for (const c of m.surfaces?.channels ?? []) {
        out.push({ id: `channel:${c.name}`, title: c.name, sub: "채널 어댑터", files: under(files, c.source) });
      }
      return out;
    },
  },
  {
    key: "harness",
    label: "harness",
    yamlKey: "harness",
    hint: "동봉한 실행 어댑터 후보들. 선언 = 후보 목록(BOM), 활성 선택 = 장부. 에이전트 패키지는 최소 1개.",
    declared: (m) => !!m.harness,
    items: (m, files) =>
      (m.harness?.variants ?? []).map((v) => ({
        id: v.name,
        title: v.name,
        sub: v.llm?.provider ? `llm: ${v.llm.provider}` : "어댑터 기본 자격",
        files: under(files, v.source),
      })),
  },
  {
    key: "hooks",
    label: "hooks",
    yamlKey: "hooks",
    hint: "세션 담장. deny 경로는 세션의 도구 호출이 닿지 못한다. 기판 홈(~/.relay)은 선언과 무관하게 항상 막힌다.",
    declared: (m) => !!m.hooks,
  },
  {
    key: "agents",
    label: "agents",
    yamlKey: "agents",
    hint: "착지점 = 패키지 짧은 이름과 같은 에이전트. 페르소나, 스킬, 커맨드, 서브에이전트 위임, 동사 scope.",
    declared: (m) => !!m.agents?.length,
    items: (m, files) =>
      (m.agents ?? []).map((a) => ({
        id: a.name,
        title: a.name,
        sub: [a.dispatch?.length ? `dispatch ${a.dispatch.join(",")}` : null, a.scripts?.length ? `scope ${a.scripts.join(" ")}` : null]
          .filter(Boolean)
          .join(" · ") || undefined,
        files: [...exist(files, a.persona), ...under(files, a.skills), ...under(files, a.commands)],
      })),
  },
  {
    key: "scripts",
    label: "scripts",
    yamlKey: "scripts",
    hint: "동사 디렉토리. <이름>.ts = 기본 수출 async 함수 (input, ctx) => 결과 JSON. 에이전트 scope 가 여기를 가리킨다.",
    declared: (m) => !!m.scripts,
    items: (m, files) =>
      under(files, m.scripts?.source)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => ({
          id: f.slice((m.scripts?.source ?? "").length + 1).replace(/\.ts$/, ""),
          title: f.split("/").pop()!.replace(/\.ts$/, ""),
          sub: "동사",
          files: [f],
        })),
  },
  {
    key: "services",
    label: "services",
    yamlKey: "services",
    hint: "패키지의 자원. source 자기 몸(프로세스·컨테이너), url 원격 MCP 문, api 원격 REST 베이스, dir 폴더. 자격(auth)은 밖으로 나가는 두 형에 앉고 좌표는 vault 의 <패키지>/<서비스> 다.",
    declared: (m) => !!m.services?.length,
    items: (m, files) =>
      (m.services ?? []).map((s) => ({
        id: s.name,
        title: s.name,
        sub: s.url ? "원격 MCP" : s.api ? `REST ${s.api}` : s.dir ? `폴더 ${s.dir}` : s.dockerfile ? "컨테이너" : "프로세스",
        files: under(files, s.source),
      })),
  },
  {
    key: "triggers",
    label: "triggers",
    yamlKey: "triggers",
    hint: "시간(cron)과 사건(event)이 세션이나 동사를 깨운다. delivery 를 선언하면 결과가 채널 대화로 배달된다.",
    declared: (m) => !!m.triggers?.length,
    items: (m) =>
      (m.triggers ?? []).map((t) => ({
        id: t.id,
        title: t.id,
        sub: t.when?.cron ? `cron ${t.when.cron}` : t.when?.event ? `event ${t.when.event}` : undefined,
        files: [],
      })),
  },
  {
    key: "missions",
    label: "missions",
    yamlKey: "missions",
    hint: "a2a 수신 선언. 다른 패키지가 이 미션으로 위임을 보낼 수 있다.",
    declared: (m) => !!m.missions?.length,
    items: (m) => (m.missions ?? []).map((x) => ({ id: x.name, title: x.name, sub: x.description, files: [] })),
  },
  {
    key: "edges",
    label: "edges",
    yamlKey: "edges",
    hint: "남의 것 소비 선언. 선언은 신청, 활성화는 결재 — 결재는 콘솔 그래프에서 한다.",
    declared: (m) => !!m.edges?.length,
    items: (m) =>
      (m.edges ?? []).map((e, i) => ({
        id: String(i),
        title: e.provider,
        sub: e.mission ? `mission ${e.mission}` : e.tools?.length ? `tools ${e.tools.join(",")}` : undefined,
        files: [],
      })),
  },
  {
    key: "org",
    label: "org",
    yamlKey: "org",
    hint: "org 기판이 호스팅할 때만 읽는 확장. 1인 기판에서는 무시된다.",
    declared: (m) => !!m.org,
  },
];

/** 어떤 선언에도 잡히지 않은 파일 — 매니페스트에서 도달 불가능하다는 경고 신호이기도 하다 */
export function unclaimedFiles(m: Manifest, files: string[]): string[] {
  const claimed = new Set<string>();
  for (const s of SECTIONS) {
    for (const f of s.files?.(m, files) ?? []) claimed.add(f);
    for (const it of s.items?.(m, files) ?? []) for (const f of it.files) claimed.add(f);
  }
  claimed.add("relay.yaml");
  return files.filter((f) => !claimed.has(f) && !f.endsWith("/.gitkeep"));
}

export function sectionChangeCount(s: SectionDef, m: Manifest, files: string[], changed: Set<string>): number {
  let n = 0;
  for (const f of s.files?.(m, files) ?? []) if (changed.has(f)) n++;
  for (const it of s.items?.(m, files) ?? []) for (const f of it.files) if (changed.has(f)) n++;
  if (s.key === "identity" && changed.has("relay.yaml")) n = Math.max(n, 1);
  return n;
}

/** relay.manifest.yaml 의 description 을 도움말로 승격 — 문서를 따로 쓰지 않는다 */
export function schemaHint(schema: any, yamlKey?: string): string | null {
  if (!schema || !yamlKey) return null;
  const d = schema?.properties?.[yamlKey]?.description;
  return typeof d === "string" ? d : null;
}

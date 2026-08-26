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

/**
 * 재료 — 이 선언이 무엇으로 만들어졌는가. 오른쪽 결과면의 **모양을 정하는 축**이다.
 *
 * 노션은 문서를, Figma 는 그림을, n8n 은 배선을 다룬다. 그 도구들의 손맛이 좋은 이유의 절반은
 * 한 가지 재료만 다루기 때문이고, relay.yaml 의 어휘에는 그 재료가 전부 섞여 있다. 하나의 UX 로
 * 통일하려 하면 전부 어중간해지므로, 재료를 선언에 붙여 결과면을 갈라 준다.
 *   그림 = 결과물이 곧 화면 (view · components)      → 프레임·마운트 미리보기
 *   배선 = 관계가 실체 (services · edges · missions)  → 노드 그래프
 *   시간 = 사건이 실체 (triggers)                     → 격자·다음 발화·지금 한 번
 *   말   = 사람이 읽는 글 (agents)                    → 시연 대화
 *   동사 = 코드 (scripts)                             → 입력·실행·영수증
 *   계약 = 설정 (identity · requires · harness · …)   → 이 문장이 되는 화면들
 */
export type Material = "그림" | "배선" | "시간" | "말" | "동사" | "계약";

export interface SectionDef {
  key: string;
  /** 사람이 읽는 이름 — 팔레트(lib/create.ts)와 같은 말투다. 문법 키는 yamlKey 로 작게 병기한다.
   *  종전에는 트리가 문법 키(agents, edges …)를 그대로 썼고 팔레트는 "말 상대 하나" 라고 불러,
   *  같은 것을 만들 때와 찾을 때 다른 이름으로 불렀다 */
  label: string;
  /** 고급 — 개인 기판에서 거의 손대지 않는 선언. 트리가 접어 둔다(선언돼 있으면 펼친다) */
  advanced?: boolean;
  material: Material;
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
    label: "기본 정보",
    material: "계약",
    hint: "이름, 버전, 표시 이름, 설명, 아이콘. 카드와 지도, 설치 화면이 이 문장을 그대로 쓴다.",
    declared: () => true,
    files: (m, files) => exist(files, "relay.yaml", m.icon),
  },
  {
    key: "requires",
    label: "설치 요구",
    material: "계약",
    yamlKey: "requires",
    hint: "호스트 환경 요구 = 설치 관문. OS, PATH 바이너리, 데스크톱 앱. 설치가 실체를 판정해 미충족이면 fail-loud.",
    declared: (m) => !!m.requires,
  },
  {
    key: "surfaces",
    label: "화면과 창구",
    material: "그림",
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
      // components 는 스키마·런타임·import map 이 전부 서 있는데도 이 목록에 없었다. 트리에
      // 노드가 없으면 파일이 "기타 파일" 로 떨어져, 선언한 것이 미아처럼 보인다
      if (m.surfaces?.components) {
        const c = m.surfaces.components;
        out.push({
          id: "components",
          title: "components",
          sub: c.out ? `${c.source} (빌드: ${c.out})` : `${c.source} (손저작 ESM)`,
          files: under(files, c.source),
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
    label: "실행 도구",
    material: "계약",
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
    key: "agents",
    label: "대화 상대",
    material: "말",
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
    label: "기능",
    material: "동사",
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
    label: "자원",
    material: "배선",
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
    label: "깨움",
    material: "시간",
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
    label: "맡길 수 있는 일",
    material: "배선",
    yamlKey: "missions",
    hint: "a2a 수신 선언. 다른 패키지가 이 미션으로 위임을 보낼 수 있다.",
    declared: (m) => !!m.missions?.length,
    items: (m) => (m.missions ?? []).map((x) => ({ id: x.name, title: x.name, sub: x.description, files: [] })),
  },
  {
    key: "edges",
    label: "빌려 쓰는 것",
    material: "배선",
    yamlKey: "edges",
    hint: "남의 것 소비 선언. 선언은 신청, 활성화는 결재 — 결재는 콘솔 그래프에서 한다.",
    declared: (m) => !!m.edges?.length,
    items: (m) =>
      (m.edges ?? []).map((e, i) => ({
        id: String(i),
        title: e.provider,
        sub: e.mission ? `mission ${e.mission}` : e.components ? "components 마운트" : e.tools?.length ? `tools ${e.tools.join(",")}` : undefined,
        files: [],
      })),
  },
  {
    key: "host_methods",
    label: "기판 브리지 캡",
    advanced: true,
    material: "계약",
    yamlKey: "host_methods",
    hint: "이 패키지의 동사가 부를 수 있는 host.* 의 캡. 미선언 = 전체이고, 선언하면 목록 밖은 거부된다. 고지서에 실린다.",
    declared: (m) => !!m.host_methods?.length,
    items: (m) => (m.host_methods ?? []).map((x) => ({ id: x, title: x, sub: "허용", files: [] })),
  },
  {
    key: "org",
    label: "조직 설정",
    advanced: true,
    material: "계약",
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

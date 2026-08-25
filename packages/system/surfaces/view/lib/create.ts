import type { Document } from "yaml";
import type { Manifest } from "./types";

// 만들 수 있는 것의 **정본 목록**.
//
// 종전에는 이 지식이 섹션 랜딩마다 인라인으로 흩어져 있었다(11군데). 그래서 두 가지가 동시에
// 참이었다: ① 저작자는 harness 섹션에 들어가 드롭다운을 열어야 "후보를 더 붙일 수 있다"는 걸
// 알았고 ② 같은 것을 두 자리에서 만들면 스캐폴드가 갈라질 자리가 생겼다.
//
// 트리는 문법의 어휘를 가르친다고 선언해 두었지만 실제로 가르친 것은 최상위 섹션 이름 12개뿐
// 이었다 — 하위 항목은 **선언된 뒤에야** 트리에 생기므로, components 는 그 존재를 이미 아는
// 사람에게만 보였다. 팔레트는 그 구멍을 메우는 자리이고, 이 파일은 팔레트와 섹션이 함께 읽는
// 한 벌의 정의다.
//
// 이름은 문법이 아니라 **얻는 것**으로 쓴다. "surfaces.components" 는 그것을 이미 아는 사람에게만
// 뜻이 있고, "다른 앱 화면에 끼울 부품" 은 처음 보는 사람에게도 뜻이 있다. 문법 좌표는 옆에 작게 단다.

export interface CreateCtx {
  manifest: Manifest;
  files: string[];
  apply(mutate: (doc: Document) => void): Promise<void>;
  createFile(path: string, content: string): Promise<void>;
  seedHarness(source: string, entry: string): Promise<void>;
}

/** 만든 뒤 어디로 데려갈 것인가 + 무엇이 생겼는가 */
export interface Made {
  sec: string;
  item?: string | null;
  file?: string | null;
  /** 영수증 한 줄 — 선언과 파일 중 무엇이 생겼는지 */
  receipt: string;
}

export interface NeedsSpec {
  kind: "slug" | "text" | "choice";
  label: string;
  placeholder?: string;
  /** choice 형의 남은 선택지. 빈 배열이면 팔레트가 그 줄을 "다 붙였음" 으로 잠근다 */
  choices?(m: Manifest, files: string[]): string[];
}

export interface Creatable {
  id: string;
  group: string;
  /** 얻는 것 */
  label: string;
  /** 문법 좌표 — 작게 병기한다 */
  yaml: string;
  detail: string;
  /** 이미 있는 것 — 숨기지 않고 흐리게 둔다. 숨기면 어휘가 다시 보이지 않는다 */
  present(m: Manifest, files: string[]): number;
  /** 하나뿐인 선언(있으면 더 못 만든다) */
  once?: boolean;
  needs?: NeedsSpec;
  /** 두 번째 칸 — 하나로는 만들 수 없는 것이 있다. 위임은 "누구에게" 와 "무슨 일" 이 둘 다
   *  있어야 성립하고(문법도 빈 미션을 거부한다), 한쪽만 받아 빈 값을 앉히면 만들자마자 판정에
   *  걸린다 — 만드는 맛의 정반대다 */
  needs2?: NeedsSpec;
  make(ctx: CreateCtx, input: string, second?: string): Promise<Made>;
}

export const GROUPS = ["화면", "대화", "기능", "자원", "깨움", "주고받기", "관문"] as const;

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export function slugOk(v: string): boolean {
  return SLUG.test(v.trim());
}

const landing = (m: Manifest): string => (m.agents ?? [])[0]?.name ?? "agent";

/**
 * 목록에 하나 더 놓는다.
 *
 * `doc.addIn(["services"], {...})` 를 그대로 쓰면 **목록이 아직 없을 때** 첫 항목이 배열이 아니라
 * 맵으로 앉는다(yaml 의 addIn 은 없는 경로를 값의 모양대로 만든다: 객체를 주면 맵을 만든다).
 * 결과는 `services: {name: …}` — 판정이 "object is not iterable" 로 죽고, 그 실패는 만든
 * 사람에게 "방금 만든 것 때문" 으로 읽히지 않는다. 새 패키지의 **첫 서비스·트리거·미션·edge·
 * 채널** 이 전부 이 자리를 지나므로 가장 흔한 경로가 가장 조용히 깨져 있었다.
 */
export function push(d: Document, path: (string | number)[], value: unknown): void {
  if (d.getIn(path) == null) d.setIn(path, [value]);
  else d.addIn(path, value);
}

// ── 스캐폴드 ────────────────────────────────────────────────────────────────
// 만든 것이 곧바로 결과면에 뜨려면 선언만으로는 모자라다. 빈 선언은 "만들었는데 아무 일도
// 일어나지 않는" 자리를 만들고, 그게 만드는 맛을 죽인다. 그래서 최소 실체를 같이 앉힌다.

const viewDoc = (m: Manifest): string =>
  `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${m.display_name ?? "화면"}</title>
<style>
  body { margin: 0; padding: 32px; font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", sans-serif; color: #16181b; background: #f5f6f7; }
  main { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #e6e9ec; border-radius: 12px; padding: 24px 26px; }
  h1 { margin: 0 0 6px; font-size: 19px; }
  p { margin: 0; color: #5c6570; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>${m.display_name ?? "화면"}</h1>
  <p>${m.description ?? "이 파일을 고치면 옆 미리보기가 곧바로 따라옵니다."}</p>
</main>
</body>
</html>
`;

const componentDoc = `// 자립 번들의 계약은 수출 하나다 — 소비자는 이 함수만 부른다.
// 스타일도 여기서 심는다: 옆에 CSS 파일로 내면 소비자가 설치 이름이 박힌 주소를 조립해야 하고,
// 같은 패키지가 다른 이름으로 서는 순간 깨진다.
export function mount(el, props = {}) {
  const box = document.createElement("div");
  box.style.cssText = "font:14px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;padding:14px;border-radius:10px;background:#f5f6f7;color:#16181b";
  box.textContent = props.title ?? "안녕하세요";
  el.appendChild(box);
  return { unmount() { box.remove(); } };
}
`;

const personaDoc = (n: string): string => `당신은 ${n}입니다.

# 역할

# 소통

# 경계
`;

const verbDoc = `export default async function (input: any, ctx: any) {
  return { ok: true, input };
}
`;

// ── 목록 ────────────────────────────────────────────────────────────────────

export const CREATABLES: Creatable[] = [
  {
    id: "view",
    group: "화면",
    label: "이 앱의 화면",
    yaml: "surfaces.view",
    detail: "사람이 여는 페이지. 만들면 옆 미리보기에 곧바로 뜨고, 고치면 따라옵니다.",
    once: true,
    present: (m) => (m.surfaces?.view ? 1 : 0),
    async make(ctx) {
      await ctx.apply((d) => d.setIn(["surfaces", "view"], { source: "surfaces/view" }));
      await ctx.createFile("surfaces/view/index.html", viewDoc(ctx.manifest));
      return { sec: "surfaces", item: "view", receipt: "화면을 만들었습니다 — surfaces.view 선언 + surfaces/view/index.html" };
    },
  },
  {
    id: "components",
    group: "화면",
    label: "다른 앱 화면에 끼울 부품",
    yaml: "surfaces.components",
    detail: "자립 번들 하나. 계약은 수출 하나(mount)뿐이라 소비자에게 프레임워크를 요구하지 않습니다.",
    once: true,
    present: (m) => (m.surfaces?.components ? 1 : 0),
    async make(ctx) {
      await ctx.apply((d) => d.setIn(["surfaces", "components"], { source: "surfaces/components" }));
      await ctx.createFile("surfaces/components/index.js", componentDoc);
      return { sec: "surfaces", item: "components", receipt: "부품을 만들었습니다 — surfaces.components 선언 + surfaces/components/index.js" };
    },
  },
  {
    id: "agent",
    group: "대화",
    label: "말 상대 하나",
    yaml: "agents[]",
    detail: "페르소나를 가진 에이전트. 짧은 이름과 같은 이름이 이 앱의 착지점입니다.",
    needs: { kind: "slug", label: "에이전트 이름", placeholder: "diary" },
    present: (m) => (m.agents ?? []).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["agents"], { name: n, persona: `agents/${n}/AGENT.md`, greeting: "무엇을 도와드릴까요?" }));
      await ctx.createFile(`agents/${n}/AGENT.md`, personaDoc(n));
      return { sec: "agents", item: n, receipt: `에이전트 ${n} 을 만들었습니다 — agents[] 선언 + agents/${n}/AGENT.md` };
    },
  },
  {
    id: "skill",
    group: "대화",
    label: "에이전트가 펼쳐 읽을 스킬",
    yaml: "agents[].skills",
    detail: "필요할 때만 읽히는 문서 묶음. 페르소나에 다 적는 대신 이쪽으로 덜어냅니다.",
    needs: { kind: "choice", label: "누구의 스킬", choices: (m) => (m.agents ?? []).map((a) => a.name) },
    present: (m, files) => (m.agents ?? []).filter((a) => a.skills && files.some((f) => f.startsWith(a.skills + "/"))).length,
    async make(ctx, agentName) {
      const idx = (ctx.manifest.agents ?? []).findIndex((a) => a.name === agentName);
      if (idx < 0) throw new Error(`없는 에이전트: ${agentName}`);
      const dir = ctx.manifest.agents?.[idx]?.skills ?? `agents/${agentName}/skills`;
      await ctx.apply((d) => d.setIn(["agents", idx, "skills"], dir));
      const file = `${dir}/new-skill/SKILL.md`;
      await ctx.createFile(file, `---\nname: new-skill\ndescription: 무엇을 하는 스킬인지 한 줄\n---\n\n# new-skill\n`);
      return { sec: "agents", item: agentName, file, receipt: `${agentName} 에게 스킬 자리를 만들었습니다 — ${file}` };
    },
  },
  {
    id: "channel",
    group: "대화",
    label: "바깥 대화 창구 (디스코드·슬랙 등)",
    yaml: "surfaces.channels[]",
    detail: "외부 표면을 잇는 상주 어댑터. 자격의 형태를 선언하면 연결 화면이 그대로 그려집니다.",
    needs: { kind: "slug", label: "채널 이름", placeholder: "discord" },
    present: (m) => (m.surfaces?.channels ?? []).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["surfaces", "channels"], { name: n, source: `channels/${n}`, entry: "index.ts" }));
      await ctx.createFile(`channels/${n}/index.ts`, `// ${n} 채널 어댑터 — 계약은 relay.manifest.yaml surfaces.channels 참조\n`);
      return { sec: "surfaces", item: `channel:${n}`, receipt: `채널 ${n} 을 만들었습니다 — surfaces.channels[] 선언 + channels/${n}/index.ts` };
    },
  },
  {
    id: "script",
    group: "기능",
    label: "부를 수 있는 기능 하나",
    yaml: "scripts",
    detail: "세션도 화면도 시계도 부를 수 있는 동사. 만들고 나서 옆에서 바로 돌려볼 수 있습니다.",
    needs: { kind: "slug", label: "동사 이름", placeholder: "report-weekly" },
    present: (m, files) => (m.scripts?.source ? files.filter((f) => f.startsWith(m.scripts!.source + "/") && f.endsWith(".ts")).length : 0),
    async make(ctx, n) {
      const src = ctx.manifest.scripts?.source ?? "scripts";
      if (!ctx.manifest.scripts) await ctx.apply((d) => d.setIn(["scripts"], { source: src }));
      const file = `${src}/${n}.ts`;
      await ctx.createFile(file, verbDoc);
      return { sec: "scripts", item: n, file, receipt: `동사 ${n} 을 만들었습니다 — ${file}` };
    },
  },
  {
    id: "harness",
    group: "기능",
    label: "이 앱을 돌릴 다른 도구",
    yaml: "harness.variants[]",
    detail: "claude-code 말고도 codex·pi·kimi 로 돌 수 있습니다. 선언은 후보 목록이고 활성 선택은 장부입니다.",
    needs: {
      kind: "choice",
      label: "어떤 도구",
      choices: (m) => {
        const have = new Set((m.harness?.variants ?? []).map((v) => v.name));
        return ["claude-code", "codex", "pi", "kimi"].filter((t) => !have.has(t));
      },
    },
    present: (m) => (m.harness?.variants ?? []).length,
    async make(ctx, tpl) {
      await ctx.apply((d) => push(d, ["harness", "variants"], { name: tpl, source: `harness/${tpl}`, entry: "run" }));
      await ctx.seedHarness(`harness/${tpl}`, "run");
      return { sec: "harness", item: tpl, receipt: `${tpl} 하네스 후보를 붙였습니다 — harness/${tpl} 템플릿 복사됨` };
    },
  },
  {
    id: "service-process",
    group: "자원",
    label: "직접 돌리는 프로그램",
    yaml: "services[] · source",
    detail: "이 앱이 띄우는 상주 프로세스. 기판이 스폰하고 살려 둡니다.",
    needs: { kind: "slug", label: "서비스 이름", placeholder: "indexer" },
    present: (m) => (m.services ?? []).filter((s) => s.source && !s.dockerfile).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["services"], { name: n, source: `services/${n}`, entry: "index.ts" }));
      await ctx.createFile(`services/${n}/index.ts`, `console.log("${n} 서비스 기동");\nsetInterval(() => {}, 60000);\n`);
      return { sec: "services", item: n, receipt: `서비스 ${n} 을 만들었습니다 — services/${n}/index.ts` };
    },
  },
  {
    id: "service-container",
    group: "자원",
    label: "컨테이너로 돌리는 것",
    yaml: "services[] · dockerfile",
    detail: "Dockerfile 로 굽는 몸. 프로세스 형과 같은 자리에 서고 주소도 같은 문법입니다.",
    needs: { kind: "slug", label: "서비스 이름", placeholder: "db" },
    present: (m) => (m.services ?? []).filter((s) => s.dockerfile).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["services"], { name: n, source: `services/${n}`, dockerfile: "Dockerfile" }));
      await ctx.createFile(`services/${n}/Dockerfile`, `FROM alpine\nCMD ["sleep", "infinity"]\n`);
      return { sec: "services", item: n, receipt: `컨테이너 서비스 ${n} 을 만들었습니다 — services/${n}/Dockerfile` };
    },
  },
  {
    id: "service-url",
    group: "자원",
    label: "원격 MCP 문",
    yaml: "services[] · url",
    detail: "밖으로 나가는 문. 자격은 vault 에 앉고 매니페스트에는 형태만 남습니다.",
    needs: { kind: "slug", label: "서비스 이름", placeholder: "notion" },
    present: (m) => (m.services ?? []).filter((s) => s.url).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["services"], { name: n, url: "https://example.com/mcp", auth: { kind: "none" } }));
      return { sec: "services", item: n, receipt: `원격 MCP ${n} 을 선언했습니다 — url 과 auth.kind 를 채우세요` };
    },
  },
  {
    id: "service-dir",
    group: "자원",
    label: "쓸 수 있는 폴더",
    yaml: "services[] · dir",
    detail: "세션이 딛지 않고 도구로 부르는 폴더. 하나가 도구 넷이 됩니다.",
    needs: { kind: "slug", label: "폴더 이름", placeholder: "documents" },
    present: (m) => (m.services ?? []).filter((s) => s.dir).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["services"], { name: n, dir: `~/Documents/${n}` }));
      return { sec: "services", item: n, receipt: `폴더 ${n} 을 선언했습니다 — 설치 결재가 실제 자리에 묶습니다` };
    },
  },
  {
    id: "trigger-cron",
    group: "깨움",
    label: "정해진 시각에 깨우기",
    yaml: "triggers[] · cron",
    detail: "시계가 세션이나 동사를 깨웁니다. 만들면 옆에서 다음 5회를 볼 수 있습니다.",
    needs: { kind: "slug", label: "트리거 이름", placeholder: "daily-digest" },
    present: (m) => (m.triggers ?? []).filter((t) => t.when?.cron).length,
    async make(ctx, n) {
      await ctx.apply((d) =>
        push(d, ["triggers"], {
          id: n,
          when: { cron: "0 9 * * 1-5", tz: "Asia/Seoul" },
          then: { agent: landing(ctx.manifest), prompt: "정기 점검을 수행해 주세요." },
        }),
      );
      return { sec: "triggers", item: n, receipt: `트리거 ${n} 을 만들었습니다 — 평일 09:00 (고칠 수 있습니다)` };
    },
  },
  {
    id: "trigger-event",
    group: "깨움",
    label: "사건이 나면 깨우기",
    yaml: "triggers[] · event",
    detail: "설치·발행 같은 기판 사건에 반응합니다. 몰리면 debounce 로 묶습니다.",
    needs: { kind: "slug", label: "트리거 이름", placeholder: "on-install" },
    present: (m) => (m.triggers ?? []).filter((t) => t.when?.event).length,
    async make(ctx, n) {
      await ctx.apply((d) =>
        push(d, ["triggers"], {
          id: n,
          when: { event: "relay.package.installed" },
          then: { agent: landing(ctx.manifest), prompt: "설치 직후 할 일을 수행해 주세요." },
        }),
      );
      return { sec: "triggers", item: n, receipt: `사건 트리거 ${n} 을 만들었습니다 — relay.package.installed` };
    },
  },
  {
    id: "mission",
    group: "주고받기",
    label: "다른 앱이 시킬 수 있는 일",
    yaml: "missions[]",
    detail: "a2a 수신 선언. 설명은 위임하는 쪽이 읽습니다.",
    needs: { kind: "slug", label: "미션 이름", placeholder: "summarize-week" },
    present: (m) => (m.missions ?? []).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["missions"], { name: n, description: "" }));
      return { sec: "missions", item: n, receipt: `미션 ${n} 을 만들었습니다 — 설명을 채우세요(위임자가 읽습니다)` };
    },
  },
  {
    id: "edge-tools",
    group: "주고받기",
    label: "남의 기능 가져다 쓰기",
    yaml: "edges[] · tools",
    detail: "선언은 신청이고 활성화는 결재입니다. 결재는 지도에서 합니다.",
    needs: { kind: "text", label: "provider (@scope/이름)", placeholder: "@relay/mail" },
    present: (m) => (m.edges ?? []).filter((e) => e.tools?.length).length,
    async make(ctx, provider) {
      const i = (ctx.manifest.edges ?? []).length;
      await ctx.apply((d) => push(d, ["edges"], { provider, tools: [] }));
      return { sec: "edges", item: String(i), receipt: `${provider} 의 동사 소비를 신청했습니다 — 쓸 동사 이름을 채우세요` };
    },
  },
  {
    id: "edge-mission",
    group: "주고받기",
    label: "남에게 일 맡기기",
    yaml: "edges[] · mission",
    detail: "a2a 위임. 별도 세션에서 돌고 완료가 이 대화로 배달됩니다.",
    needs: { kind: "text", label: "provider (@scope/이름)", placeholder: "@relay/mail" },
    needs2: { kind: "slug", label: "미션 이름 (저쪽이 선언한 것)", placeholder: "summarize-week" },
    present: (m) => (m.edges ?? []).filter((e) => e.mission != null).length,
    async make(ctx, provider, mission) {
      const n = (mission ?? "").trim();
      if (!n) throw new Error("미션 이름이 필요합니다 — 문법이 빈 미션을 거부합니다");
      const i = (ctx.manifest.edges ?? []).length;
      await ctx.apply((d) => push(d, ["edges"], { provider, mission: n }));
      return { sec: "edges", item: String(i), receipt: `${provider} 의 ${n} 미션에 위임을 신청했습니다 — 결재는 지도에서 합니다` };
    },
  },
  {
    id: "edge-components",
    group: "주고받기",
    label: "남의 부품을 내 화면에 끼우기",
    yaml: "edges[] · components",
    detail: "결재되면 기판이 import map 을 심습니다. 화면은 주소를 조립하지 않습니다.",
    needs: { kind: "text", label: "provider (@scope/이름)", placeholder: "@relay/charts" },
    present: (m) => (m.edges ?? []).filter((e) => e.components).length,
    async make(ctx, provider) {
      const i = (ctx.manifest.edges ?? []).length;
      await ctx.apply((d) => push(d, ["edges"], { provider, components: true }));
      return { sec: "edges", item: String(i), receipt: `${provider} 의 부품 마운트를 신청했습니다 — 설치 시점에 결재됩니다` };
    },
  },
  {
    id: "requires-binary",
    group: "관문",
    label: "있어야 하는 실행파일",
    yaml: "requires.binaries[]",
    detail: "설치 관문. 없으면 설치가 fail-loud 로 멈추고 안내를 냅니다.",
    needs: { kind: "slug", label: "바이너리 이름", placeholder: "git" },
    present: (m) => (m.requires?.binaries ?? []).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["requires", "binaries"], { name: n }));
      return { sec: "requires", receipt: `${n} 을 설치 관문에 넣었습니다 — 설치가 실체를 판정합니다` };
    },
  },
  {
    id: "host-method",
    group: "관문",
    label: "기판 브리지 캡",
    yaml: "host_methods[]",
    detail: "이 앱의 동사가 부를 수 있는 host.* 를 좁힙니다. 미선언 = 전체이므로 좁히는 선언입니다.",
    needs: { kind: "text", label: "메서드 이름", placeholder: "host.draft_publish" },
    present: (m) => (m.host_methods ?? []).length,
    async make(ctx, n) {
      await ctx.apply((d) => push(d, ["host_methods"], n));
      return { sec: "host_methods", item: n, receipt: `${n} 만 허용하도록 좁혔습니다 — 목록 밖은 거부됩니다` };
    },
  },
];

export function creatable(id: string): Creatable {
  const c = CREATABLES.find((x) => x.id === id);
  if (!c) throw new Error(`없는 생성 항목: ${id}`);
  return c;
}

/** 지금 만들 수 있는가 — 하나뿐인 선언은 이미 있으면 잠그고, choice 는 남은 선택지가 없으면 잠근다 */
export function blocked(c: Creatable, m: Manifest, files: string[]): string | null {
  if (c.once && c.present(m, files) > 0) return "이미 있습니다";
  if (c.needs?.kind === "choice") {
    const left = c.needs.choices?.(m, files) ?? [];
    if (!left.length) return c.id === "harness" ? "네 가지를 다 붙였습니다" : "먼저 대상을 만드세요";
  }
  return null;
}

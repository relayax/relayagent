import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

export type RequiredOS = "darwin" | "linux" | "win32";

export interface RequiresDecl {
  os?: RequiredOS[];
  binaries?: { name: string; install?: string }[];
  apps?: { name: string; install?: string }[];
}

export interface Manifest {
  schema: string;
  name: string;
  version: string;
  display_name: string;
  description: string;
  icon?: string;
  /** 발행 주체 좌표(@scope) — 스토어 리스팅·정산이 읽는다 */
  publisher?: string;
  /** 발행일 YYYY-MM-DD — 스토어 리스팅 메타 */
  released_at?: string;
  requires?: RequiresDecl;
  surfaces: {
    view?: { source: string; out?: string };
    chat?: { mode: "direct" | "none"; greeting?: string };
    channels?: { name: string; source: string; entry: string; icon?: string }[];
  };
  harness?: {
    variants?: HarnessVariant[];
    workdir?: string;
  };
  hooks?: { deny?: string[] };
  /** 커넥터 계약 — 몸(서비스) 없는 커넥터의 자격 형태. url 서비스와 동시 선언 불가 */
  auth?: AuthDecl;
  agents?: { name: string; persona: string; skills?: string; commands?: string; dispatch?: string[]; scripts?: string[]; default?: boolean }[];
  scripts?: { source: string };
  services?: ServiceDecl[];
  triggers?: TriggerDecl[];
  missions?: { name: string; description?: string }[];
  edges?: { provider: string; tools?: string[]; mission?: string }[];
  /** ring-0 host 브리지 게이트 선언 — host.* 캡. 미선언 = 전체(ring-0 결재가 경계) */
  host_methods?: string[];
  /** 파일 버킷 파사드 — 1인 기판은 판정만, 집행은 org 기판 소유 */
  storage?: { buckets?: { name: string; policy?: string }[] };
  org?: unknown;
}

export interface HarnessVariant {
  name: string;
  source: string;
  entry: string;
  dockerfile?: string;
  /** 어댑터 도구 아이콘 (패키지 상대경로 이미지) */
  icon?: string;
  llm?: { provider: string; auth?: AuthDecl; /** provider(모델) 아이콘 */ icon?: string };
}

export type ServiceDecl =
  | { name: string; source: string; dockerfile?: string; entry?: string; disk?: string; resources?: { memory?: string; cpu?: number }; port?: number }
  | { name: string; url: string; tools?: string[]; auth?: AuthDecl }
  | { name: string; dir: string };

export interface AuthDecl {
  kind: "none" | "token" | "oauth";
  env?: string;
  help?: { url?: string; note?: string };
  verify?: { url: string; headers?: Record<string, string> };
  client?: string;
  oauth_client?: unknown;
  /** org 기판 자격 브로커의 서비스 키 — 브로커 없는 기판은 무시 */
  service?: string;
}

export interface TriggerDecl {
  id: string;
  label?: string;
  when: { cron?: string; tz?: string; event?: string; filter?: Record<string, unknown>; debounce_ms?: number };
  then: { agent?: string; prompt?: string; route?: string; delivery?: string; script?: string };
}

const NAME = /^@[a-z0-9-]+\/[a-z0-9][a-z0-9-]{1,39}$/;
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROVIDER = /^@[a-z0-9-]+\/[a-z0-9][a-z0-9-]{1,39}(@[^\s@]+)?$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const SIZE = /^\d+(Mi|Gi)$/;

// 판정기가 아는 최상위 어휘의 전부. 미지 키는 거부한다 — 조용히 받으면 같은 manifest 가
// 기판마다 다른 뜻이 되는 방언의 문이 열린다. 확장(org 의미)은 org 블록 한 곳으로만 들어온다
const TOP_KEYS = new Set([
  "schema", "name", "version", "display_name", "description", "icon", "publisher", "released_at",
  "requires", "surfaces", "harness", "hooks", "auth", "agents", "scripts", "services",
  "triggers", "missions", "edges", "host_methods", "storage", "org",
]);
const STORAGE_POLICIES = new Set(["org-member", "owner-only", "role-based"]);

/** 트리거 cron 문법 — tick.ts 의 매처가 이해하는 그대로(5필드, *|*\/n|a-b|숫자, 콤마 목록).
 *  판정 없이 받으면 오타 난 cron 이 영원히 침묵한다 — 발화하지 않는 트리거는 에러를 내지 않는다 */
export function validCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((f) =>
    f.split(",").every((part) => part === "*" || /^\*\/[1-9]\d*$/.test(part) || /^\d+-\d+$/.test(part) || /^\d+$/.test(part)),
  );
}

/** auth 블록 공용 판정 — services[].auth · harness llm.auth · 최상위 auth 가 같은 어휘를 쓴다 */
function judgeAuth(a: AuthDecl | undefined, label: string, issues: string[]): void {
  if (!a) return;
  if (!["none", "token", "oauth"].includes(a.kind)) {
    issues.push(`${label}.kind 닫힌집합 위반(none|token|oauth): ${a.kind}`);
    return;
  }
  if (a.env != null && (a.kind !== "token" || !/^[A-Z][A-Z0-9_]*$/.test(a.env))) {
    issues.push(`${label}.env: token 형의 대문자 env 이름만: ${a.env}`);
  }
  if (a.client != null && (a.kind !== "oauth" || !["dcr", "registered"].includes(a.client))) {
    issues.push(`${label}.client: oauth 형의 dcr|registered 만: ${a.client}`);
  }
  if (a.verify != null && typeof (a.verify as { url?: unknown }).url !== "string") {
    issues.push(`${label}.verify.url: 필수`);
  }
  if (a.service != null && !SLUG.test(a.service)) {
    issues.push(`${label}.service 형식 위반(slug): ${a.service}`);
  }
}

export class ManifestError extends Error {
  issues: string[];
  constructor(issues: string[]) {
    super(issues.join("\n"));
    this.issues = issues;
  }
}

export function shortName(pkg: string): string {
  return pkg.split("/").pop() ?? pkg;
}

const badPath = (p: string, allowTilde = false) =>
  (!allowTilde && (p.startsWith("/") || p.startsWith("~"))) ||
  (allowTilde && p.startsWith("/")) ||
  p.split("/").includes("..");

export function loadManifest(pkgPath: string): Manifest {
  const file = path.join(pkgPath, "relay.yaml");
  if (!fs.existsSync(file)) throw new ManifestError([`relay.yaml 없음: ${pkgPath}`]);
  const m = parseYaml(fs.readFileSync(file, "utf8")) as Manifest;
  judge(m, pkgPath);
  return m;
}

export function judge(m: Manifest, pkgPath?: string): void {
  const issues: string[] = [];
  const at = (p: string) => (pkgPath ? path.join(pkgPath, p) : null);
  const mustExist = (p: string, label: string) => {
    const full = at(p);
    if (full && !fs.existsSync(full)) issues.push(`${label}: 실체 없음: ${p}`);
  };

  if (m.schema !== "relay/v1") issues.push(`schema: relay/v1 필요`);
  for (const k of Object.keys(m as unknown as Record<string, unknown>)) {
    if (!TOP_KEYS.has(k)) issues.push(`미지 최상위 키: ${k}`);
  }
  for (const f of ["name", "version", "display_name", "description"] as const) {
    if (typeof m[f] !== "string" || m[f].trim() === "") issues.push(`${f}: 필수`);
  }
  if (m.name && !NAME.test(m.name)) issues.push(`name 형식 위반: ${m.name}`);
  if (m.version && typeof m.version === "string" && !SEMVER.test(m.version)) issues.push(`version 형식 위반(semver): ${m.version}`);
  if (m.publisher != null && !/^@[a-z0-9-]+$/.test(String(m.publisher))) issues.push(`publisher 형식 위반(@scope): ${m.publisher}`);
  if (m.released_at != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(m.released_at))) issues.push(`released_at 형식 위반(YYYY-MM-DD): ${m.released_at}`);
  if (!m.surfaces || typeof m.surfaces !== "object") issues.push("surfaces: 필수");
  for (const k of Object.keys(m.surfaces ?? {})) {
    if (!["view", "chat", "channels"].includes(k)) issues.push(`미지 surfaces 키: ${k}`);
  }

  if (m.icon) mustExist(m.icon, "icon");

  // requires 의 형태 판정. 실체(호스트에 실제로 있는가)는 설치가 판정한다
  const req = m.requires;
  if (req) {
    if (req.os && req.os.length === 0) issues.push("requires.os: 빈 목록 불가");
    for (const o of req.os ?? []) {
      if (!["darwin", "linux", "win32"].includes(o)) issues.push(`requires.os 닫힌집합 위반: ${o}`);
    }
    if (req.binaries && req.binaries.length === 0) issues.push("requires.binaries: 빈 목록 불가");
    const BIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
    for (const b of req.binaries ?? []) {
      if (typeof b !== "object" || b == null || !BIN.test(b.name ?? "")) {
        issues.push(`requires.binaries 형식 위반({name, install?}): ${JSON.stringify(b)}`);
      }
    }
    if (req.apps && req.apps.length === 0) issues.push("requires.apps: 빈 목록 불가");
    const APP = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
    for (const a of req.apps ?? []) {
      if (typeof a !== "object" || a == null || !APP.test(a.name ?? "") || /\.app$/i.test(a.name ?? "")) {
        issues.push(`requires.apps 형식 위반(.app 을 뺀 번들 이름의 {name, install?}): ${JSON.stringify(a)}`);
      }
    }
    if ((req.apps ?? []).length > 0 && ((req.os ?? []).length === 0 || (req.os ?? []).some((o) => o !== "darwin"))) {
      issues.push("requires.apps 는 darwin 전용: requires.os 를 [darwin] 으로 선언");
    }
  }

  const view = m.surfaces?.view;
  if (view) {
    if (!view.source || badPath(view.source)) issues.push("surfaces.view.source: 상대경로 필수");
    else mustExist(view.source, "surfaces.view.source");
    if (view.out != null && badPath(view.out)) issues.push("surfaces.view.out: 상대경로 필수");
  }
  const chat = m.surfaces?.chat;
  if (chat && !["direct", "none"].includes(chat.mode as string)) {
    issues.push(`surfaces.chat.mode 닫힌집합 위반(direct|none): ${chat.mode}`);
  }
  const chNames = new Set<string>();
  for (const c of m.surfaces?.channels ?? []) {
    if (!SLUG.test(c.name ?? "")) issues.push(`channels 이름 형식 위반: ${c.name}`);
    if (chNames.has(c.name)) issues.push(`channels 이름 중복: ${c.name}`);
    chNames.add(c.name);
    if (!c.source || !c.entry) issues.push(`channels[${c.name}]: source + entry 필수`);
    else mustExist(path.join(c.source, c.entry), `channels[${c.name}].entry`);
    if (c.icon) mustExist(c.icon, `channels[${c.name}].icon`);
  }

  const h = m.harness;
  const variants = h?.variants ?? [];
  const vNames = new Set<string>();
  for (const v of variants) {
    if (!SLUG.test(v.name ?? "")) issues.push(`harness.variants 이름 형식 위반: ${v.name}`);
    if (vNames.has(v.name)) issues.push(`harness.variants 이름 중복: ${v.name}`);
    vNames.add(v.name);
    if (!v.source || !v.entry) issues.push(`harness.variants[${v.name}]: source + entry 필수`);
    else mustExist(path.join(v.source, v.entry), `harness.variants[${v.name}].entry`);
    if (v.icon) mustExist(v.icon, `harness.variants[${v.name}].icon`);
    if (v.llm) {
      if (!SLUG.test(v.llm.provider ?? "")) issues.push(`harness.variants[${v.name}].llm.provider 형식 위반: ${v.llm.provider}`);
      judgeAuth(v.llm.auth, `harness.variants[${v.name}].llm.auth`, issues);
      if (v.llm.icon) mustExist(v.llm.icon, `harness.variants[${v.name}].llm.icon`);
    }
  }
  if ((m.agents ?? []).length > 0 && variants.length === 0) {
    issues.push("에이전트 패키지는 하네스를 동봉해야 합니다: harness.variants [{name, source, entry}]");
  }
  if (h?.workdir && badPath(h.workdir)) issues.push(`harness.workdir: workspace 하위 상대경로만: ${h.workdir}`);

  // hooks.deny 는 호스트 경로다 — ~ 또는 절대경로. 기판은 ~/.relay 를 선언과 무관하게 항상 병합한다
  if (m.hooks) {
    if (m.hooks.deny && m.hooks.deny.length === 0) issues.push("hooks.deny: 빈 목록 불가");
    for (const d of m.hooks.deny ?? []) {
      if (typeof d !== "string" || !/^(~($|\/)|\/)/.test(d) || d.split("/").includes("..")) {
        issues.push(`hooks.deny 는 ~ 또는 절대경로만(.. 금지): ${d}`);
      }
    }
  }

  const agents = m.agents ?? [];
  const agentNames = new Set<string>();
  const scriptNames = pkgPath && m.scripts?.source ? listScripts(pkgPath, m) : null;
  const defaults = agents.filter((a) => a.default === true);
  if (defaults.length > 1) issues.push(`agents[].default 는 최대 1: ${defaults.map((a) => a.name).join(", ")}`);
  for (const a of agents) {
    if (!SLUG.test(a.name ?? "")) issues.push(`agent 이름 형식 위반: ${a.name}`);
    if (agentNames.has(a.name)) issues.push(`agent 이름 중복: ${a.name}`);
    agentNames.add(a.name);
    if (a.default != null && typeof a.default !== "boolean") issues.push(`agents[${a.name}].default: boolean 만`);
    if (!a.persona) issues.push(`agents[${a.name}].persona: 필수`);
    else mustExist(a.persona, `agents[${a.name}].persona`);
    if (a.skills) mustExist(a.skills, `agents[${a.name}].skills`);
    if (a.commands) mustExist(a.commands, `agents[${a.name}].commands`);
    for (const d of a.dispatch ?? []) {
      if (!agentNames.has(d) && !agents.some((x) => x.name === d)) issues.push(`agents[${a.name}].dispatch 미선언 대상: ${d}`);
    }
    // scope 는 실재하는 동사만 가리켜야 한다. 없는 동사를 가리키면 설치 후 도구가 조용히 비어버린다
    for (const s of a.scripts ?? []) {
      if (!/^[a-z0-9][a-z0-9-]*\*?$/.test(s)) {
        issues.push(`agents[${a.name}].scripts 형식 위반: ${s}`);
        continue;
      }
      if (!m.scripts?.source) {
        issues.push(`agents[${a.name}].scripts 선언에 scripts.source 없음: ${s}`);
        continue;
      }
      if (!scriptNames) continue;
      const hit = s.endsWith("*") ? scriptNames.some((n) => n.startsWith(s.slice(0, -1))) : scriptNames.includes(s);
      if (!hit) issues.push(`agents[${a.name}].scripts 실체 없음: ${s}`);
    }
  }

  if (m.scripts) {
    if (!m.scripts.source || badPath(m.scripts.source)) issues.push("scripts.source: 상대경로 필수");
    else mustExist(m.scripts.source, "scripts.source");
  }

  const svcNames = new Set<string>();
  for (const s of m.services ?? []) {
    if (!SLUG.test(s.name ?? "")) issues.push(`service 이름 형식 위반: ${(s as { name?: string }).name}`);
    if (svcNames.has(s.name)) issues.push(`service 이름 중복: ${s.name}`);
    svcNames.add(s.name);
    const forms = ["source", "url", "dir"].filter((k) => (s as Record<string, unknown>)[k] != null);
    if (forms.length !== 1) {
      issues.push(`services[${s.name}]: source | url | dir 중 정확히 하나`);
      continue;
    }
    if ("source" in s && s.source != null) {
      if (!s.dockerfile && !s.entry) issues.push(`services[${s.name}]: dockerfile(컨테이너 형) 또는 entry(프로세스 형) 필수`);
      if (s.dockerfile) mustExist(path.join(s.source, s.dockerfile), `services[${s.name}].dockerfile`);
      if (s.entry) mustExist(path.join(s.source, s.entry), `services[${s.name}].entry`);
      if (s.disk != null && !SIZE.test(s.disk)) issues.push(`services[${s.name}].disk 형식 위반(<n>Mi|Gi): ${s.disk}`);
      if (s.resources?.memory != null && !SIZE.test(s.resources.memory)) issues.push(`services[${s.name}].resources.memory 형식 위반(<n>Mi|Gi): ${s.resources.memory}`);
      if (s.resources?.cpu != null && !(typeof s.resources.cpu === "number" && s.resources.cpu > 0)) issues.push(`services[${s.name}].resources.cpu: 0 초과 숫자만(코어 수)`);
    }
    if ("url" in s && s.url != null) {
      if (!/^https?:\/\//.test(s.url)) issues.push(`services[${s.name}].url: http(s) URL 필요`);
      for (const t of s.tools ?? []) if (!SLUG.test(t)) issues.push(`services[${s.name}].tools 형식 위반: ${t}`);
      judgeAuth(s.auth, `services[${s.name}].auth`, issues);
    }
    if ("dir" in s && s.dir != null && badPath(s.dir, true)) issues.push(`services[${s.name}].dir: 상대경로 또는 ~ 경로만`);
  }
  // 커넥터 계약 — 몸 없는 커넥터의 자격 형태 선언. url 서비스(자격이 서비스 소속)와는
  // 계약 출처가 겹치므로 동시 선언을 거부한다: 계약 출처는 한 곳이어야 결재가 한 곳에 선다
  if (m.auth) {
    judgeAuth(m.auth, "auth", issues);
    if (m.auth.kind === "none") issues.push("auth: 커넥터 계약에 none 은 무의미 — 블록을 제거하세요");
    if ((m.services ?? []).some((s) => "url" in s && s.url != null)) {
      issues.push("auth: url 서비스와 최상위 auth 동시 선언 불가 — 계약 출처는 한 곳");
    }
  }
  // 채널은 서비스와 자격 이름공간(credKey)을 공유한다 — 이름이 겹치면 vault 키가 충돌한다
  for (const n of chNames) {
    if (svcNames.has(n)) issues.push(`channels[${n}]: services 와 이름 충돌 — 자격 이름공간을 공유합니다`);
  }

  const triggerIds = new Set<string>();
  for (const t of m.triggers ?? []) {
    if (!SLUG.test(t.id ?? "")) issues.push(`trigger id 형식 위반: ${t.id}`);
    if (triggerIds.has(t.id)) issues.push(`trigger id 중복: ${t.id}`);
    triggerIds.add(t.id);
    if (t.label != null && (typeof t.label !== "string" || !t.label.trim())) issues.push(`triggers[${t.id}].label: 비어 있지 않은 문자열만`);
    const whenForms = [t.when?.cron, t.when?.event].filter((x) => x != null).length;
    if (whenForms !== 1) issues.push(`triggers[${t.id}].when: cron | event 중 하나`);
    if (t.when?.cron != null) {
      if (!validCron(t.when.cron)) issues.push(`triggers[${t.id}].when.cron 문법 위반(5필드 · *|*/n|a-b|숫자, 콤마): ${t.when.cron}`);
      if (t.when.tz != null) {
        try {
          new Date().toLocaleString("en-US", { timeZone: t.when.tz });
        } catch {
          issues.push(`triggers[${t.id}].when.tz 미지 시간대: ${t.when.tz}`);
        }
      }
      // debounce·filter 는 event 형 소속이다 — cron 에 붙으면 조용히 무시되므로 판정으로 막는다
      if (t.when.debounce_ms != null) issues.push(`triggers[${t.id}].when.debounce_ms: event 형 전용`);
      if (t.when.filter != null) issues.push(`triggers[${t.id}].when.filter: event 형 전용`);
    }
    if (t.when?.event != null && t.when.tz != null) issues.push(`triggers[${t.id}].when.tz: cron 형 전용`);
    const thenForms = [t.then?.agent, t.then?.script].filter((x) => x != null).length;
    if (thenForms !== 1) issues.push(`triggers[${t.id}].then: agent | script 중 하나`);
    if (t.then?.agent && !agentNames.has(t.then.agent)) issues.push(`triggers[${t.id}].then.agent 미선언: ${t.then.agent}`);
    if (t.then?.agent && !t.then?.prompt) issues.push(`triggers[${t.id}].then.prompt: agent 형이면 필수`);
    if (t.then?.script && (t.then.route != null || t.then.delivery != null)) issues.push(`triggers[${t.id}].then.route/delivery: agent 형 전용`);
    if (t.then?.route != null && !/^\//.test(t.then.route)) issues.push(`triggers[${t.id}].then.route: / 시작 경로만`);
    if (t.then?.delivery != null) {
      const dm = /^([a-z0-9][a-z0-9-]{0,39}):(.+)$/.exec(t.then.delivery);
      if (!dm) issues.push(`triggers[${t.id}].then.delivery 형식 위반(<채널이름>:<대화키>): ${t.then.delivery}`);
      else if (!chNames.has(dm[1])) issues.push(`triggers[${t.id}].then.delivery 미선언 채널: ${dm[1]}`);
    }
  }

  const missionNames = new Set<string>();
  for (const mi of m.missions ?? []) {
    if (typeof mi?.name !== "string" || !mi.name.trim()) issues.push("missions[].name: 필수");
    else if (missionNames.has(mi.name)) issues.push(`mission 이름 중복: ${mi.name}`);
    else missionNames.add(mi.name);
  }

  for (const e of m.edges ?? []) {
    if (!PROVIDER.test(e.provider ?? "")) issues.push(`edge provider 형식 위반: ${e.provider}`);
    if (e.tools != null && e.mission != null) issues.push(`edges[${e.provider}]: tools 와 mission 동시 선언 불가`);
    for (const t of e.tools ?? []) if (!SLUG.test(t)) issues.push(`edges[${e.provider}].tools 형식 위반: ${t}`);
    if (e.mission != null && (typeof e.mission !== "string" || !e.mission.trim())) issues.push(`edges[${e.provider}].mission: 비어 있지 않은 문자열만`);
  }

  if (m.host_methods != null) {
    if (!Array.isArray(m.host_methods) || m.host_methods.length === 0) issues.push("host_methods: 비어 있지 않은 목록");
    for (const hm of Array.isArray(m.host_methods) ? m.host_methods : []) {
      if (typeof hm !== "string" || !/^host\.[a-z0-9]+([._][a-z0-9]+)*$/.test(hm)) issues.push(`host_methods 형식 위반(host.*): ${hm}`);
    }
  }

  if (m.storage != null) {
    for (const k of Object.keys(m.storage)) if (k !== "buckets") issues.push(`미지 storage 키: ${k}`);
    const buckets = m.storage.buckets;
    if (!Array.isArray(buckets) || buckets.length === 0) issues.push("storage.buckets: 비어 있지 않은 목록");
    const bNames = new Set<string>();
    for (const b of Array.isArray(buckets) ? buckets : []) {
      if (!SLUG.test(b?.name ?? "")) issues.push(`storage.buckets 이름 형식 위반: ${b?.name}`);
      else if (bNames.has(b.name)) issues.push(`storage.buckets 이름 중복: ${b.name}`);
      else bNames.add(b.name);
      if (b?.policy != null && !STORAGE_POLICIES.has(b.policy)) issues.push(`storage.buckets[${b?.name}].policy 닫힌집합 위반(org-member|owner-only|role-based): ${b?.policy}`);
    }
  }

  if (issues.length) throw new ManifestError(issues);
}

export function activeHarness(m: Manifest, selected?: string): HarnessVariant | null {
  const vs = m.harness?.variants ?? [];
  return vs.find((v) => v.name === selected) ?? vs[0] ?? null;
}

export function landingAgentName(m: Manifest): string | null {
  // 명시 선언이 관례보다 먼저다: default: true 가 main 슬롯 착지점.
  // 미선언이면 "패키지 짧은 이름과 같은 에이전트" 관례 — 명시 선언은 이 관례의 상위 호환이다
  const explicit = (m.agents ?? []).find((a) => a.default === true);
  if (explicit) return explicit.name;
  const short = shortName(m.name);
  return (m.agents ?? []).some((a) => a.name === short) ? short : null;
}

export function agentScriptScope(m: Manifest, agent: string): ((s: string) => boolean) | null {
  const decl = (m.agents ?? []).find((a) => a.name === agent);
  const list = decl?.scripts ?? [];
  if (!list.length) return null;
  const exact = new Set(list.filter((s) => !s.endsWith("*")));
  const prefixes = list.filter((s) => s.endsWith("*")).map((s) => s.slice(0, -1));
  return (key) => exact.has(key) || prefixes.some((p) => key.startsWith(p));
}

export function listScripts(pkgPath: string, m: Manifest): string[] {
  if (!m.scripts) return [];
  const dir = path.join(pkgPath, m.scripts.source);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => f.replace(/\.ts$/, ""));
}

// ── 마켓플레이스 지반: 선언 경로 목록과 권한 고지서 ──────────────────────────

export interface DeclaredPath {
  path: string;
  kind: "file" | "dir";
}

/**
 * 매니페스트가 선언한 패키지 내부 경로 전부. judge() 의 mustExist 순회와 형제다.
 * 차이 하나: judge 는 entry 파일 하나를 보지만 여기서는 source 디렉토리를 통째로 잡는다 —
 * 어댑터·서비스·화면이 헬퍼 파일을 나눠 쓰므로 봉투는 디렉토리 단위여야 실행이 깨지지 않는다.
 * 봉투(pack)와 발행 화면의 파일 목록이 이 함수 하나를 본다. 선언 밖 파일은 봉투에 없다.
 */
export function declaredPaths(m: Manifest): DeclaredPath[] {
  const out: DeclaredPath[] = [{ path: "relay.yaml", kind: "file" }];
  const file = (p?: string | null) => { if (p) out.push({ path: p, kind: "file" }); };
  const dir = (p?: string | null) => { if (p) out.push({ path: p, kind: "dir" }); };

  file(m.icon);
  dir(m.surfaces?.view?.source); // out(빌드 산출물)은 pack 이 뺀다
  for (const c of m.surfaces?.channels ?? []) { dir(c.source); file(c.icon); }
  for (const v of m.harness?.variants ?? []) { dir(v.source); file(v.icon); file(v.llm?.icon); }
  for (const a of m.agents ?? []) { file(a.persona); dir(a.skills); dir(a.commands); }
  dir(m.scripts?.source);
  for (const s of m.services ?? []) if ("source" in s && s.source != null) dir(s.source);
  // services[].dir 은 사용자 홈의 폴더 요청이지 패키지 경로가 아니다 — 봉투에 담을 것이 없다
  return out;
}

export interface Disclosure {
  /** services[].dir — 사용자 컴퓨터에서 만들고 읽고 쓰는 폴더 */
  folders: { name: string; path: string }[];
  /** services[].url — 밖으로 나가는 접점과 자격의 형태 */
  network: { name: string; url: string; auth: string }[];
  /** triggers — 사용자가 없어도 스스로 깨어나는 시점 */
  wakeups: { id: string; when: string }[];
  /** harness.variants[].llm — 사용자의 어느 계정으로 도는가 */
  llm: { provider: string; auth: string }[];
  /** requires — 호스트에 미리 있어야 하는 것 */
  host: string[];
  /** hooks.deny — 닿지 않겠다고 스스로 선언한 경로 */
  denied: string[];
  /** edges — 다른 패키지에서 빌리겠다고 신청한 능력 */
  borrows: string[];
  /** services[].source — 패키지가 띄우는 프로세스·컨테이너 */
  spawns: string[];
  /** channels — 외부 대화 문 */
  channels: string[];
  /** 최상위 auth — 몸 없는 커넥터 계약의 자격 형태 (없으면 null) */
  connector: string | null;
  /** host_methods — 기판 host 브리지 게이트 선언 */
  hostMethods: string[];
  /** 요구 범위. 위험이 아니라 넓이 — 화면 미터가 이 값을 그린다 */
  risk: "low" | "medium" | "high";
}

/**
 * 권한 고지서 — 매니페스트 선언에서 기계로 뽑는 사실 목록. 설치 동의 화면과 마켓 상세가
 * 이걸 그린다. 홍보 문구가 아니라 선언이므로 판매자가 과장할 수 없고, 버전 간 diff 도
 * 이 구조의 비교로 나온다.
 */
export function disclosure(m: Manifest): Disclosure {
  const folders: Disclosure["folders"] = [];
  const network: Disclosure["network"] = [];
  const spawns: string[] = [];
  for (const s of m.services ?? []) {
    if ("dir" in s && s.dir != null) folders.push({ name: s.name, path: s.dir });
    else if ("url" in s && s.url != null) network.push({ name: s.name, url: s.url, auth: s.auth?.kind ?? "none" });
    else if ("source" in s && s.source != null) spawns.push(`${s.name} (${s.dockerfile ? "컨테이너" : "프로세스"})`);
  }
  const wakeups = (m.triggers ?? []).map((t) => ({
    id: t.id,
    when: t.when.cron ? `cron ${t.when.cron}${t.when.tz ? ` (${t.when.tz})` : ""}` : `event ${t.when.event}`,
  }));
  const llm = (m.harness?.variants ?? [])
    .filter((v) => v.llm)
    .map((v) => ({ provider: v.llm!.provider, auth: v.llm!.auth?.kind ?? "none" }));
  const host: string[] = [];
  if (m.requires?.os?.length) host.push(`OS: ${m.requires.os.join(", ")}`);
  for (const b of m.requires?.binaries ?? []) host.push(b.name);
  for (const a of m.requires?.apps ?? []) host.push(`${a.name}.app`);
  const borrows = (m.edges ?? []).map((e) =>
    `${e.provider}${e.mission ? ` (mission ${e.mission})` : e.tools?.length ? ` (tools ${e.tools.join(", ")})` : ""}`,
  );
  const channels = (m.surfaces?.channels ?? []).map((c) => c.name);
  const connector = m.auth?.kind ?? null;
  const hostMethods = m.host_methods ?? [];

  // 요구 범위 판정. high = 사용자 시야 밖에서 움직일 수 있는 선언(자동 실행, 외부 접점,
  // 자기 프로세스, 타 패키지 차용, 기판 host 브리지). medium = 호스트나 대화 표면을 넓게
  // 쓰는 선언. 나머지 low
  const risk: Disclosure["risk"] =
    wakeups.length || network.length || spawns.length || borrows.length || connector || hostMethods.length
      ? "high"
      : host.length || channels.length || (m.hooks?.deny?.length ?? 0)
        ? "medium"
        : "low";

  return { folders, network, wakeups, llm, host, denied: m.hooks?.deny ?? [], borrows, spawns, channels, connector, hostMethods, risk };
}

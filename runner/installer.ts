import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { saveLedger, expandHome, workspacePath, RELAY_HOME, type Grant, type Ledger } from "./state.ts";
import { loadManifest, judge, activeHarness, ManifestError, type Manifest, type HarnessVariant } from "./manifest.ts";
import { buildView, type BuildResult } from "./build.ts";
import { conformHarness } from "./conform.ts";
import { spawnEntrySync } from "./entry.ts";
import { vaultGet, vaultSet } from "./vault.ts";
import { parse as parseYaml } from "yaml";

export interface InstallOpts {
  name?: string;
  ring0?: boolean;
  /** 폴더 결재 — 세션 cwd. 미지정 = 기본 ~/Relay/<이름>. 이 지정이 GUI 폴더 선택의 CLI 형태다 */
  workspace?: string;
}

export interface InstallResult {
  name: string;
  manifest: Manifest;
  /** 후보들의 setup 점검 결과. ok = 쓸 수 있는 하네스를 하나라도 골랐다 */
  setup?: { ok: boolean; out: string };
  build?: BuildResult;
}

/** requires 실체 판정. 기판은 안내(install)만 전하고 대신 설치하지 않는다 */
export function judgeRequires(m: Manifest): void {
  const r = m.requires;
  if (!r) return;
  const issues: string[] = [];
  if (r.os?.length && !(r.os as string[]).includes(process.platform)) {
    issues.push(`requires os: ${process.platform} 미지원 (요구: ${r.os.join(", ")})`);
  }
  for (const b of r.binaries ?? []) {
    const probe = spawnSync(process.platform === "win32" ? "where" : "which", [b.name], { encoding: "utf8" });
    if (probe.status !== 0) issues.push(`requires binary 없음: ${b.name}${b.install ? ` (설치: ${b.install})` : ""}`);
  }
  const appRoots = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications"];
  for (const a of r.apps ?? []) {
    if (!appRoots.some((root) => fs.existsSync(path.join(root, a.name + ".app")))) {
      issues.push(`requires app 없음: ${a.name}.app${a.install ? ` (설치: ${a.install})` : ""}`);
    }
  }
  if (issues.length) throw new ManifestError(issues);
}

export function installPkg(ledger: Ledger, dir: string, opts: InstallOpts = {}): InstallResult {
  const abs = path.resolve(dir);
  const m = loadManifest(abs);
  judgeRequires(m); // 장부에 기록되기 전에 fail-loud
  const name = opts.name ?? path.basename(abs);

  // 계약 적합성은 설치 게이트다. 도구 미설치(환경 미비)와 계약 위반(어댑터 결함)은 다른 축이라
  // conform 은 setup 실패를 위반으로 세지 않는다 — 여기서 막히는 것은 잘못 만든 어댑터뿐이다.
  // 장부 기록 전에 던져야 거부된 패키지가 등재된 채 남지 않는다(judgeRequires 와 같은 자리)
  const variants = m.harness?.variants ?? [];
  const broken = variants
    .map((v) => conformHarness(abs, v))
    .filter((r) => !r.ok)
    .map((r) => `${r.variant}: ` + r.checks.filter((c) => !c.ok).map((c) => `${c.verb} — ${c.note}`).join(" / "));
  if (broken.length) {
    throw new ManifestError(["하네스 계약 위반 (relay harness-check 로 재현):", ...broken]);
  }

  ledger.packages[name] = {
    path: abs,
    ...(opts.workspace ? { workspace: path.resolve(expandHome(opts.workspace)) } : {}),
    ...(opts.ring0 ? { ring: 0 as const } : {}),
  };
  saveLedger(ledger);
  let setup: { ok: boolean; out: string } | undefined;
  if (variants.length) {
    const reports: string[] = [];
    let picked: string | null = null;
    for (const v of variants) {
      const r = spawnEntrySync(path.join(abs, v.source, v.entry), ["setup"], { encoding: "utf8" });
      const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
      reports.push(`${v.name}: ${r.status === 0 ? "준비됨" : "불가"} — ${out}`);
      if (r.status === 0 && !picked) picked = v.name;
    }
    ledger.packages[name].harness = picked ?? variants[0].name;
    saveLedger(ledger);
    setup = { ok: picked != null, out: `활성 하네스: ${ledger.packages[name].harness}\n` + reports.join("\n") };
  }
  const build = buildView(name, abs, m);
  return { name, manifest: m, setup, build };
}

export function buildPkg(ledger: Ledger, name: string): BuildResult {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  return buildView(name, rec.path, m) ?? { ok: true, out: "surfaces.view.out 미선언 — 빌드 없이 source 를 그대로 서빙합니다" };
}

// token 자격형은 자격이 기판 손(vault)에 있다 — 동사 실행에도 세션과 같은 주입을 해줘야
// setup 이 "연결 후에도 미준비" 로 거짓말하지 않는다
function llmEnv(v: HarnessVariant): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (v.llm?.auth?.kind === "token" && v.llm.auth.env) {
    const cred = vaultGet(`llm/${v.llm.provider}`);
    if (cred) env[v.llm.auth.env] = cred;
  }
  return env;
}

export function harnessVerb(ledger: Ledger, name: string, verb: "models" | "info" | "setup" | "commands"): { ok: boolean; out: string } {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  const v = activeHarness(m, rec.harness);
  if (!v) throw new Error(`하네스 미동봉 패키지: ${name}`);
  const r = spawnEntrySync(path.join(rec.path, v.source, v.entry), [verb], { encoding: "utf8", env: llmEnv(v) });
  // models·info·commands 는 stdout 이 JSON 계약이다. stderr(강등 사유 등)를 섞으면
  // JSON 해석이 깨져 화면의 모델 목록이 통째로 사라진다 — 진단문은 setup 에만 합친다
  const jsonVerb = verb === "models" || verb === "info" || verb === "commands";
  const out = jsonVerb ? (r.stdout ?? "") : (r.stdout ?? "") + (r.stderr ?? "");
  return { ok: r.status === 0, out: out.trim() };
}

export interface VariantProbe {
  name: string;
  provider: string | null;
  ready: boolean;
  /** 미준비의 축 — 화면이 처방을 고르는 기준 */
  reason: "ok" | "no-tool" | "no-auth";
  note: string;
  account: unknown;
  protocol: number;
  capabilities: string[];
  login: boolean;
  auth: string | null;
}

/** variant 전수 점검 — 다이얼로그의 행별 준비 상태·계정 표시가 이걸 그린다. 활성만 보던 구멍의 답 */
export function probeHarness(ledger: Ledger, name: string): VariantProbe[] {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  return (m.harness?.variants ?? []).map((v) => {
    const entry = path.join(rec.path, v.source, v.entry);
    const env = llmEnv(v);
    const info = spawnEntrySync(entry, ["info"], { encoding: "utf8", timeout: 15_000, env });
    let j: { account?: unknown; protocol?: unknown; capabilities?: unknown; verbs?: unknown } = {};
    try {
      j = JSON.parse(info.stdout || "{}");
    } catch { /* info 비 JSON — conform 이 잡을 결함, 여기선 기본값으로 */ }
    const setup = spawnEntrySync(entry, ["setup"], { encoding: "utf8", timeout: 15_000, env });
    // setup 종료코드가 미준비의 축을 가른다: 3 = 도구 없음(설치), 그 외 비0 = 자격 없음(로그인/토큰).
    // 화면은 이 축으로 처방을 고른다 — 도구가 없는데 토큰 입력창을 띄우면 사용자를 헛돌린다
    const reason = setup.status === 0 ? "ok" : setup.status === 3 ? "no-tool" : "no-auth";
    return {
      name: v.name,
      provider: v.llm?.provider ?? null,
      ready: setup.status === 0,
      reason,
      note: ((setup.stdout ?? "") + (setup.stderr ?? "")).trim().split("\n")[0] ?? "",
      account: j.account ?? null,
      protocol: Number.isInteger(j.protocol) ? (j.protocol as number) : 1,
      capabilities: Array.isArray(j.capabilities) ? j.capabilities.filter((c): c is string => typeof c === "string") : [],
      login: Array.isArray(j.verbs) && (j.verbs as unknown[]).includes("login"),
      auth: v.llm?.auth?.kind ?? null,
    };
  });
}

/** token 자격형 하네스의 자격 연결 — vault 에 provider 소속으로 앉힌다 (relay connect llm 의 웹 등가) */
export function connectHarnessToken(ledger: Ledger, name: string, tokenValue: string): { ok: boolean; out: string } {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  const v = activeHarness(m, rec.harness);
  if (!v) throw new Error(`하네스 미동봉 패키지: ${name}`);
  if (v.llm?.auth?.kind !== "token" || !v.llm.provider) {
    throw new Error(`token 자격형 하네스가 아닙니다: ${v.name} — 대화형 로그인은 터미널에서 relay login ${name}`);
  }
  const val = tokenValue.trim();
  if (!val) throw new Error("빈 토큰");
  vaultSet(`llm/${v.llm.provider}`, val);
  return harnessVerb(ledger, name, "setup");
}

/** login 은 대화형(TTY 상속)이라 출력을 삼키지 않는다. HTTP 로는 열지 않는다 — 사용자의 터미널 행위 */
export function harnessLogin(ledger: Ledger, name: string, args: string[] = []): number {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  const v = activeHarness(m, rec.harness);
  if (!v) throw new Error(`하네스 미동봉 패키지: ${name}`);
  const entry = path.join(rec.path, v.source, v.entry);
  const info = spawnEntrySync(entry, ["info"], { encoding: "utf8" });
  let verbs: string[] = [];
  try {
    verbs = JSON.parse(info.stdout || "{}").verbs ?? [];
  } catch { /* info 미구현 어댑터 — 아래에서 거부 */ }
  if (!verbs.includes("login")) {
    throw new Error(`이 하네스(${v.name})는 login 동사를 제공하지 않습니다 — 자격 연결은 relay connect llm ${v.llm?.provider ?? "<provider>"} 로 하세요`);
  }
  const r = spawnEntrySync(entry, ["login", ...args], { stdio: "inherit" });
  return r.status ?? 1;
}

/**
 * GUI 발화 로그인. 대화형 인증은 TTY 소유라 브라우저가 대신할 수 없지만, 띄우는 것은 할 수 있다 —
 * 기판이 터미널 창을 열어 login 동사를 그 안에서 돌린다. 자격을 만드는 행위는 여전히 사용자의 것이고
 * 기판은 문만 열어 준다. 창을 못 여는 환경에서는 명령을 돌려줘 사용자가 직접 실행한다
 */
export function launchHarnessLogin(ledger: Ledger, name: string, opts: { switch?: boolean } = {}): { launched: boolean; command: string; note: string } {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  const v = activeHarness(m, rec.harness);
  if (!v) throw new Error(`하네스 미동봉 패키지: ${name}`);
  const entry = path.join(rec.path, v.source, v.entry);
  const info = spawnEntrySync(entry, ["info"], { encoding: "utf8" });
  let verbs: string[] = [];
  try {
    verbs = JSON.parse(info.stdout || "{}").verbs ?? [];
  } catch { /* info 미구현 어댑터 — 아래에서 거부 */ }
  if (!verbs.includes("login")) {
    throw new Error(`이 하네스(${v.name})는 login 동사를 제공하지 않습니다 — 자격 연결은 토큰 입력으로 하세요`);
  }
  const args = opts.switch ? ["login", "--switch"] : ["login"];
  const command = `relay login ${name}${opts.switch ? " --switch" : ""}`;
  if (process.platform !== "darwin") {
    return { launched: false, command, note: "이 환경에서는 터미널 창을 열 수 없습니다 — 아래 명령을 직접 실행하세요" };
  }
  const script = path.join(RELAY_HOME, "run", `login-${name.replace(/[^a-zA-Z0-9._-]/g, "_")}.command`);
  fs.writeFileSync(
    script,
    `#!/bin/bash\ncd ${JSON.stringify(path.dirname(entry))}\necho "relay: ${v.name} 로그인 — 끝나면 이 창을 닫고 GUI 에서 '다시 점검'"\n${JSON.stringify(entry)} ${args.map((a) => JSON.stringify(a)).join(" ")}\n`,
    { mode: 0o700 },
  );
  const r = spawnSync("open", ["-a", "Terminal", script], { encoding: "utf8" });
  if (r.status !== 0) return { launched: false, command, note: (r.stderr ?? "터미널을 열지 못했습니다").trim() };
  return { launched: true, command, note: "터미널 창에서 로그인을 마친 뒤 다시 점검을 누르세요" };
}

export function setHarness(ledger: Ledger, name: string, variant: string): { active: string; setup: { ok: boolean; out: string } } {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  const v = (m.harness?.variants ?? []).find((x) => x.name === variant);
  if (!v) throw new Error(`미선언 하네스: ${variant} (선언: ${(m.harness?.variants ?? []).map((x) => x.name).join(", ")})`);
  rec.harness = variant;
  // 모델 어휘는 하네스 소속이다. 이전 하네스의 모델명이 새 어댑터로 넘어가면 무의미한 --model 이 된다
  delete rec.model;
  saveLedger(ledger);
  const r = spawnEntrySync(path.join(rec.path, v.source, v.entry), ["setup"], { encoding: "utf8" });
  return { active: variant, setup: { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() } };
}

export function removePkg(ledger: Ledger, name: string): void {
  delete ledger.packages[name];
  ledger.grants = ledger.grants.filter((g) => g.consumer !== name && g.provider !== name);
  saveLedger(ledger);
}

const bareRef = (ref: string) => ref.replace(/@[^/@]+$/, "");

/** 장부에 들어가는 유일한 문. 스크립트, HTTP, CLI 가 전부 여기를 지난다 */
export function addGrant(ledger: Ledger, g: Grant): void {
  const consumer = ledger.packages[g.consumer];
  const provider = ledger.packages[g.provider];
  if (!consumer) throw new Error(`미설치 consumer: ${g.consumer}`);
  if (!provider) throw new Error(`미설치 provider: ${g.provider}`);
  if (g.tools?.length && g.mission) throw new Error("tools 와 mission 동시 결재 불가");
  if (!g.tools?.length && !g.mission) throw new Error("tools 또는 mission 중 하나는 있어야 합니다");

  // 선언은 신청, 결재는 활성화. 결재는 선언을 넘지 못한다
  const lineage = loadManifest(provider.path).name;
  const declared = (loadManifest(consumer.path).edges ?? []).filter((e) => {
    const ref = String(e.provider ?? "");
    return ref === g.provider || ref === lineage || bareRef(ref) === lineage;
  });
  if (!declared.length) {
    throw new Error(`미선언 edge: ${g.consumer} 의 relay.yaml edges 에 ${lineage} 가 없습니다. 결재는 선언을 넘지 못합니다`);
  }
  if (g.mission && !declared.some((e) => e.mission === g.mission)) {
    const decl = declared.map((e) => e.mission).filter(Boolean).join(", ") || "없음";
    throw new Error(`선언 캡 초과: mission ${g.mission} (선언된 mission: ${decl})`);
  }
  if (g.tools?.length) {
    const allowed = new Set(declared.flatMap((e) => e.tools ?? []));
    const over = g.tools.filter((t) => !allowed.has(t));
    if (over.length) throw new Error(`선언 캡 초과: tools ${over.join(", ")} (선언된 tools: ${[...allowed].join(", ") || "없음"})`);
  }

  const dup = ledger.grants.find(
    (x) => x.consumer === g.consumer && x.provider === g.provider && x.mission === g.mission && JSON.stringify(x.tools) === JSON.stringify(g.tools),
  );
  if (!dup) ledger.grants.push({ consumer: g.consumer, provider: g.provider, tools: g.tools, mission: g.mission });
  saveLedger(ledger);
}

export function removeGrant(ledger: Ledger, g: Grant): void {
  ledger.grants = ledger.grants.filter(
    (x) => !(x.consumer === g.consumer && x.provider === g.provider && x.mission === g.mission),
  );
  saveLedger(ledger);
}

export function resolveProvider(ledger: Ledger, ref: string): string | null {
  if (ledger.packages[ref]) return ref;
  const bare = ref.replace(/@[^/@]+$/, "").replace(/^(@[a-z0-9-]+\/[a-z0-9-]+).*$/, "$1");
  for (const [name, rec] of Object.entries(ledger.packages)) {
    try {
      const m = loadManifest(rec.path);
      if (m.name === bare || m.name === ref) return name;
    } catch {
      continue;
    }
  }
  return null;
}

export function validateDir(dir: string): { ok: boolean; issues: string[] } {
  try {
    const abs = path.resolve(dir);
    const raw = parseYaml(fs.readFileSync(path.join(abs, "relay.yaml"), "utf8")) as Manifest;
    judge(raw, abs);
    return { ok: true, issues: [] };
  } catch (e) {
    if (e instanceof ManifestError) return { ok: false, issues: e.issues };
    return { ok: false, issues: [String(e)] };
  }
}

export function registryData(ledger: Ledger): unknown {
  const packages = Object.entries(ledger.packages).map(([name, rec]) => {
    let manifest: Manifest | null = null;
    let error: string | null = null;
    try {
      manifest = loadManifest(rec.path);
    } catch (e) {
      error = String(e);
    }
    return { name, path: rec.path, workspace: workspacePath(ledger, name), ring: rec.ring ?? null, model: rec.model ?? null, effort: rec.effort ?? null, harness: rec.harness ?? null, manifest, error };
  });
  return { packages, grants: ledger.grants };
}

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { saveLedger, expandHome, workspacePath, RELAY_HOME, type Grant, type Ledger, type PkgOrigin } from "./ledger.ts";
import { loadManifest, judge, activeHarness, disclosure, ManifestError, type Disclosure, type Manifest, type HarnessVariant, listScripts } from "./manifest.ts";
import { pinnedKeys, verifyDigest, type EnvelopeSignature } from "./sign.ts";
import { buildView, buildComponents, componentBundleUrl, componentOutDir, type BuildResult } from "../runtime/view.ts";
import { conformHarness } from "./conform.ts";
import { spawnEntrySync } from "../spawn.ts";
import { ensureBinary, binaryEnv, provisionForVariant, removeBinaries } from "./binaries.ts";
import { vaultGet, vaultSet } from "../vault.ts";
import { sha256File, unpackArtifact } from "./pack.ts";
import { parse as parseYaml } from "yaml";

export interface InstallOpts {
  name?: string;
  ring0?: boolean;
  /** 폴더 결재 — 세션 cwd. 미지정 = 기본 ~/Relay/<이름>. 이 지정이 GUI 폴더 선택의 CLI 형태다 */
  workspace?: string;
  /** dir 서비스 결재 — 선언(신청)을 실제 폴더에 바인딩한다: {서비스이름: 경로}.
   *  "선언은 신청, 활성화는 결재" 의 결재 쓰기 경로(relay install --bind <svc>=<path>). */
  bindings?: Record<string, string>;
}

/**
 * 기판 장기(RELAY_HOME) 안쪽인가. 심링크 하나로 경로 비교를 우회할 수 있으므로 실재하는 가장
 * 깊은 조상까지 올라가 realpath 로 한 번 더 본다 — dirs.ts 의 감금과 같은 판정이다.
 */
function insideRelayHome(p: string): boolean {
  const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + path.sep);
  const abs = path.resolve(expandHome(p));
  const homeReal = (() => {
    try {
      return fs.realpathSync(RELAY_HOME);
    } catch {
      return path.resolve(RELAY_HOME);
    }
  })();
  if (within(abs, path.resolve(RELAY_HOME)) || within(abs, homeReal)) return true;
  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    return within(fs.realpathSync(probe), homeReal);
  } catch {
    return false;
  }
}

const HOME_DIR_REFUSAL = (where: string, p: string): string =>
  `${where}: 기판 장기(${RELAY_HOME}) 안쪽은 dir 로 열 수 없습니다: ${p} — 그 폴더에는 자격(vault)과 ` +
  `장부의 시크릿이 삽니다. 동사가 그 폴더를 ctx.service 로 열 수 있으므로, 여기 구멍이 나면 ` +
  `담장이 한 축에서만 서게 됩니다. 기판 상태는 판정을 지나는 동사로만 바뀝니다 — 필요한 것이 있으면 ` +
  `ring-0 결재를 받아 host 브리지 동사로 받으세요`;

/**
 * dir 결재면 전체의 판정 — 선언(신청)과 결재(--bind) 둘 다 본다.
 *
 * ① 결재는 선언을 초과할 수 없다: 선언된 dir 서비스 이름만, 경로는 ~ 또는 절대(.. 금지).
 * ② 기판 장기 안쪽은 열 수 없다. `~` 선언과 바인딩 값만 본다 — **상대경로 선언은 보지 않는다**:
 *    그건 패키지 트리 안이고, 트리가 어디 앉는지는 기판의 일이다(발행본은 ~/.relay/releases/
 *    <이름>/<버전> 에 산다. 여기까지 막으면 상대 dir 을 선언한 모든 발행본이 설치 불가가 된다).
 *    이 판정이 매니페스트 judge 가 아니라 설치에 사는 이유도 같다 — RELAY_HOME 은 인스턴스
 *    설정이라 문법 판정이 알아서는 안 되고, 설치는 이미 안다.
 */
export function judgeDirGrants(m: Manifest, bindings: Record<string, string> | undefined): Record<string, string> | undefined {
  const dirSvcs = new Set((m.services ?? []).filter((s) => "dir" in s && s.dir != null).map((s) => s.name));
  for (const s of m.services ?? []) {
    if (!("dir" in s) || s.dir == null || !s.dir.startsWith("~")) continue;
    if (insideRelayHome(s.dir)) throw new ManifestError([HOME_DIR_REFUSAL(`services[${s.name}].dir`, s.dir)]);
  }
  if (!bindings || !Object.keys(bindings).length) return undefined;
  const out: Record<string, string> = {};
  for (const [name, p] of Object.entries(bindings)) {
    if (!dirSvcs.has(name)) throw new ManifestError([`--bind ${name}: 선언된 dir 서비스가 아닙니다 — 결재는 선언을 초과할 수 없습니다`]);
    if (!/^(~($|\/)|\/)/.test(p) || p.split("/").includes("..")) throw new ManifestError([`--bind ${name}: ~ 또는 절대경로만(.. 금지): ${p}`]);
    if (insideRelayHome(p)) throw new ManifestError([HOME_DIR_REFUSAL(`--bind ${name}`, p)]);
    out[name] = p;
  }
  return out;
}

export interface InstallResult {
  name: string;
  manifest: Manifest;
  /** 후보들의 setup 점검 결과. ok = 쓸 수 있는 하네스를 하나라도 골랐다 */
  setup?: { ok: boolean; out: string };
  build?: BuildResult;
}

/** requires 실체 판정. 기판은 안내(install)만 전하고 대신 설치하지 않는다 */
export function judgeRequires(m: Manifest, pkgName: string): void {
  const r = m.requires;
  if (!r) return;
  const issues: string[] = [];
  if (r.os?.length && !(r.os as string[]).includes(process.platform)) {
    issues.push(`requires os: ${process.platform} 미지원 (요구: ${r.os.join(", ")})`);
  }
  // requires 는 AND 다 — 설치가 끝나면 목록 전부가 실재한다. 레시피(manager+package) 있는
  // 항목은 없을 때 기판이 채우고(ensureBinary ④), 레시피 없는 항목은 안내와 함께 거부한다.
  // 채우다 실패한 것도 거부다: "기판이 대준다" 는 선언이 조용히 빈 약속이 되면 안 된다.
  for (const b of r.binaries ?? []) {
    const t = ensureBinary(pkgName, b);
    if (!t.ok) issues.push(t.out);
  }
  const appRoots = ["/Applications", path.join(os.homedir(), "Applications"), "/System/Applications"];
  for (const a of r.apps ?? []) {
    if (!appRoots.some((root) => fs.existsSync(path.join(root, a.name + ".app")))) {
      issues.push(`requires app 없음: ${a.name}.app${a.install ? ` (설치: ${a.install})` : ""}`);
    }
  }
  if (issues.length) throw new ManifestError(issues);
}

/** 하네스 계약 검사 — 어댑터 동사를 실제 실행한다. 위반이면 fail-loud (장부 기록 전에 불러야 한다) */
function judgeConform(pkgPath: string, m: Manifest): void {
  const broken = (m.harness?.variants ?? [])
    .map((v) => conformHarness(pkgPath, v))
    .filter((r) => !r.ok)
    .map((r) => `${r.variant}: ` + r.checks.filter((c) => !c.ok).map((c) => `${c.verb} — ${c.note}`).join(" / "));
  if (broken.length) {
    throw new ManifestError(["하네스 계약 위반 (relay harness-check 로 재현):", ...broken]);
  }
}

/** variant 전수 setup 을 돌려 쓸 수 있는 하네스를 선출한다 — installPkg 과 activatePrepared 공용 */
function electHarness(pkgName: string, pkgPath: string, m: Manifest): { picked: string | null; out: string } | null {
  const variants = m.harness?.variants ?? [];
  if (!variants.length) return null;
  const reports: string[] = [];
  let picked: string | null = null;
  for (const v of variants) {
    // Windows 에서는 엔트리 확장자 해석이 필요하다 — 이 레포의 어댑터 실행 규약(spawnEntrySync)을 따른다
    const entry = path.join(pkgPath, v.source, v.entry);
    const setup = () => spawnEntrySync(entry, ["setup"], { encoding: "utf8", env: binaryEnv(pkgName) });
    // 실행 파일 실재는 judgeRequires 가 이미 보장했다(AND — 레시피 항목은 기판이 채운다).
    // 여기 남은 판정은 준비 상태(자격·로그인)와, 존재 검사가 못 거르는 껍데기 설치뿐이다.
    let r = setup();
    let note = "";
    if (r.status !== 0) {
      // setup 실패 + 변형이 requires 를 참조 — "있는데 안 도는" 부류(네이티브 바이너리 빠진
      // npm 래퍼 실사고)일 수 있다. 참조된 레시피를 기판 사본으로 강제 승격하고 한 번 재시도.
      const t = provisionForVariant(pkgName, m, v.binary);
      if (t) {
        note = ` · ${t.out}`;
        if (t.ok) r = setup();
      }
    }
    const out = ((r.stdout ?? "") + (r.stderr ?? "")).trim();
    reports.push(`${v.name}: ${r.status === 0 ? "준비됨" : "불가"} — ${out}${note}`);
    if (r.status === 0 && !picked) picked = v.name;
  }
  return { picked, out: reports.join("\n") };
}

export async function installPkg(ledger: Ledger, dir: string, opts: InstallOpts = {}): Promise<InstallResult> {
  const abs = path.resolve(dir);
  const m = loadManifest(abs);
  const name = opts.name ?? path.basename(abs);
  judgeRequires(m, name); // 장부에 기록되기 전에 fail-loud — 레시피 항목은 여기서 기판이 채운다

  // 계약 적합성은 설치 게이트다. 도구 미설치(환경 미비)와 계약 위반(어댑터 결함)은 다른 축이라
  // conform 은 setup 실패를 위반으로 세지 않는다 — 여기서 막히는 것은 잘못 만든 어댑터뿐이다.
  // 장부 기록 전에 던져야 거부된 패키지가 등재된 채 남지 않는다(judgeRequires 와 같은 자리)
  judgeConform(abs, m);
  // components edge 는 빌드 의존 — 미해결(미설치 provider·제공 선언 없음·범위 밖)이면
  // 장부 기록 전에 fail-loud (judgeRequires 와 같은 자리)
  const components = resolveComponentEdges(ledger, m);

  // 재설치는 결재·설정(ring, workspace, model, effort, harness, dirBindings)을 보존한다.
  // 레코드를 통째로 갈면 ring-0 이 조용히 증발한다 — draft.ts 의 publishDraft 와 같은 계약
  const prev = ledger.packages[name];
  const bindings = judgeDirGrants(m, opts.bindings);
  ledger.packages[name] = {
    ...(prev ?? {}),
    path: abs,
    ...(opts.workspace ? { workspace: path.resolve(expandHome(opts.workspace)) } : {}),
    ...(opts.ring0 ? { ring: 0 as const } : {}),
    // dir 결재는 누적 병합 — 재설치가 기존 결재를 증발시키지 않는다(ring 보존과 같은 계약)
    ...(bindings ? { dirBindings: { ...(prev?.dirBindings ?? {}), ...bindings } } : {}),
  };
  saveLedger(ledger);
  let setup: { ok: boolean; out: string } | undefined;
  const variants = m.harness?.variants ?? [];
  const current = ledger.packages[name].harness;
  // 활성 하네스가 새 선언에 살아 있으면 사용자의 선택을 존중하고, 없으면 선출한다
  if (variants.length && (!current || !variants.some((v) => v.name === current))) {
    const elected = electHarness(name, abs, m)!;
    ledger.packages[name].harness = elected.picked ?? variants[0].name;
    saveLedger(ledger);
    setup = { ok: elected.picked != null, out: `활성 하네스: ${ledger.packages[name].harness}\n` + elected.out };
  }
  // 결재는 해석의 결과다 — 장부 등재 뒤에 앉힌다(addGrant 는 consumer 의 장부 실재를 요구한다)
  recordComponentGrants(ledger, name, components);
  const build = await buildSurfaces(name, abs, m);
  return { name, manifest: m, setup, build };
}

// ── 아티팩트 설치: 준비(정적)와 활성(실행)의 분리 ────────────────────────────
// 마켓에서 오는 패키지는 모르는 사람의 코드다. 동의 전에는 한 줄도 실행하지 않는다 —
// prepare 는 봉인 검증·전개·판정·고지서 계산까지(전부 정적), activate 가 그 선을 넘는다
// (conform·setup·빌드·장부). 장부 기록이 activate 에 있는 것이 계약이다: 동의하지 않은
// 패키지는 장부에 남지 않는다.

function lineageOf(rec: { path: string }): string | null {
  try {
    return loadManifest(rec.path).name;
  } catch {
    return null;
  }
}

/** 두 트리의 내용 동일성 (.relay-digest 표식은 제외). 릴리스는 KB 급이라 전량 대조가 싸다 */
function sameTree(a: string, b: string): boolean {
  const list = (root: string, rel = ""): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (r === ".relay-digest") continue;
      if (e.isDirectory()) out.push(...list(root, r));
      else if (e.isFile()) out.push(r);
    }
    return out.sort();
  };
  const la = list(a);
  const lb = list(b);
  if (la.length !== lb.length || la.some((p, i) => p !== lb[i])) return false;
  return la.every((p) => {
    const fa = fs.readFileSync(path.join(a, p));
    const fb = fs.readFileSync(path.join(b, p));
    return fa.equals(fb);
  });
}

/**
 * 설치 이름 결정. 장부 키는 로컬 사정(디렉토리 이름)이라 @alice/todo 와 @bob/todo 가 같은
 * "todo" 를 두고 부딪칠 수 있다 — 그 충돌을 여기서 해소한다. 같은 ref 의 기존 설치는 충돌이
 * 아니라 업데이트다.
 */
export function resolveInstallName(ledger: Ledger, ref: string, explicit?: string): { name: string; fresh: boolean } {
  if (explicit) {
    const rec = ledger.packages[explicit];
    if (!rec) return { name: explicit, fresh: true };
    const cur = rec.origin?.ref ?? lineageOf(rec);
    if (cur !== ref) throw new Error(`이미 있는 설치 이름: ${explicit} (${cur ?? "출처 불명"}) — 다른 --name 을 지정하세요`);
    return { name: explicit, fresh: false };
  }
  for (const [name, rec] of Object.entries(ledger.packages)) {
    if (rec.origin?.ref === ref) return { name, fresh: false };
  }
  const short = ref.split("/")[1] ?? ref.replace(/^@/, "");
  const shortRec = ledger.packages[short];
  if (!shortRec) return { name: short, fresh: true };
  if (lineageOf(shortRec) === ref) return { name: short, fresh: false }; // 같은 혈통의 로컬 설치 — 그 자리를 잇는다
  const scoped = ref.replace(/^@/, "").replace(/\//g, "-");
  const scopedRec = ledger.packages[scoped];
  if (!scopedRec) return { name: scoped, fresh: true };
  if (lineageOf(scopedRec) === ref) return { name: scoped, fresh: false };
  throw new Error(`설치 이름 충돌: ${short} 와 ${scoped} 가 모두 다른 패키지입니다 — --name 으로 지정하세요`);
}

export interface Prepared {
  /** API 왕복용 토큰. CLI 는 쓰지 않는다 */
  id: string;
  name: string;
  fresh: boolean;
  ref: string;
  version: string;
  digest: string;
  size: number;
  /** 릴리스 자리(~/.relay/releases/<이름>/<버전>)에 이미 전개된 경로 */
  dir: string;
  registry: string | null;
  manifest: Manifest;
  disclosure: Disclosure;
  /** 발행 키 사인이 검증됐는가 — null = 무서명(미고정 기판에서만 허용) */
  signed: boolean;
}

/**
 * 아티팩트 준비. 봉인 검증 -> 임시 전개 -> 매니페스트 판정 -> requires 실체 판정 ->
 * 이름 결정 -> 릴리스 자리로 이동 -> 고지서 계산. 패키지 코드는 실행되지 않는다.
 * 릴리스는 불변이라 같은 버전 자리에 다른 내용이 오면 거부한다 (.relay-digest 로 대조).
 */
export function prepareArtifact(
  ledger: Ledger,
  file: string,
  opts: { name?: string; digest?: string; registry?: string | null; signature?: EnvelopeSignature } = {},
): Prepared {
  const abs = path.resolve(expandHome(file));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`없는 아티팩트: ${file}`);
  const digest = sha256File(abs);
  if (opts.digest && opts.digest !== digest) {
    throw new Error(`봉인 불일치: 기대 ${opts.digest}\n  실제 ${digest} — 아티팩트를 다시 받으세요`);
  }
  // 서명 — 봉인(무결)과 다른 축(발행 주체). 사이드카(<file>.sig) 또는 스토어 엔트리로 온다.
  // RELAY_PUBKEYS 로 발행 키를 고정한 기판은 무서명·미지 키·불일치 전부 fail-loud,
  // 미고정 기판은 있으면 검증해 표시만 한다(사이드로드 동의 화면의 정직함).
  let signature = opts.signature;
  if (!signature && fs.existsSync(abs + ".sig")) {
    try {
      signature = JSON.parse(fs.readFileSync(abs + ".sig", "utf8"));
    } catch { /* 깨진 사이드카 — 무서명으로 취급(고정 기판이면 아래서 거부) */ }
  }
  const pinned = pinnedKeys();
  let signed = false;
  if (pinned) {
    if (!signature) throw new Error("서명 없는 봉투 — 이 기판은 RELAY_PUBKEYS 로 발행 키를 고정했습니다");
    if (!pinned.includes(signature.pub)) throw new Error("고정 키셋에 없는 발행 키 — 봉투를 신뢰할 수 없습니다");
    if (!verifyDigest(digest, signature)) throw new Error("서명 검증 실패 — 봉인과 사인이 맞지 않습니다");
    signed = true;
  } else if (signature) {
    signed = verifyDigest(digest, signature);
  }
  const staging = fs.mkdtempSync(path.join(RELAY_HOME, "run", "prepare-"));
  try {
    unpackArtifact(abs, staging);
    const m = loadManifest(staging); // 판정 실패는 여기서 fail-loud
    const { name, fresh } = resolveInstallName(ledger, m.name, opts.name);
    judgeRequires(m, name);
    const dest = path.join(RELAY_HOME, "releases", name, m.version);
    const digestFile = path.join(dest, ".relay-digest");
    if (fs.existsSync(dest)) {
      const prev = fs.existsSync(digestFile) ? fs.readFileSync(digestFile, "utf8").trim() : null;
      if (prev === digest) {
        fs.rmSync(staging, { recursive: true, force: true }); // 같은 봉인 — 기존 스냅샷 재사용
      } else if (prev === null && sameTree(staging, dest)) {
        // 봉인 기록이 없는 릴리스 = 아티팩트 이전 시대의 로컬 발행본. 저자 컴퓨터에서
        // 자기 발행본과 스토어 설치가 같은 자리를 두고 만나는 흔한 경우다 — 내용이
        // 같음이 증명되면 그 자리를 입양한다. 불변 원칙은 지켜진다: 바뀌는 건 표식뿐이다
        fs.writeFileSync(digestFile, digest + "\n");
        fs.rmSync(staging, { recursive: true, force: true });
      } else {
        throw new Error(
          `이미 있는 릴리스: ${name}@${m.version} — 릴리스는 불변입니다. ` +
          `같은 버전에 다른 내용이 왔습니다 (기존: ${prev ?? "봉인 기록 없는 로컬 발행본"}). 버전을 올려 다시 구우세요`,
        );
      }
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(staging, dest);
      fs.writeFileSync(digestFile, digest + "\n");
    }
    return {
      id: crypto.randomBytes(12).toString("hex"),
      name,
      fresh,
      ref: m.name,
      version: m.version,
      digest,
      size: fs.statSync(abs).size,
      dir: dest,
      registry: opts.registry ?? null,
      manifest: m,
      disclosure: disclosure(m),
      signed,
    };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/**
 * 굽는 표면 전부 — components(수출) 먼저, view(화면) 다음. 하나라도 실패하면 그 실패가 결과다.
 * 순서가 계약이다: 자기 번들이 먼저 서야 자기 화면이 그것을 마운트할 수 있다.
 *
 * base = view 발행물이 달아야 할 접두사. 미지정이면 설치본 좌표(/pkg/<이름>/view)다.
 * 작업 사본을 미리보기로 구울 때만 다른 값이 온다 — 같은 트리를 두 좌표로 구울 수는 없으므로
 * 미리보기 굽기와 발행 굽기는 서로의 산출을 덮는다(작업 사본의 out 은 스냅샷에서 빠지는
 * 임시물이라 무해하다: buildOutSkip · publish 가 다시 굽는다).
 */
export async function buildSurfaces(pkg: string, dir: string, m: Manifest, base?: string): Promise<BuildResult | undefined> {
  const comp = await buildComponents(dir, m);
  if (comp && !comp.ok) return comp;
  const view = await buildView(pkg, dir, m, base);
  if (view && !view.ok) return view;
  if (!comp && !view) return undefined;
  return { ok: true, out: [comp?.out, view?.out].filter(Boolean).join("\n") };
}

/**
 * 준비된 패키지의 활성. 여기서 처음 패키지 코드가 실행된다(conform·setup·빌드).
 * 순서가 계약이다: conform -> 빌드 -> 장부. 빌드 실패는 설치 실패다 — 깨진 화면으로
 * "설치 성공" 을 만들지 않는다. 장부 반영은 전부 통과한 뒤 한 번이라 실패해도 장부는 무결하다.
 * 업데이트는 rec.path 만 갈아 끼운다 — ring·workspace·model·harness 는 결재·설정이라 보존
 * (publishDraft 와 같은 계약).
 */
export async function activatePrepared(ledger: Ledger, p: Prepared, opts: InstallOpts = {}): Promise<InstallResult> {
  const m = p.manifest;
  judgeConform(p.dir, m);
  const components = resolveComponentEdges(ledger, m);
  const build = await buildSurfaces(p.name, p.dir, m);
  if (build && !build.ok) {
    throw new Error(`빌드 실패 — 설치를 중단합니다 (릴리스는 ${p.dir} 에 남아 있습니다):\n${build.out}`);
  }

  const origin: PkgOrigin = {
    registry: p.registry,
    ref: p.ref,
    version: p.version,
    digest: p.digest,
    installedAt: new Date().toISOString(),
  };
  const existing = ledger.packages[p.name];
  const bindings = judgeDirGrants(m, opts.bindings);
  if (existing) {
    existing.path = p.dir;
    existing.origin = origin;
    if (opts.workspace) existing.workspace = path.resolve(expandHome(opts.workspace));
    if (bindings) existing.dirBindings = { ...(existing.dirBindings ?? {}), ...bindings };
  } else {
    ledger.packages[p.name] = {
      path: p.dir,
      origin,
      ...(opts.workspace ? { workspace: path.resolve(expandHome(opts.workspace)) } : {}),
      ...(opts.ring0 ? { ring: 0 as const } : {}),
      ...(bindings ? { dirBindings: bindings } : {}),
    };
  }
  // 활성 하네스가 새 선언에 살아 있으면 사용자의 선택을 존중하고, 없으면 재선출한다
  let setup: { ok: boolean; out: string } | undefined;
  const variants = m.harness?.variants ?? [];
  const current = ledger.packages[p.name].harness;
  if (variants.length && (!current || !variants.some((v) => v.name === current))) {
    const elected = electHarness(p.name, p.dir, m)!;
    ledger.packages[p.name].harness = elected.picked ?? variants[0].name;
    setup = { ok: elected.picked != null, out: `활성 하네스: ${ledger.packages[p.name].harness}\n` + elected.out };
  }
  saveLedger(ledger);
  // 장부 등재 뒤에 결재를 앉힌다 — addGrant 는 consumer 의 장부 실재를 요구한다
  recordComponentGrants(ledger, p.name, components);
  return { name: p.name, manifest: m, setup, build: build ?? undefined };
}

export async function buildPkg(ledger: Ledger, name: string): Promise<BuildResult> {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  const components = resolveComponentEdges(ledger, m);
  recordComponentGrants(ledger, name, components); // 재빌드 자가치유 — addGrant 는 중복 무해
  const build = await buildSurfaces(name, rec.path, m);
  return build ?? { ok: true, out: "surfaces.{view,components}.out 미선언 — 빌드 없이 source 를 그대로 서빙합니다" };
}

// env 를 선언한 자격형은 자격이 기판 손(vault)에 있다 — 동사 실행에도 세션과 같은 주입을
// 해줘야 setup 이 "연결 후에도 미준비" 로 거짓말하지 않는다 (kind 무관 — 스폰과 같은 규율)
function llmEnv(v: HarnessVariant, pkg?: string): NodeJS.ProcessEnv {
  // 기판이 대는 도구가 있으면 그것이 먼저다 — 호스트의 같은 이름 전역 설치보다 앞
  const env: NodeJS.ProcessEnv = pkg ? { ...binaryEnv(pkg) } : { ...process.env };
  if (v.llm?.auth?.env) {
    // §8-2 잔여: llmEnv 는 동기 하네스 동사 체인(harnessVerb·probeHarness·electHarness) 깊숙이
    // 있어 비동기 authority.credential 로의 이사가 시그니처 연쇄를 일으킨다 — vault 직독으로 남는다
    const cred = vaultGet(`llm/${v.llm.provider}`);
    if (cred) env[v.llm.auth.env] = cred;
  }
  return env;
}

/** variant 를 주면 활성이 아닌 선언 변형에도 묻는다(모델 피커가 공급자 호버로 그 카탈로그를
 *  미리 보는 자리, §5.5-29) — 조회일 뿐 장부는 건드리지 않는다. 미선언 이름은 거부. */
export function harnessVerb(ledger: Ledger, name: string, verb: "models" | "info" | "setup" | "commands", variant?: string): { ok: boolean; out: string } {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  const v = variant ? ((m.harness?.variants ?? []).find((x) => x.name === variant) ?? null) : activeHarness(m, rec.harness);
  if (!v) throw new Error(variant ? `미선언 하네스: ${variant}` : `하네스 미동봉 패키지: ${name}`);
  const r = spawnEntrySync(path.join(rec.path, v.source, v.entry), [verb], { encoding: "utf8", env: llmEnv(v, name) });
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
    // 조회는 설치하지 않는다 — 다이얼로그를 여는 행위가 수백 MB 를 받아선 안 된다.
    // 기판 사본이 있으면 PATH 앞이라 그것이 쓰이고, 없으면 호스트 도구로 판정된다.
    const env = llmEnv(v, name);
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
  // §8-2 잔여: llmEnv 와 같은 사유(동기 체인) — setCredential 이사 보류
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
  const info = spawnEntrySync(entry, ["info"], { encoding: "utf8", env: binaryEnv(name) });
  let verbs: string[] = [];
  try {
    verbs = JSON.parse(info.stdout || "{}").verbs ?? [];
  } catch { /* info 미구현 어댑터 — 아래에서 거부 */ }
  if (!verbs.includes("login")) {
    throw new Error(`이 하네스(${v.name})는 login 동사를 제공하지 않습니다 — 자격 연결은 relay connect llm ${v.llm?.provider ?? "<provider>"} 로 하세요`);
  }
  const r = spawnEntrySync(entry, ["login", ...args], { stdio: "inherit", env: binaryEnv(name) });
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
  const info = spawnEntrySync(entry, ["info"], { encoding: "utf8", env: binaryEnv(name) });
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
  // 전환도 선출과 같은 계약이다 — setup 실패가 "있는데 안 도는" 부류면 참조된 requires
  // 레시피를 기판 사본으로 승격하고 한 번 재시도한다(껍데기 npm 래퍼 실사고의 회복 경로).
  const entry = path.join(rec.path, v.source, v.entry);
  const run = () => spawnEntrySync(entry, ["setup"], { encoding: "utf8", env: binaryEnv(name) });
  let r = run();
  let note = "";
  if (r.status !== 0) {
    const t = provisionForVariant(name, m, v.binary);
    if (t) {
      note = t.ok ? "" : `\n${t.out}`;
      if (t.ok) r = run();
    }
  }
  return { active: variant, setup: { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim() + note } };
}

export function removePkg(ledger: Ledger, name: string): void {
  // 기판이 깐 도구 사본도 함께 — 남기면 ~/.relay 가 지운 패키지의 CLI 를 계속 품는다
  removeBinaries(name);
  delete ledger.packages[name];
  ledger.grants = ledger.grants.filter((g) => g.consumer !== name && g.provider !== name);
  saveLedger(ledger);
}

const bareRef = (ref: string) => ref.replace(/@[^/@]+$/, "");

// ── components edge 해석 — 마운트 주소의 활성화 ──────────────────────────────
// edges[].components 는 제공자의 자립 번들을 소비자 화면이 마운트하겠다는 선언이다. 해석은
// 설치 시점에 한 번: 제공 선언·버전 범위·번들 실재를 판정하고 결재를 장부에 앉힌다. 집행은
// 서빙이다 — 소비자 문서에 결재대로 import map 을 심는다(componentImportsFor).
// 실패는 전부 fail-loud: 선언 없는 소비, 미설치 provider, 범위 밖 버전, 안 구워진 번들.

/** 최소 semver 비교 — prerelease 무시(범위 판정에 충분) */
function cmpSemver(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** provider 좌표 범위 절 판정. 레지스트리 해석기가 없는 기판이라 어휘를 닫는다 — 미지 문법은 fail-loud */
function satisfiesRange(version: string, range: string | null): boolean {
  if (!range || range === "*") return true;
  const norm = (r: string) => {
    const p = r.split(".").map((x) => parseInt(x, 10) || 0);
    return `${p[0] ?? 0}.${p[1] ?? 0}.${p[2] ?? 0}`;
  };
  if (range.startsWith("^")) {
    const base = norm(range.slice(1));
    if (cmpSemver(version, base) < 0) return false;
    // ^ 의 상한은 "가장 왼쪽의 0 아닌 자리"가 유지되는 범위다(npm semver 와 같은 규칙):
    // ^1.2.3 은 <2.0.0, ^0.2.3 은 **<0.3.0**, ^0.0.3 은 <0.0.4. 초기 패키지는 전부 0.x 라
    // major 만 보면 0.2.3 → 0.3.0 같은 breaking 판이 조용히 통과한다
    const [bMaj, bMin, bPatch] = base.split(".").map(Number);
    const v = version.split("-")[0].split(".").map(Number);
    if (bMaj > 0) return v[0] === bMaj;
    if (bMin > 0) return v[0] === 0 && v[1] === bMin;
    return v[0] === 0 && v[1] === 0 && v[2] === bPatch;
  }
  if (range.startsWith("~")) {
    const base = norm(range.slice(1));
    const [maj, min] = base.split(".");
    const v = version.split(".");
    return v[0] === maj && v[1] === min && cmpSemver(version, base) >= 0;
  }
  if (range.startsWith(">=")) return cmpSemver(version, norm(range.slice(2))) >= 0;
  if (/^\d+\.\d+\.\d+/.test(range)) return cmpSemver(version, range) === 0;
  throw new ManifestError([`components edge 범위 문법 미지원: ${range} — * · ^x.y.z · ~x.y.z · >=x.y.z · 정확 버전만`]);
}

/** components edge 해석의 결과 — 결재 대상과 사람이 읽을 기록. 번들은 제공자 트리에 이미
 *  구워져 있으므로(surfaces.components.out) 소비자 빌드로 나를 것이 없다 */
export interface ComponentResolution {
  grants: string[];
  notes: string[];
}

export function resolveComponentEdges(ledger: Ledger, m: Manifest): ComponentResolution {
  const grants: string[] = [];
  const notes: string[] = [];
  for (const e of m.edges ?? []) {
    if (e.components !== true) continue;
    const bare = bareRef(e.provider);
    const range = e.provider.length > bare.length ? e.provider.slice(bare.length + 1) : null;
    const installed = resolveProvider(ledger, bare);
    if (!installed) {
      throw new ManifestError([`components edge 미해결: ${bare} 가 설치되어 있지 않습니다 — 제공 패키지를 먼저 설치하세요`]);
    }
    const pm = loadManifest(ledger.packages[installed].path);
    const comp = pm.surfaces?.components;
    if (!comp) {
      throw new ManifestError([`components edge 거부: ${bare} 는 surfaces.components 를 선언하지 않습니다 — 소비는 제공 선언을 넘지 못합니다`]);
    }
    if (!satisfiesRange(pm.version, range)) {
      throw new ManifestError([`components edge 버전 불일치: ${bare}@${pm.version} 는 선언 범위 ${range} 를 만족하지 않습니다`]);
    }
    // 번들 실재 판정 — 소비자 화면이 마운트할 파일 하나가 지금 있어야 한다
    const entry = path.join(componentOutDir(ledger.packages[installed].path, pm)!, "index.js");
    if (!fs.existsSync(entry)) {
      throw new ManifestError([`components edge 미해결: ${bare} 의 번들이 없습니다 (${comp.source}/${comp.out ? comp.out + "/" : ""}index.js) — relay build ${installed}`]);
    }
    grants.push(installed);
    notes.push(`${pm.name}@${pm.version} ← ${installed}`);
  }
  return { grants, notes };
}

/** 해석 성공 = components 활성화 — 결재를 장부에 앉힌다(addGrant 의 선언 캡·중복 판정을 그대로 지난다) */
function recordComponentGrants(ledger: Ledger, consumer: string, resolution: ComponentResolution): void {
  for (const provider of resolution.grants) {
    addGrant(ledger, { consumer, provider, components: true });
  }
}

/** 장부에 들어가는 유일한 문. 스크립트, HTTP, CLI 가 전부 여기를 지난다 */
export function addGrant(ledger: Ledger, g: Grant): void {
  const consumer = ledger.packages[g.consumer];
  const provider = ledger.packages[g.provider];
  if (!consumer) throw new Error(`미설치 consumer: ${g.consumer}`);
  if (!provider) throw new Error(`미설치 provider: ${g.provider}`);
  const forms = [g.tools?.length ? 1 : 0, g.mission ? 1 : 0, g.components ? 1 : 0].reduce((a, b) => a + b, 0);
  if (forms !== 1) throw new Error("tools · mission · components 중 정확히 하나를 결재해야 합니다");

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
    // raw 전용 도구(provider 의 동사가 아니라 원격 MCP 서버의 도구)는 agent_access: full 이 있어야
    // 결재된다. 결재 시점이 fail-loud 의 자리다 — 판정은 provider 를 모르고(미설치일 수 있다),
    // 실행 시점은 이미 늦다(세션이 목록에 없는 도구를 찾는다)
    const pm = loadManifest(provider.path);
    const scripts = new Set(listScripts(provider.path, pm));
    const raw = new Set((pm.services ?? []).flatMap((s) => ("url" in s && s.url != null ? s.tools ?? [] : [])));
    const rawOnly = g.tools.filter((t) => !scripts.has(t) && raw.has(t));
    if (rawOnly.length && !declared.some((e) => e.tools && e.agent_access === "full")) {
      throw new Error(
        `raw 도구 결재 불가: ${rawOnly.join(", ")} 는 ${lineage} 의 동사가 아니라 원격 MCP 서버의 도구입니다 — ` +
        `에이전트가 raw 로 만지게 하려면 ${g.consumer} 의 edges 항목에 agent_access: full 을 선언하세요(기본 scripts-only)`,
      );
    }
  }
  if (g.components && !declared.some((e) => e.components === true)) {
    throw new Error(`선언 캡 초과: components (${g.consumer} 의 edges 에 components 선언 없음)`);
  }

  const dup = ledger.grants.find(
    (x) =>
      x.consumer === g.consumer && x.provider === g.provider && x.mission === g.mission &&
      JSON.stringify(x.tools) === JSON.stringify(g.tools) && (x.components ?? false) === (g.components ?? false),
  );
  if (!dup) {
    ledger.grants.push({ consumer: g.consumer, provider: g.provider, tools: g.tools, mission: g.mission, ...(g.components ? { components: true } : {}) });
  }
  saveLedger(ledger);
}

export function removeGrant(ledger: Ledger, g: Grant): void {
  ledger.grants = ledger.grants.filter(
    (x) => !(x.consumer === g.consumer && x.provider === g.provider && x.mission === g.mission),
  );
  saveLedger(ledger);
}

/**
 * 소비자가 이 provider 에 선언한 에이전트 접근 축 — tools 형 항목 중 하나라도 full 이면 full.
 * 미선언 = scripts-only: raw 노출은 명시 opt-in 만이다(기본 반전 — relayos normalizeAgentAccess 와
 * 같은 규율). 세션 문의 목록(tools.ts)과 집행(callEdgeTool)·결재(addGrant)가 같은 답을 본다.
 */
export function edgeAgentAccess(ledger: Ledger, consumer: string, provider: string): "scripts-only" | "full" {
  const c = ledger.packages[consumer];
  const p = ledger.packages[provider];
  if (!c || !p) return "scripts-only";
  let lineage: string;
  try {
    lineage = loadManifest(p.path).name;
  } catch {
    return "scripts-only";
  }
  const entries = (loadManifest(c.path).edges ?? []).filter((e) => {
    const ref = String(e.provider ?? "");
    return ref === provider || ref === lineage || bareRef(ref) === lineage;
  });
  return entries.some((e) => e.tools && e.agent_access === "full") ? "full" : "scripts-only";
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
    return { name, path: rec.path, workspace: workspacePath(ledger, name), ring: rec.ring ?? null, model: rec.model ?? null, effort: rec.effort ?? null, harness: rec.harness ?? null, origin: rec.origin ?? null, manifest, error };
  });
  return { packages, grants: ledger.grants };
}

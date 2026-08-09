import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, parseDocument } from "yaml";
import { RELAY_HOME, saveLedger, type Ledger } from "./state.ts";
import { loadManifest, judge, ManifestError, type Manifest } from "./manifest.ts";
import { conformHarness } from "./conform.ts";
import { spawnEntrySync } from "./entry.ts";
import { judgeRequires, validateDir } from "./installer.ts";
import { buildView, type BuildResult } from "./build.ts";

// 수정 레이어. 설치본(장부 path)은 실행 중인 바이너리라 직접 만지지 않는다 — 런타임이 매 요청
// loadManifest(rec.path) 를 읽으므로 반쯤 저장된 매니페스트가 그대로 노출된다. 편집은 전부
// draft(작업 사본)에 쌓이고, publish 가 판정을 통과한 스냅샷을 releases 에 뜬 뒤 장부 path 를
// 갈아 끼운다. 참조 전환이라 원자적이고, 실패하면 실행본은 마지막 릴리스 그대로 돈다.
//   ~/.relay/drafts/<이름>/            작업 사본 (git 저장소 — 이력·diff·되돌리기)
//   ~/.relay/releases/<이름>/<버전>/   불변 스냅샷 (장부 path 가 이 중 하나를 가리킨다)

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// 스냅샷·사본에서 항상 빼는 것: git 내부, 의존성(설치·빌드가 다시 깐다), 프레임워크 캐시
const COPY_SKIP = new Set([".git", "node_modules", ".next"]);

export function draftPath(name: string): string {
  return path.join(RELAY_HOME, "drafts", name);
}

function releasesPath(name: string): string {
  return path.join(RELAY_HOME, "releases", name);
}

function assertSlug(name: string): void {
  if (!SLUG.test(name ?? "")) throw new Error(`이름 형식 위반: ${name}`);
}

// draft 파일 경로 봉인. .git 은 기판 소유 장부라 에이전트·GUI 쓰기가 닿으면 안 된다
// (훅 스크립트를 심는 경로가 되기 때문). startsWith(root)만으로는 이름이 접두인 형제가 통과한다
function sealed(root: string, rel: string): string {
  const target = path.normalize(path.join(root, rel));
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`경로 탈출: ${rel}`);
  if (path.relative(root, target).split(path.sep).includes(".git")) throw new Error(`git 내부 경로 금지: ${rel}`);
  return target;
}

function git(dir: string, ...args: string[]): { ok: boolean; out: string; raw: string } {
  const r = spawnSync("git", ["-c", "user.name=relay", "-c", "user.email=relay@local", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
  if (r.error) throw new Error(`git 실행 불가 — 수정 레이어는 git 이 필요합니다 (${r.error.message})`);
  // porcelain 파싱은 raw 를 쓴다 — trim 이 첫 줄의 상태 열(선행 공백)을 잘라 경로가 한 글자 먹힌다
  return { ok: r.status === 0, out: ((r.stdout ?? "") + (r.stderr ?? "")).trim(), raw: r.stdout ?? "" };
}

function copyTree(from: string, to: string, extraSkip: string[] = []): void {
  const skipAbs = extraSkip.map((p) => path.normalize(path.join(from, p)));
  fs.cpSync(from, to, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(from, src);
      if (rel === "") return true;
      if (rel.split(path.sep).some((seg) => COPY_SKIP.has(seg))) return false;
      const abs = path.normalize(src);
      return !skipAbs.some((s) => abs === s || abs.startsWith(s + path.sep));
    },
  });
}

// surfaces.view.out 은 빌드 산출물이라 사본·스냅샷에서 뺀다 (publish 가 다시 굽는다)
function viewOutSkip(root: string): string[] {
  try {
    const m = parseYaml(fs.readFileSync(path.join(root, "relay.yaml"), "utf8")) as Manifest;
    const v = m?.surfaces?.view;
    return v?.out ? [path.join(v.source, v.out)] : [];
  } catch {
    return [];
  }
}

const TREE_SKIP = ["node_modules", ".git", ".relay", ".next", "out"];

function tree(dir: string, prefix = "", depth = 0): string[] {
  if (depth > 5 || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (TREE_SKIP.includes(e.name)) continue;
    out.push(prefix + e.name + (e.isDirectory() ? "/" : ""));
    if (e.isDirectory()) out.push(...tree(path.join(dir, e.name), prefix + "  ", depth + 1));
  }
  return out;
}

// 화면용 평탄 경로 목록 (파일만). 들여쓰기 트리를 되파싱하게 만들지 않는다
function listFiles(root: string, rel = "", depth = 0): string[] {
  const dir = path.join(root, rel);
  if (depth > 5 || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (TREE_SKIP.includes(e.name)) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    if (e.isDirectory()) out.push(...listFiles(root, r, depth + 1));
    else out.push(r);
  }
  return out;
}

export interface DraftChange {
  file: string;
  /** git 축약: M 수정, A 추가, D 삭제, ? 미추적, R 이름변경 */
  state: string;
}

function changes(droot: string): DraftChange[] {
  const r = git(droot, "status", "--porcelain");
  if (!r.ok) return [];
  return r.raw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const state = l.slice(0, 2).trim().replace("??", "?");
      const file = l.slice(3).replace(/^"|"$/g, "");
      return { file, state: state[0] ?? "M" };
    });
}

function lastCommit(droot: string): { hash: string; message: string; time: number } | null {
  const r = git(droot, "log", "-1", "--format=%H%x09%ct%x09%s");
  if (!r.ok || !r.out) return null;
  const [hash, ct, ...rest] = r.out.split("\t");
  return { hash, message: rest.join("\t"), time: Number(ct) * 1000 };
}

function manifestVersion(root: string): string | null {
  try {
    const m = parseYaml(fs.readFileSync(path.join(root, "relay.yaml"), "utf8")) as Manifest;
    return m?.version ?? null;
  } catch {
    return null;
  }
}

export interface SeedHarness {
  /** 패키지 상대 디렉토리 (예: harness/claude-code) — system 패키지의 같은 경로에서 복사한다 */
  source: string;
  entry: string;
}

export interface OpenResult {
  name: string;
  path: string;
  /** true = 이번 호출로 생성 (설치본 사본 또는 빈 스캐폴드), false = 이미 있던 draft 를 그대로 열었다 */
  fresh: boolean;
  from: "installed" | "empty" | "existing";
}

export function openDraft(
  ledger: Ledger,
  name: string,
  opts: { files?: Record<string, string>; seedHarness?: SeedHarness[] } = {},
): OpenResult {
  assertSlug(name);
  const droot = draftPath(name);
  const existed = fs.existsSync(droot);
  let from: OpenResult["from"] = "existing";

  if (!existed) {
    const rec = ledger.packages[name];
    if (rec && fs.existsSync(rec.path)) {
      copyTree(rec.path, droot, viewOutSkip(rec.path));
      from = "installed";
    } else {
      fs.mkdirSync(droot, { recursive: true });
      from = "empty";
    }
    const init = git(droot, "init", "-q", "-b", "main");
    if (!init.ok) throw new Error(`git init 실패: ${init.out}`);
  }

  if (opts.files) writeDraft(name, opts.files);

  // 하네스 템플릿은 system 패키지에 산다. 어댑터 entry 는 실행 파일이어야 conform 을 통과한다
  for (const h of opts.seedHarness ?? []) {
    const src = sealed(systemRoot(ledger), h.source);
    const dst = sealed(droot, h.source);
    if (!fs.existsSync(src)) throw new Error(`하네스 템플릿 없음: ${h.source}`);
    if (!fs.existsSync(dst)) {
      copyTree(src, dst);
      const entry = path.join(dst, h.entry);
      if (fs.existsSync(entry)) fs.chmodSync(entry, 0o755);
    }
  }

  if (!existed) {
    git(droot, "add", "-A");
    const c = git(droot, "commit", "-q", "-m", from === "installed" ? `draft open (v${manifestVersion(droot) ?? "?"})` : "draft open");
    if (!c.ok && !/nothing to commit/.test(c.out)) throw new Error(`최초 커밋 실패: ${c.out}`);
  }

  return { name, path: droot, fresh: !existed, from };
}

function systemRoot(ledger: Ledger): string {
  const rec = ledger.packages["system"];
  if (rec && fs.existsSync(rec.path)) return rec.path;
  return path.join(RUNNER_DIR, "..", "packages", "system");
}

export interface DraftStatus {
  name: string;
  path: string;
  manifest: string;
  tree: string[];
  /** 루트 상대 파일 경로 (디렉토리 제외) */
  files: string[];
  changes: DraftChange[];
  lastCommit: { hash: string; message: string; time: number } | null;
  version: { draft: string | null; live: string | null };
  installed: boolean;
}

export function readDraft(ledger: Ledger, name: string): DraftStatus;
export function readDraft(ledger: Ledger, name: string, file: string): { file: string; content: string };
export function readDraft(ledger: Ledger, name: string, file?: string): DraftStatus | { file: string; content: string } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name} — draft-open 으로 먼저 여세요`);
  if (file) {
    const target = sealed(droot, file);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) throw new Error(`없는 파일: ${file}`);
    return { file, content: fs.readFileSync(target, "utf8") };
  }
  const rec = ledger.packages[name];
  const manifestFile = path.join(droot, "relay.yaml");
  return {
    name,
    path: droot,
    manifest: fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, "utf8") : "",
    tree: tree(droot),
    files: listFiles(droot),
    changes: changes(droot),
    lastCommit: lastCommit(droot),
    version: { draft: manifestVersion(droot), live: rec ? manifestVersion(rec.path) : null },
    installed: !!rec,
  };
}

export function writeDraft(
  name: string,
  files: Record<string, string>,
  deletes: string[] = [],
): { written: string[]; deleted: string[] } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name} — draft-open 으로 먼저 여세요`);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const target = sealed(droot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(rel);
  }
  const deleted: string[] = [];
  for (const rel of deletes) {
    const target = sealed(droot, rel);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true });
      deleted.push(rel);
    }
  }
  return { written, deleted };
}

export function diffDraft(name: string): { changes: DraftChange[]; diff: string } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  // 미추적 파일도 diff 본문에 실리도록 intent-to-add 로 등록한다 (index 만 만지고 내용은 그대로)
  git(droot, "add", "-N", "-A");
  const d = git(droot, "diff", "HEAD");
  return { changes: changes(droot), diff: d.ok ? d.out : "" };
}

export function commitDraft(name: string, message: string): { committed: boolean; hash?: string; note?: string } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  if (!message?.trim()) throw new Error("커밋 메시지 필수");
  git(droot, "add", "-A");
  if (!changes(droot).length) return { committed: false, note: "변경 없음" };
  const c = git(droot, "commit", "-q", "-m", message.trim());
  if (!c.ok) throw new Error(`커밋 실패: ${c.out}`);
  return { committed: true, hash: lastCommit(droot)?.hash };
}

export function validateDraft(name: string): { ok: boolean; issues: string[] } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  return validateDir(droot);
}

export function discardDraft(name: string): { removed: string } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  fs.rmSync(droot, { recursive: true, force: true });
  return { removed: name };
}

export function listDrafts(ledger: Ledger): { name: string; version: string | null; changes: number; installed: boolean }[] {
  const root = path.join(RELAY_HOME, "drafts");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLUG.test(e.name))
    .map((e) => ({
      name: e.name,
      version: manifestVersion(path.join(root, e.name)),
      changes: changes(path.join(root, e.name)).length,
      installed: !!ledger.packages[e.name],
    }));
}

function bumpPatch(v: string): string {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`버전 형식 위반: ${v}`);
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}

export interface PublishResult {
  published: boolean;
  name: string;
  version?: string;
  path?: string;
  manifest?: Manifest;
  fresh?: boolean;
  setup?: { ok: boolean; out: string } | null;
  build?: BuildResult | null;
  note?: string;
}

/**
 * 판정 통과 스냅샷만 실행본이 된다. 순서가 계약이다:
 * 버전 확정(자동 patch 범프) → 판정 + requires + conform → 커밋 + 태그 → 스냅샷 → 장부 전환.
 * 장부 전환은 rec.path 만 바꾼다 — ring, workspace, model, harness, dirBindings 는 결재·설정이라
 * 재발행이 지우면 안 된다 (installPkg 처럼 레코드를 통째로 갈면 ring-0 이 조용히 증발한다).
 * 서비스 재기동은 데몬 소유라 여기서 하지 않는다 — 브리지가 publish 후 stop/start 를 잇는다.
 */
export function publishDraft(ledger: Ledger, name: string, opts: { version?: string } = {}): PublishResult {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  const relRoot = releasesPath(name);

  // 변경도 새 버전 지정도 없으면 재발행할 이유가 없다 (HEAD 가 이미 릴리스 태그 위)
  git(droot, "add", "-A");
  if (!opts.version && !changes(droot).length && git(droot, "describe", "--tags", "--exact-match", "HEAD").ok) {
    return { published: false, name, note: "마지막 릴리스 이후 변경 없음" };
  }

  const manifestFile = path.join(droot, "relay.yaml");
  if (!fs.existsSync(manifestFile)) throw new ManifestError([`relay.yaml 없음: ${droot}`]);
  const doc = parseDocument(fs.readFileSync(manifestFile, "utf8"));
  let version = opts.version ?? String(doc.get("version") ?? "");
  if (!SEMVER.test(version)) throw new Error(`버전 형식 위반: ${version}`);
  if (opts.version && fs.existsSync(path.join(relRoot, version))) {
    throw new Error(`이미 있는 릴리스: ${version} — 릴리스는 불변입니다, 다른 버전을 지정하세요`);
  }
  while (fs.existsSync(path.join(relRoot, version))) version = bumpPatch(version);
  if (String(doc.get("version")) !== version) {
    doc.set("version", version);
    fs.writeFileSync(manifestFile, doc.toString());
  }

  const v = validateDir(droot);
  if (!v.ok) throw new ManifestError(v.issues);
  const m = loadManifest(droot);
  judgeRequires(m);
  const broken = (m.harness?.variants ?? [])
    .map((hv) => conformHarness(droot, hv))
    .filter((r) => !r.ok)
    .map((r) => `${r.variant}: ` + r.checks.filter((c) => !c.ok).map((c) => `${c.verb} — ${c.note}`).join(" / "));
  if (broken.length) throw new ManifestError(["하네스 계약 위반 (relay harness-check 로 재현):", ...broken]);

  git(droot, "add", "-A");
  if (changes(droot).length) {
    const c = git(droot, "commit", "-q", "-m", `publish v${version}`);
    if (!c.ok) throw new Error(`publish 커밋 실패: ${c.out}`);
  }
  git(droot, "tag", "-f", `v${version}`);

  const snapshot = path.join(relRoot, version);
  copyTree(droot, snapshot, viewOutSkip(droot));

  const rec = ledger.packages[name];
  const fresh = !rec;
  if (rec) rec.path = snapshot;
  else ledger.packages[name] = { path: snapshot };
  // 활성 하네스가 새 선언에서 사라졌으면 재선출한다. 남아 있으면 사용자의 선택을 존중한다
  const variants = m.harness?.variants ?? [];
  let setup: PublishResult["setup"] = null;
  if (variants.length) {
    const current = ledger.packages[name].harness;
    if (!current || !variants.some((x) => x.name === current)) {
      const reports: string[] = [];
      let picked: string | null = null;
      for (const hv of variants) {
        const r = spawnEntrySync(path.join(snapshot, hv.source, hv.entry), ["setup"], { encoding: "utf8" });
        reports.push(`${hv.name}: ${r.status === 0 ? "준비됨" : "불가"}`);
        if (r.status === 0 && !picked) picked = hv.name;
      }
      ledger.packages[name].harness = picked ?? variants[0].name;
      setup = { ok: picked != null, out: `활성 하네스: ${ledger.packages[name].harness}\n` + reports.join("\n") };
    }
  }
  saveLedger(ledger);

  const build = buildView(name, snapshot, m) ?? null;
  return { published: true, name, version, path: snapshot, manifest: m, fresh, setup, build };
}

export function listReleases(ledger: Ledger, name: string): { version: string; time: number; live: boolean }[] {
  assertSlug(name);
  const relRoot = releasesPath(name);
  if (!fs.existsSync(relRoot)) return [];
  const livePath = ledger.packages[name]?.path ?? "";
  return fs
    .readdirSync(relRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SEMVER.test(e.name))
    .map((e) => ({
      version: e.name,
      time: fs.statSync(path.join(relRoot, e.name)).mtimeMs,
      live: path.join(relRoot, e.name) === livePath,
    }))
    .sort((a, b) => b.time - a.time);
}

/** 이전 릴리스로 장부 재전환. 스냅샷은 이미 판정을 통과한 것이지만 손상 대비로 다시 판정한다 */
export function rollbackRelease(ledger: Ledger, name: string, version: string): { name: string; version: string; path: string; manifest: Manifest } {
  assertSlug(name);
  const snapshot = path.join(releasesPath(name), version);
  if (!fs.existsSync(snapshot)) throw new Error(`없는 릴리스: ${name}@${version}`);
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(snapshot);
  rec.path = snapshot;
  saveLedger(ledger);
  const build = buildView(name, snapshot, m);
  if (build && !build.ok) throw new Error(`롤백 빌드 실패: ${build.out}`);
  return { name, version, path: snapshot, manifest: m };
}

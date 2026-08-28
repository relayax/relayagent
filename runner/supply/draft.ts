import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import { packagesPath, saveLedger, consoleInstall, type Ledger } from "./ledger.ts";
import { releasesPath } from "./release.ts";
import { loadManifest, judge, locateIssues, ManifestError, type Manifest, type Verdict } from "./manifest.ts";
import { conformHarness } from "./conform.ts";
import { spawnEntrySync } from "../spawn.ts";
import { buildSurfaces, judgeRequires, validateDir } from "./install.ts";
import { draftViewBase, type BuildResult } from "../runtime/view.ts";

// 수정 레이어. 설치본(장부 path)은 실행 중인 바이너리라 직접 만지지 않는다 — 런타임이 매 요청
// loadManifest(rec.path) 를 읽으므로 반쯤 저장된 매니페스트가 그대로 노출된다. 편집은 전부
// draft(작업 사본)에 쌓이고, publish 가 판정을 통과한 스냅샷을 releases 에 뜬 뒤 장부 path 를
// 갈아 끼운다. 참조 전환이라 원자적이고, 실패하면 실행본은 마지막 릴리스 그대로 돈다.
//   ~/Relay/packages/<이름>/           작업 사본 (git 저장소 — 이력·diff·되돌리기)
//   ~/.relay/releases/<이름>/<버전>/   불변 스냅샷 (장부 path 가 이 중 하나를 가리킨다)
//
// 두 층이 다른 땅에 사는 것이 계약이다. 작업 사본은 **사람이 열어 보고 고치는 것**이라 보이는
// 땅에 있고(파인더로 열리고, system 패키지가 dir 서비스로 문을 내 세션도 도구로 닿는다),
// 릴리스는 도는 판이라 기판 장기에 남아 모든 세션에 막힌다. 종전에는 작업 사본도 ~/.relay 에
// 있어서, 저작이라는 이 제품의 중심 행위만 사용자에게 보이지 않는 자리에서 벌어졌다.

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
// 스냅샷·사본에서 항상 빼는 것: git 내부, 의존성(설치·빌드가 다시 깐다), 프레임워크 캐시
const COPY_SKIP = new Set([".git", "node_modules", ".next"]);

export function draftPath(name: string): string {
  return path.join(packagesPath(), name);
}


function assertSlug(name: string): void {
  if (!SLUG.test(name ?? "")) {
    throw new Error(`패키지 디렉터리 이름은 영문 소문자, 숫자, 하이픈(-)만 사용할 수 있습니다 (최대 40자, 첫 글자는 영문 소문자 또는 숫자): ${name}`);
  }
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

// surfaces.{view,components}.out 은 빌드 산출물이라 사본·스냅샷에서 뺀다 (publish 가 다시 굽는다)
function buildOutSkip(root: string): string[] {
  try {
    const m = parseYaml(fs.readFileSync(path.join(root, "relay.yaml"), "utf8")) as Manifest;
    return [m?.surfaces?.view, m?.surfaces?.components]
      .filter((s): s is { source: string; out: string } => s?.out != null)
      .map((s) => path.join(s.source, s.out));
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

// 파일 내용 지문 — write 의 base precondition(동시 편집 판정)이 이 값과 비교한다.
// 클라이언트는 계산하지 않고 read 가 준 값을 그대로 되돌려준다(해시 알고리즘은 기판 내부 사정).
// raw 바이트로 읽는다 — utf8 왕복은 바이너리 자산(아이콘 등)에서 지문을 뭉갠다
function fileHash(abs: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
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
  opts: { files?: Record<string, string>; seedHarness?: SeedHarness[]; manifest?: Record<string, unknown> } = {},
): OpenResult {
  assertSlug(name);
  // 매니페스트 객체 → relay.yaml 은 기판이 적는다. 동사(system draft-open)가 yaml 을 수입하면
  // 설치본 트리 위에서 그 의존이 풀리지 않는다(실측 2026-08-26: 임베더 pod 의 store 마운트) —
  // 동사는 파일이 곧 동사이고 의존이 없다는 계약을 시스템 패키지도 지킨다
  if (opts.manifest && !opts.files?.["relay.yaml"]) {
    opts = { ...opts, files: { ...(opts.files ?? {}), "relay.yaml": stringifyYaml(opts.manifest) } };
  }
  const droot = draftPath(name);
  const existed = fs.existsSync(droot);
  let from: OpenResult["from"] = "existing";

  if (!existed) {
    const rec = ledger.packages[name];
    if (rec && fs.existsSync(rec.path)) {
      copyTree(rec.path, droot, buildOutSkip(rec.path));
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
  // 콘솔의 설치 이름은 기판마다 다르다(ledger.ts consoleInstall) — 상수 "system" 을 박으면 임베더에서
  // 하네스 템플릿이 "없음"으로 떨어진다
  const rec = ledger.packages[consoleInstall(ledger)];
  if (rec && fs.existsSync(rec.path)) return rec.path;
  return path.join(RUNNER_DIR, "..", "..", "packages", "system");
}

export interface DraftStatus {
  name: string;
  path: string;
  manifest: string;
  tree: string[];
  /** 루트 상대 파일 경로 (디렉토리 제외) */
  files: string[];
  /** 파일별 내용 지문 — write 의 base 로 되돌려주면 그 사이 다른 손(에이전트·CLI·다른 화면)의
   *  수정을 판정한다. files 와 같은 키 공간 */
  hashes: Record<string, string>;
  changes: DraftChange[];
  lastCommit: { hash: string; message: string; time: number } | null;
  version: { draft: string | null; live: string | null };
  installed: boolean;
}

export function readDraft(ledger: Ledger, name: string): DraftStatus;
export function readDraft(ledger: Ledger, name: string, file: string): { file: string; content: string; hash: string };
export function readDraft(ledger: Ledger, name: string, file?: string): DraftStatus | { file: string; content: string; hash: string } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name} — draft-open 으로 먼저 여세요`);
  if (file) {
    const target = sealed(droot, file);
    if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) throw new Error(`없는 파일: ${file}`);
    return { file, content: fs.readFileSync(target, "utf8"), hash: fileHash(target) };
  }
  const rec = ledger.packages[name];
  const manifestFile = path.join(droot, "relay.yaml");
  const files = listFiles(droot);
  const hashes: Record<string, string> = {};
  for (const f of files) hashes[f] = fileHash(path.join(droot, f));
  return {
    name,
    path: droot,
    manifest: fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, "utf8") : "",
    tree: tree(droot),
    files,
    hashes,
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
  base?: Record<string, string | null>,
): { written: string[]; deleted: string[]; hashes: Record<string, string> } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name} — draft-open 으로 먼저 여세요`);
  // base precondition — 마지막으로 읽은 지문과 현재 디스크가 다르면 한 글자도 쓰지 않는다.
  // draft 는 세 손(화면·에이전트·CLI)이 같은 트리를 만지므로, 이 판정 없이는 낡은 버퍼의
  // 전문 쓰기(부분 패치 아님)가 다른 손의 작업을 통째로 되덮는다. base 는 opt-in 이다 —
  // 실은 경로만 판정하고, 안 실은 호출(에이전트의 신선한 읽기-쓰기 등)은 종전 그대로다.
  // null = "없는 파일로 알고 있다"(신규 생성 의도) — 그 사이 생겼다면 그것도 충돌이다.
  if (base) {
    const stale: string[] = [];
    for (const [rel, known] of Object.entries(base)) {
      const target = sealed(droot, rel);
      const current = fs.existsSync(target) && !fs.statSync(target).isDirectory() ? fileHash(target) : null;
      if (current !== known) stale.push(rel);
    }
    if (stale.length) {
      throw new Error(
        `E_CONFLICT: 마지막으로 읽은 뒤 다른 손이 고친 파일 — ${stale.join(", ")}. ` +
        `draft-read 로 새 내용을 받아 그 위에 반영하거나, 덮어쓰려면 base 없이 다시 쓰세요.`,
      );
    }
  }
  const written: string[] = [];
  const hashes: Record<string, string> = {};
  for (const [rel, content] of Object.entries(files)) {
    const target = sealed(droot, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    written.push(rel);
    hashes[rel] = fileHash(target);
  }
  const deleted: string[] = [];
  for (const rel of deletes) {
    const target = sealed(droot, rel);
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true });
      deleted.push(rel);
    }
  }
  return { written, deleted, hashes };
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

/**
 * 작업 사본 판정. issues(문장 배열)는 종전 그대로 두고 verdicts 를 **덧붙인다** — 좌표를 실은
 * 같은 판정이다. 화면은 verdicts 로 에디터 마커와 트리 배지를 그리고, 좌표를 못 짚은 판정도
 * 문장으로는 그대로 보인다(둘의 길이는 항상 같다).
 */
export function validateDraft(name: string): { ok: boolean; issues: string[]; verdicts: Verdict[] } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  const r = validateDir(droot);
  let text = "";
  try {
    text = fs.readFileSync(path.join(droot, "relay.yaml"), "utf8");
  } catch { /* 매니페스트 자체가 없는 경우 — 좌표 없는 판정으로 나간다 */ }
  return { ...r, verdicts: text ? locateIssues(text, r.issues) : r.issues.map((message) => ({ message, line: null, col: null, path: null })) };
}

export function discardDraft(name: string): { removed: string } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  fs.rmSync(droot, { recursive: true, force: true });
  return { removed: name };
}

export function listDrafts(ledger: Ledger): { name: string; version: string | null; changes: number; installed: boolean; empty: boolean }[] {
  const root = packagesPath();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && SLUG.test(e.name))
    .map((e) => {
      const droot = path.join(root, e.name);
      const n = changes(droot).length;
      return {
        name: e.name,
        version: manifestVersion(droot),
        changes: n,
        installed: !!ledger.packages[e.name],
        // 빈 초안 = 이름만 짓고 만 것: 기록하지 않은 변경이 없고 이력이 "draft open" 한 줄뿐.
        // 홈이 카드 대신 한 줄로 접고 바로 버릴 수 있게 한다(2026-08-27). changes 0 만으로는
        // 첫 판을 기록해 둔 초안(내용 있음)과 구분이 안 됐다
        empty: n === 0 && isScaffoldOnly(droot),
      };
    });
}

function isScaffoldOnly(droot: string): boolean {
  const r = git(droot, "log", "--format=%s", "-n", "2");
  if (!r.ok) return false;
  const lines = r.out.split("\n").filter(Boolean);
  return lines.length === 1 && lines[0].startsWith("draft open");
}

/** 기록(커밋) 이력 — 최근 것부터. 화면의 [기록] 다이얼로그가 "이 지점으로" 를 붙이는 목록이다.
 *  종전에는 기록을 남길 수는 있어도 그 지점으로 돌아가는 문이 화면에 없었다 — 약속만 있는 버튼이었다 */
export function historyDraft(name: string): { commits: { hash: string; message: string; time: number }[] } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  const r = git(droot, "log", "--format=%H%x09%ct%x09%s", "-n", "50");
  if (!r.ok || !r.out) return { commits: [] };
  return {
    commits: r.out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [hash, ct, ...rest] = l.split("\t");
        return { hash, message: rest.join("\t"), time: Number(ct) * 1000 };
      }),
  };
}

/**
 * 기록 지점으로 되돌리기 — 작업 사본의 파일을 그 커밋의 모습으로 되돌린다. 이력은 지우지 않는다
 * (HEAD 그대로): 되돌린 결과는 "기록하지 않은 변경" 으로 서고, 다시 기록하거나 적용하면 된다.
 * 그 커밋 뒤에 생긴 추적 파일은 지운다 — 덮어쓰기만 하면 반쯤 되돌린 판이 된다. 한 번도 기록되지
 * 않은(미추적) 파일은 그대로 둔다: 기록에 없던 것을 기판이 지우면 사용자가 잃는다.
 */
export function restoreDraft(name: string, hash: string): { restored: string; message: string } {
  assertSlug(name);
  const droot = draftPath(name);
  if (!fs.existsSync(droot)) throw new Error(`draft 없음: ${name}`);
  if (!/^[0-9a-f]{7,40}$/.test(hash ?? "")) throw new Error(`기록 지문 형식 위반: ${hash}`);
  const probe = git(droot, "rev-parse", "--verify", `${hash}^{commit}`);
  if (!probe.ok) throw new Error(`없는 기록: ${hash}`);
  const full = probe.out;
  const now = new Set(git(droot, "ls-files").raw.split("\n").filter(Boolean));
  const then = new Set(git(droot, "ls-tree", "-r", "--name-only", full).raw.split("\n").filter(Boolean));
  const co = git(droot, "checkout", full, "--", ".");
  if (!co.ok) throw new Error(`되돌리기 실패: ${co.out}`);
  for (const f of now) if (!then.has(f)) fs.rmSync(sealed(droot, f), { force: true });
  git(droot, "add", "-A");
  return { restored: full, message: git(droot, "log", "-1", "--format=%s", full).out };
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

/** 스테이지할 것이 없다 — 변경도 새 버전 지정도 없음 */
export interface NotStaged {
  published: false;
  name: string;
  note: string;
}

/** 판정을 통과해 스냅샷까지 뜬 릴리스 — 아직 어디에도 앉지 않았다(장부 무변) */
export interface StagedRelease {
  name: string;
  version: string;
  /** 불변 스냅샷(releases/<이름>/<버전>) */
  path: string;
  manifest: Manifest;
}

/**
 * 판정 통과 스냅샷만 실행본이 된다. 순서가 계약이다:
 * 버전 확정(자동 patch 범프) → 판정 + requires + conform → 커밋 + 태그 → 스냅샷 → 장부 전환.
 * 장부 전환은 rec.path 만 바꾼다 — ring, workspace, model, harness, dirBindings 는 결재·설정이라
 * 재발행이 지우면 안 된다 (installPkg 처럼 레코드를 통째로 갈면 ring-0 이 조용히 증발한다).
 * 서비스 재기동은 데몬 소유라 여기서 하지 않는다 — 브리지가 publish 후 stop/start 를 잇는다.
 */
export async function publishDraft(ledger: Ledger, name: string, opts: { version?: string } = {}): Promise<PublishResult> {
  const staged = stageRelease(name, opts);
  if ("published" in staged) return staged;
  return { published: true, ...staged, ...(await landRelease(ledger, staged)) };
}

/**
 * 발행의 앞 절반 — 버전 확정 → 판정 + requires + conform → 커밋 + 태그 → 스냅샷. 장부는 건드리지
 * 않는다. 뒤 절반(어디에 앉히는가)이 갈라지는 자리라 둘로 나눴다: 1인 기판은 landRelease 로 같은
 * 데몬의 장부에 앉히고(저작자 = 사용자), 임베더는 Authority.publish 로 자기 유통망에 올린다.
 * 변경도 새 버전 지정도 없으면 스테이지할 것이 없다 — published:false 로 돌려준다.
 */
export function stageRelease(name: string, opts: { version?: string } = {}): StagedRelease | NotStaged {
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
  judgeRequires(m, name);
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
  copyTree(droot, snapshot, buildOutSkip(droot));
  return { name, version, path: snapshot, manifest: m };
}

/**
 * 발행의 뒤 절반(1인 기판) — 장부 전환 + 하네스 재선출 + 표면 굽기. 장부 전환은 rec.path 만
 * 바꾼다 — ring, workspace, model, harness, dirBindings 는 결재·설정이라 재발행이 지우면 안 된다.
 */
export async function landRelease(
  ledger: Ledger,
  staged: StagedRelease,
): Promise<{ fresh: boolean; setup: PublishResult["setup"]; build: BuildResult | null }> {
  const { name, path: snapshot, manifest: m } = staged;
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

  // 굽는 것은 표면 **전부**다. 종전에는 view 만 구웠는데, components 를 선언한 패키지를
  // 스튜디오에서 발행하면 번들이 없는 스냅샷이 떠서 소비자 문서의 import 가 503 을 받았다 —
  // 설치·재빌드(buildSurfaces)와 발행이 서로 다른 것을 구운 자리다.
  const build = (await buildSurfaces(name, snapshot, m)) ?? null;
  return { fresh, setup, build };
}

/**
 * 미리보기 굽기 — 작업 사본을 /draft/<이름>/ 좌표로 굽는다.
 *
 * 발행 굽기와 다른 것은 좌표 하나다(basePath). 산출은 작업 사본 안의 out/ 에 앉는데 그것은
 * 스냅샷에서 빠지는 임시물이라(buildOutSkip · publish 가 다시 굽는다) 도는 판을 오염시키지
 * 않는다. 장부도 건드리지 않는다 — 여기서는 아무것도 커밋되지 않는다.
 */
export async function buildDraft(name: string): Promise<{ name: string; built: boolean; out: string }> {
  assertSlug(name);
  const root = draftPath(name);
  if (!fs.existsSync(root)) throw new Error(`없는 작업 사본: ${name}`);
  const m = loadManifest(root);
  const r = await buildSurfaces(name, root, m, draftViewBase(name));
  if (!r) return { name, built: false, out: "surfaces.{view,components}.out 미선언 — 굽지 않고 source 를 그대로 냅니다" };
  if (!r.ok) throw new Error(r.out);
  return { name, built: true, out: r.out };
}



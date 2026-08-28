import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { artifactsDir, logLine } from "./ledger.ts";
import { loadManifest, declaredPaths, disclosure, type Disclosure, type Manifest } from "./manifest.ts";
import { vaultGet } from "../vault.ts";
import { signDigest, SIGNING_VAULT_KEY, type EnvelopeSignature } from "./sign.ts";

// 봉투(.relay) = 릴리스 스냅샷의 이동형. tar+gzip 하나에 매니페스트가 선언한 경로만 담고
// sha256 다이제스트가 신원이 된다. tar 를 외부 명령으로 부르지 않고 직접 쓰는 이유는
// 결정성이다 — BSD/GNU tar 는 엔트리 순서·mtime·uid 를 다르게 넣어 같은 트리에서 다른
// 다이제스트가 나온다. 여기서는 경로 오름차순 + mtime/uid/gid 0 + mode 두 값(0644/0755)으로
// 고정해, 같은 트리는 같은 봉투가 되게 한다.

// 봉투에서 항상 빼는 것 — draft.ts 의 COPY_SKIP 과 같은 이유 (설치·빌드가 재생성한다)
const PACK_SKIP = new Set([".git", "node_modules", ".next"]);
const BLOCK = 512;
/** 엔트리 하나의 상한 — 패키지 실측이 300KB 급이라 100MB 면 사고 신호다 */
const MAX_ENTRY = 100 * 1024 * 1024;
/** 전개 후 전체 상한 (압축 폭탄 방어) */
const MAX_TOTAL = 512 * 1024 * 1024;

// ── ustar 쓰기 ───────────────────────────────────────────────────────────────

function octal(n: number, len: number): Buffer {
  const b = Buffer.alloc(len, 0);
  b.write(n.toString(8).padStart(len - 1, "0") + "\0", 0, "ascii");
  return b;
}

function header(rel: string, size: number, mode: number): Buffer {
  // ustar name 100 + prefix 155. 경로가 100을 넘으면 마지막 / 에서 갈라 prefix 로 넘긴다
  let name = rel;
  let prefix = "";
  if (Buffer.byteLength(name) > 100) {
    const cut = rel.lastIndexOf("/", 100);
    if (cut <= 0 || Buffer.byteLength(rel.slice(cut + 1)) > 100 || Buffer.byteLength(rel.slice(0, cut)) > 155) {
      throw new Error(`경로가 ustar 한도를 넘습니다 (255): ${rel}`);
    }
    prefix = rel.slice(0, cut);
    name = rel.slice(cut + 1);
  }
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, "utf8");
  octal(mode, 8).copy(h, 100);
  octal(0, 8).copy(h, 108); // uid
  octal(0, 8).copy(h, 116); // gid
  octal(size, 12).copy(h, 124);
  octal(0, 12).copy(h, 136); // mtime — 굽는 시각이 다이제스트를 흔들지 않게 0
  h.fill(" ", 148, 156); // checksum 자리는 공백으로 두고 합산
  h.write("0", 156, "ascii"); // typeflag: 일반 파일
  h.write("ustar\0", 257, "ascii");
  h.write("00", 263, "ascii");
  h.write(prefix, 345, "utf8");
  let sum = 0;
  for (const byte of h) sum += byte;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
  return h;
}

export interface TarEntry {
  rel: string;
  content: Buffer;
  mode: number;
}

/**
 * 엔트리 → 결정적 tar+gzip. 봉투(packDir)와 묶음(suites.ts .relaypackages)이 같은 굽기를 쓴다.
 * 정렬은 기본 sort(코드 유닛 순)와 같아야 한다 — 다르면 같은 트리의 봉인이 굽는 쪽마다 흔들린다
 */
export function packEntries(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) {
    if (e.content.length > MAX_ENTRY) throw new Error(`봉투 엔트리 상한 초과 (${MAX_ENTRY}): ${e.rel}`);
    chunks.push(header(e.rel, e.content.length, e.mode), e.content);
    const pad = e.content.length % BLOCK;
    if (pad) chunks.push(Buffer.alloc(BLOCK - pad));
  }
  chunks.push(Buffer.alloc(BLOCK * 2)); // 종료 표지
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

export const sha256Of = (b: Buffer): string => "sha256:" + crypto.createHash("sha256").update(b).digest("hex");

// ── 파일 수집 ────────────────────────────────────────────────────────────────

function walk(root: string, rel: string, skipAbs: string[], out: string[]): void {
  const abs = path.join(root, rel);
  for (const e of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (PACK_SKIP.has(e.name)) continue;
    const r = rel ? rel + "/" + e.name : e.name;
    const a = path.join(root, r);
    if (skipAbs.some((s) => a === s || a.startsWith(s + path.sep))) continue;
    if (e.isSymbolicLink()) throw new Error(`심볼릭 링크는 봉투에 담지 않습니다: ${r} — 실제 파일로 바꾸세요`);
    if (e.isDirectory()) walk(root, r, skipAbs, out);
    else if (e.isFile()) out.push(r);
  }
}

/**
 * 구운 봉투를 파일 교환 무대에 놓는다 — 사람에게 건네려고 굽기 때문이다.
 *
 * 선반(~/.relay/artifacts)은 기판 장기라 모든 세션에 막혀 있다. 그래서 봉투를 구운 에이전트가
 * 정작 그것을 건네지 못하고 "터미널에서 cp 하세요"로 떨어졌다 — 굽기의 결과가 사용자에게
 * 닿는 길이 사람의 손을 거치게 되어 있었다. 무대에 놓으면 턴이 끝날 때 그 자리의 새 파일이
 * 대화의 다운로드가 된다(harness stageDiffFiles). 서명 사이드카도 함께 옮긴다: 손으로 옮기는
 * 봉투가 서명을 잃으면 받는 쪽이 대조할 것이 없다.
 *
 * 같은 버전을 다시 구우면 같은 이름을 덮는다 — 무대에 같은 봉투가 여럿 쌓이면 사용자는
 * 어느 것이 방금 것인지 알 수 없다.
 */
export function deliverToStage(artifact: string, stage: string): string[] {
  const out: string[] = [];
  fs.mkdirSync(stage, { recursive: true });
  for (const src of [artifact, artifact + ".sig"]) {
    if (!fs.existsSync(src)) continue;
    const name = path.basename(src);
    fs.copyFileSync(src, path.join(stage, name));
    out.push(name);
  }
  return out;
}

export interface PackResult {
  file: string;
  ref: string;
  version: string;
  digest: string;
  size: number;
  included: { path: string; size: number }[];
  /** 패키지 트리에 있으나 선언 밖이라 봉투에서 뺀 파일 (발행 화면이 사람에게 보여준다) */
  excluded: string[];
  manifest: Manifest;
  disclosure: Disclosure;
  /** 발행 키(vault signing/ed25519)가 있을 때만 — 봉인값 위의 Ed25519 사인 */
  signature?: EnvelopeSignature;
}

export function artifactFileName(ref: string, version: string): string {
  return `${ref.replace(/^@/, "").replace(/\//g, "-")}-${version}.relay`;
}

/**
 * 봉투 굽기. 매니페스트가 BOM 이면 봉투도 BOM 대로 — declaredPaths 가 가리키는 것만 담는다.
 * 선언 밖 파일은 excluded 로 보고만 하고 담지 않는다 (.env, 메모, 구버전 사본이 실려 나가는
 * 사고의 방어선). outFile 미지정이면 로컬 마켓 선반(~/.relay/artifacts)에 앉는다.
 */
export function packDir(pkgDir: string, outFile?: string): PackResult {
  const root = path.resolve(pkgDir);
  const m = loadManifest(root); // 판정 실패는 여기서 fail-loud
  // 빌드 산출물은 봉투에 담지 않는다 — 설치가 다시 굽는다. view 와 components 가 같은 규율이다
  const buildOuts = [m.surfaces?.view, m.surfaces?.components]
    .filter((s): s is { source: string; out: string } => s?.out != null)
    .map((s) => path.normalize(path.join(root, s.source, s.out)));

  const files = new Set<string>();
  for (const d of declaredPaths(m)) {
    const abs = path.join(root, d.path);
    if (!fs.existsSync(abs)) continue; // 실체는 judge 가 이미 판정 — 선택 선언만 여기 온다
    if (d.kind === "file" || fs.statSync(abs).isFile()) files.add(d.path);
    else {
      const collected: string[] = [];
      walk(root, d.path, buildOuts, collected);
      for (const f of collected) files.add(f);
    }
  }
  const sorted = [...files].sort(); // 경로 오름차순 — 결정성의 축

  const entries: TarEntry[] = [];
  const included: PackResult["included"] = [];
  for (const rel of sorted) {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (st.size > MAX_ENTRY) throw new Error(`봉투 엔트리 상한 초과 (${MAX_ENTRY}): ${rel}`);
    entries.push({ rel, content: fs.readFileSync(abs), mode: st.mode & 0o111 ? 0o755 : 0o644 }); // 실행 비트만 보존
    included.push({ path: rel, size: st.size });
  }
  const gz = packEntries(entries);
  const digest = sha256Of(gz);

  const file = outFile
    ? path.resolve(outFile)
    : path.join(artifactsDir(), artifactFileName(m.name, m.version));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, gz);

  // 서명 — vault 에 발행 키(relay keygen)가 있으면 봉인값 위에 사인해 사이드카로 남긴다.
  // 키 없는 굽기는 무서명(현행) — 서명 요구는 설치 기판의 RELAY_PUBKEYS 고정이 결정한다
  let signature: EnvelopeSignature | undefined;
  // §8-2 잔여: packDir 는 동기 계약(CLI pack·host.pack·등재 화면이 동기 소비)이라 비동기
  // authority.credential 로의 이사가 시그니처 연쇄를 일으킨다 — vault 직독으로 남는다
  const signKey = vaultGet(SIGNING_VAULT_KEY);
  if (signKey) {
    signature = signDigest(signKey, digest);
    fs.writeFileSync(file + ".sig", JSON.stringify(signature) + "\n");
  }

  // 선언 밖 보고 — 트리 전수에서 담은 것을 뺀 나머지
  const all: string[] = [];
  walk(root, "", buildOuts, all);
  const excluded = all.filter((f) => !files.has(f));

  // §8-2 잔여: 위 signKey 와 같은 사유(동기 계약) — audit 이사 보류
  logLine("pack", { ref: m.name, version: m.version, digest, size: gz.length, files: included.length });
  return { file, ref: m.name, version: m.version, digest, size: gz.length, included, excluded, manifest: m, disclosure: disclosure(m), signature };
}

// ── 봉인 검증과 해체 ─────────────────────────────────────────────────────────

export function sha256File(file: string): string {
  return "sha256:" + crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** 다이제스트 대조. 불일치는 즉시 fail-loud — 검증 전의 바이트는 신뢰하지 않는다 */
export function verifyArtifact(file: string, expected: string): void {
  const actual = sha256File(file);
  if (actual !== expected) {
    throw new Error(`봉인 불일치: ${path.basename(file)}\n  기대 ${expected}\n  실제 ${actual}`);
  }
}

/**
 * 봉투의 엔트리 이름만 — 파일을 쓰지 않고 헤더만 걷는다. 형 판정용(묶음 봉투인가)이라 봉인·체크섬은
 * 보지 않는다: 그 판정은 뒤이어 여는 쪽(unpackArtifact)이 같은 바이트로 다시 한다
 */
export function listArtifact(file: string): string[] {
  const tar = zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: MAX_TOTAL });
  const names: string[] = [];
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const name = parseStr(h, 0, 100);
    const prefix = parseStr(h, 345, 155);
    names.push(prefix ? prefix + "/" + name : name);
    off += BLOCK + Math.ceil(parseOctal(h, 124, 12) / BLOCK) * BLOCK;
  }
  return names;
}

function parseOctal(b: Buffer, off: number, len: number): number {
  const s = b.subarray(off, off + len).toString("ascii").replace(/\0.*$/, "").trim();
  return s ? parseInt(s, 8) : 0;
}

function parseStr(b: Buffer, off: number, len: number): string {
  const end = b.indexOf(0, off);
  return b.subarray(off, end >= 0 && end < off + len ? end : off + len).toString("utf8");
}

/**
 * 봉투 해체. tar 는 심볼릭 링크·절대경로·상위 탈출을 담을 수 있는 형식이라 푸는 쪽이 봉인을
 * 진다: 일반 파일 외 전부 거부, 경로는 목적지 아래로만, 크기 상한. 반환은 쓴 파일 목록.
 * 다이제스트 검증(verifyArtifact)은 호출부가 이 함수보다 먼저 지나야 한다.
 */
export function unpackArtifact(file: string, destDir: string): string[] {
  const gz = fs.readFileSync(file);
  const tar = zlib.gunzipSync(gz, { maxOutputLength: MAX_TOTAL });
  const dest = path.resolve(destDir);
  fs.mkdirSync(dest, { recursive: true });
  const written: string[] = [];
  let off = 0;
  let total = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break; // 종료 표지
    const stored = parseOctal(h, 148, 8);
    const scratch = Buffer.from(h);
    scratch.fill(" ".charCodeAt(0), 148, 156);
    let sum = 0;
    for (const byte of scratch) sum += byte;
    if (sum !== stored) throw new Error(`손상된 봉투: 헤더 체크섬 불일치 (offset ${off})`);

    const type = String.fromCharCode(h[156]);
    const name = parseStr(h, 0, 100);
    const prefix = parseStr(h, 345, 155);
    const rel = prefix ? prefix + "/" + name : name;
    const size = parseOctal(h, 124, 12);
    const mode = parseOctal(h, 100, 8);
    off += BLOCK;

    if (type === "5") continue; // 디렉토리 — 파일 쓰기가 mkdir 로 대신한다
    if (type !== "0" && type !== "\0") {
      throw new Error(`봉투에 일반 파일이 아닌 엔트리가 있습니다 (type ${JSON.stringify(type)}): ${rel} — 링크·디바이스는 받지 않습니다`);
    }
    if (!rel || rel.startsWith("/") || rel.split("/").includes("..")) throw new Error(`경로 탈출: ${rel}`);
    const target = path.normalize(path.join(dest, rel));
    if (target !== dest && !target.startsWith(dest + path.sep)) throw new Error(`경로 탈출: ${rel}`);
    if (size > MAX_ENTRY) throw new Error(`봉투 엔트리 상한 초과: ${rel}`);
    total += size;
    if (total > MAX_TOTAL) throw new Error(`봉투 전체 상한 초과 (${MAX_TOTAL})`);

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, tar.subarray(off, off + size), { mode: mode & 0o111 ? 0o755 : 0o644 });
    written.push(rel);
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  if (!written.length) throw new Error(`빈 봉투: ${file}`);
  return written;
}

// ── 로컬 마켓 선반 (index.json) ──────────────────────────────────────────────

export interface MarketEntry {
  ref: string;
  /** 발행 주체 scope (예: "@yuni"). C2C 호환 규율 4 — 지금은 전부 퍼스트파티지만 칸은 첫날부터 */
  seller: string;
  version: string;
  /** artifacts 디렉토리 안의 파일 이름 (원격 인덱스는 url 을 쓴다 — registry.ts 참조) */
  file: string;
  size: number;
  digest: string;
  display_name: string;
  description: string;
  /** artifacts 디렉토리 안의 아이콘 사본 이름 (없으면 null) */
  icon: string | null;
  files: number;
  disclosure: Disclosure;
  packedAt: string;
}

export function sellerOf(ref: string): string {
  return ref.split("/")[0] ?? ref;
}

function indexFile(): string {
  return path.join(artifactsDir(), "index.json");
}

export function readMarketIndex(): MarketEntry[] {
  const f = indexFile();
  if (!fs.existsSync(f)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    const entries: MarketEntry[] = Array.isArray(j.entries) ? j.entries : [];
    // seller 필드 도입 전에 등재된 항목 — ref 에서 파생해 채운다
    return entries.map((e) => ({ ...e, seller: e.seller ?? sellerOf(e.ref) }));
  } catch {
    return []; // 손상된 index — pack 이 다시 쓰면 복구된다
  }
}

/**
 * 로컬 마켓 등재. ref 당 한 줄 — 새 판이 이전 판을 대체한다 (아티팩트 파일은 버전별로 남는다).
 * 아이콘은 봉투 밖 사본으로 선반에 놓아 화면이 압축을 풀지 않고도 그리게 한다.
 */
export function updateMarketIndex(pkgDir: string, r: PackResult): string {
  const dir = artifactsDir();
  let icon: string | null = null;
  if (r.manifest.icon) {
    const src = path.join(pkgDir, r.manifest.icon);
    if (fs.existsSync(src)) {
      icon = `${r.ref.replace(/^@/, "").replace(/\//g, "-")}-icon${path.extname(r.manifest.icon)}`;
      fs.copyFileSync(src, path.join(dir, icon));
    }
  }
  const entry: MarketEntry = {
    ref: r.ref,
    seller: sellerOf(r.ref),
    version: r.version,
    file: path.basename(r.file),
    size: r.size,
    digest: r.digest,
    display_name: r.manifest.display_name,
    description: r.manifest.description,
    icon,
    files: r.included.length,
    disclosure: r.disclosure,
    packedAt: new Date().toISOString(),
  };
  const entries = readMarketIndex().filter((e) => e.ref !== r.ref);
  entries.push(entry);
  entries.sort((a, b) => a.ref.localeCompare(b.ref));
  fs.writeFileSync(indexFile(), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), entries }, null, 2));
  return indexFile();
}

// suites.ts — 묶음(suite). 설치본 여럿을 폴더 하나로 묶는 **기판 상태**이고, 그 묶음이 그대로
// 봉투 하나(.relaypackages)로 나가고 들어온다.
//
// 매니페스트가 아니라 기판 파일(RELAY_HOME/suites.json)에 사는 이유: 묶음은 소비자가 정하는
// 배치다. 개별 패키지 relay.yaml 에 group 을 박으면 같은 패키지를 두 묶음에 못 넣고, 제공자가
// 소비자를 알게 된다(의존 방향 역전 — 패키지가 자기 쓰임새를 미리 알아야 한다).
// 결재 관계(edges[].components)에서 유도되는 허브▸모듈 트리는 여기 없다 — 그건 장부에서 나오고
// (runtime/shell.ts mounted_in), 묶음은 그 위에 사람이 얹는 폴더다. 둘은 사이드바에서 합쳐진다.
//
// 봉투 형식(.relaypackages) = tar+gzip 하나에
//   relay-suite.json             묶음 매니페스트 — 이름·라벨·허브·구성원(설치 순서대로)과 안쪽 봉투의 봉인
//   packages/<ref>-<ver>.relay   구성원 봉투 **그대로**(+ .sig 사이드카). 다시 싸지 않는다 — 봉인·서명이
//                                개별 단위로 남아야 받는 쪽이 하나씩 검증한다(신뢰는 패키지 단위다)
// 설치 순서가 계약이다: 제공자가 먼저다. resolveComponentEdges 는 provider 미설치면 fail-loud 라
// 허브를 먼저 앉히면 죽는다 — 굽는 쪽이 edges 로 위상정렬해 적고, 받는 쪽은 적힌 순서대로 앉힌다.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RELAY_HOME, artifactsDir, logLine, type Ledger } from "./ledger.ts";
import { loadManifest } from "./manifest.ts";
import { packDir, packEntries, sha256File, sha256Of, unpackArtifact, listArtifact, verifyArtifact, artifactFileName, type TarEntry } from "./pack.ts";
import { prepareArtifact, activatePrepared, resolveProvider, type Prepared, type InstallResult } from "./install.ts";

export interface Suite {
  /** 파일 이름·주소에 쓰는 슬러그 */
  name: string;
  /** 사이드바 폴더에 보이는 이름 */
  label: string;
  /** 설치 이름들 — 순서가 곧 폴더 안의 순서 */
  members: string[];
  /** 폴더의 문 — 접힌 레일에서 이 앱의 아이콘이 폴더를 대표한다. null = 첫 구성원 */
  hub: string | null;
}

export const SUITE_EXT = ".relaypackages";
const SUITE_MANIFEST = "relay-suite.json";
const SUITE_SCHEMA = "relay-suite/v1";
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** 봉투 안 묶음 매니페스트 — 굽는 쪽이 적고 받는 쪽이 읽는 계약 */
export interface SuiteManifest {
  schema: string;
  name: string;
  label: string;
  /** 허브의 패키지 ref(@scope/name) — 설치 이름은 받는 기판이 정하므로 ref 로 적는다 */
  hub: string | null;
  /** 설치 순서대로 */
  packages: { ref: string; version: string; display_name: string; file: string; digest: string }[];
}

const suitesFile = (): string => path.join(RELAY_HOME, "suites.json");

/** 묶음 전부. ledger 를 주면 지워진 설치는 구성원에서 빠진 채로 온다(파일은 그대로 — 다음 저장이 정리한다) */
export function loadSuites(ledger?: Ledger): Suite[] {
  const f = suitesFile();
  if (!fs.existsSync(f)) return [];
  let list: Suite[];
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    list = Array.isArray(j.suites) ? j.suites : [];
  } catch (e) {
    throw new Error(`묶음 파일이 깨졌습니다: ${f} — ${String(e)}`);
  }
  if (!ledger) return list;
  return list.map((s) => {
    const members = (s.members ?? []).filter((m) => !!ledger.packages[m]);
    return { ...s, members, hub: s.hub && members.includes(s.hub) ? s.hub : null };
  });
}

function saveSuites(list: Suite[]): void {
  fs.mkdirSync(RELAY_HOME, { recursive: true });
  fs.writeFileSync(suitesFile(), JSON.stringify({ suites: list }, null, 2) + "\n");
}

/** 묶음 하나를 앉힌다(같은 이름이면 갈아 끼운다). 구성원은 설치본이어야 하고 허브는 구성원이어야 한다 */
export function upsertSuite(ledger: Ledger, s: Suite): Suite {
  if (!SLUG.test(s.name ?? "")) throw new Error(`묶음 이름 형식 위반(소문자·숫자·하이픈, 40자 이내): ${String(s.name)}`);
  const label = (s.label ?? "").trim() || s.name;
  const members = [...new Set((s.members ?? []).map((m) => String(m).trim()).filter(Boolean))];
  if (!members.length) throw new Error("구성원이 없습니다 — 묶음은 설치본 하나 이상을 묶습니다");
  for (const m of members) if (!ledger.packages[m]) throw new Error(`미설치 패키지는 묶을 수 없습니다: ${m}`);
  const hub = s.hub ? String(s.hub) : null;
  if (hub && !members.includes(hub)) throw new Error(`허브는 구성원이어야 합니다: ${hub}`);
  const suite: Suite = { name: s.name, label, members, hub };
  const list = loadSuites().filter((x) => x.name !== s.name);
  list.push(suite);
  saveSuites(list);
  return suite;
}

export function removeSuite(name: string): boolean {
  const list = loadSuites();
  const next = list.filter((x) => x.name !== name);
  if (next.length === list.length) return false;
  saveSuites(next);
  return true;
}

/**
 * 설치 순서 — 제공자 먼저. 구성원의 edges(tools·mission·components)가 가리키는 provider 가 같은
 * 묶음 안에 있으면 그 뒤에 선다. 순환은 fail-loud: 서로를 먼저 요구하는 두 패키지는 어느 순서로도
 * 앉힐 수 없다. 구성원 밖의 provider 는 보지 않는다 — 그건 받는 기판이 이미 갖고 있어야 하는 것이고,
 * 없으면 그쪽 설치가 사유와 함께 죽는다(resolveComponentEdges).
 */
export function installOrder(ledger: Ledger, members: string[]): string[] {
  const set = new Set(members);
  const deps = new Map<string, Set<string>>();
  for (const m of members) {
    const rec = ledger.packages[m];
    if (!rec) throw new Error(`미설치 패키지: ${m}`);
    const d = new Set<string>();
    for (const e of loadManifest(rec.path).edges ?? []) {
      const p = resolveProvider(ledger, e.provider);
      if (p && p !== m && set.has(p)) d.add(p);
    }
    deps.set(m, d);
  }
  const out: string[] = [];
  const done = new Set<string>();
  let rest = [...members];
  while (rest.length) {
    const ready = rest.filter((m) => [...deps.get(m)!].every((d) => done.has(d)));
    if (!ready.length) throw new Error(`설치 순서를 정할 수 없습니다 — 서로를 먼저 요구합니다: ${rest.join(", ")}`);
    for (const m of ready) {
      out.push(m);
      done.add(m);
    }
    rest = rest.filter((m) => !done.has(m));
  }
  return out;
}

/**
 * 폴더의 실제 내용물 — 구성원 + 구성원 화면이 결재로 마운트하는 제공자들(components 결재, 이행적).
 * 사이드바가 허브 밑에 접어 보여 주는 것이 곧 이것이라, 봉투도 같은 것을 담아야 "폴더째 내보내기"가
 * 말 그대로가 된다. 놓치면 받는 쪽에서 허브 설치가 provider 미설치로 죽는다(resolveComponentEdges).
 * tools·mission 결재의 제공자는 넣지 않는다 — 그 결재는 설치 뒤의 별도 걸음이라 설치를 막지 않는다
 */
export function suiteClosure(ledger: Ledger, members: string[]): string[] {
  const out = [...new Set(members.filter((m) => !!ledger.packages[m]))];
  for (let i = 0; i < out.length; i++) {
    for (const g of ledger.grants) {
      if (g.consumer === out[i] && g.components && ledger.packages[g.provider] && !out.includes(g.provider)) out.push(g.provider);
    }
  }
  return out;
}

export interface SuitePackResult {
  file: string;
  name: string;
  digest: string;
  size: number;
  packages: SuiteManifest["packages"];
}

/**
 * 묶음 굽기. 폴더의 내용물(suiteClosure)마다 설치본(장부 path = 릴리스 스냅샷)을 packDir 로 구워 안쪽
 * 봉투로 담는다 — 선반의 개별 봉투 굽기와 같은 길이라 봉인·서명·선언 밖 파일 제외가 그대로 지켜진다.
 * outFile 미지정이면 선반(artifacts)에 <이름>.relaypackages 로 앉는다(같은 묶음은 같은 자리를 덮는다).
 */
export function packSuite(ledger: Ledger, name: string, outFile?: string): SuitePackResult {
  const suite = loadSuites(ledger).find((s) => s.name === name);
  if (!suite) throw new Error(`없는 묶음: ${name}`);
  if (!suite.members.length) throw new Error(`빈 묶음: ${name} — 설치본이 하나도 남아 있지 않습니다`);
  const order = installOrder(ledger, suiteClosure(ledger, suite.members));
  fs.mkdirSync(path.join(RELAY_HOME, "run"), { recursive: true });
  const work = fs.mkdtempSync(path.join(RELAY_HOME, "run", "suite-pack-"));
  try {
    const entries: TarEntry[] = [];
    const packages: SuiteManifest["packages"] = [];
    let hubRef: string | null = null;
    for (const m of order) {
      const r = packDir(ledger.packages[m].path, path.join(work, m + ".relay"));
      const file = `packages/${artifactFileName(r.ref, r.version)}`;
      entries.push({ rel: file, content: fs.readFileSync(r.file), mode: 0o644 });
      if (fs.existsSync(r.file + ".sig")) entries.push({ rel: file + ".sig", content: fs.readFileSync(r.file + ".sig"), mode: 0o644 });
      packages.push({ ref: r.ref, version: r.version, display_name: r.manifest.display_name, file, digest: r.digest });
      if (suite.hub === m) hubRef = r.ref;
    }
    const manifest: SuiteManifest = { schema: SUITE_SCHEMA, name: suite.name, label: suite.label, hub: hubRef, packages };
    entries.push({ rel: SUITE_MANIFEST, content: Buffer.from(JSON.stringify(manifest, null, 2) + "\n"), mode: 0o644 });
    const gz = packEntries(entries);
    const digest = sha256Of(gz);
    const file = outFile ? path.resolve(outFile) : path.join(artifactsDir(), suite.name + SUITE_EXT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, gz);
    logLine("pack", { suite: suite.name, digest, size: gz.length, packages: packages.map((p) => `${p.ref}@${p.version}`) });
    return { file, name: suite.name, digest, size: gz.length, packages };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** 이 파일이 묶음 봉투인가 — 헤더만 걷어 relay-suite.json 의 실재로 본다. 확장자는 보지 않는다:
 *  브라우저 업로드는 이름이 남지 않는다. 열리지 않는 파일은 "아니다"이고, 그 사유는 뒤이어 여는 쪽이 낸다 */
export function isSuiteArchive(file: string): boolean {
  try {
    return listArtifact(file).includes(SUITE_MANIFEST);
  } catch {
    return false;
  }
}

export interface PreparedSuite {
  /** API 왕복용 토큰 — 동의 관문의 열쇠(store.ts) */
  id: string;
  name: string;
  label: string;
  /** 허브의 ref — 활성 뒤 설치 이름으로 옮겨 적는다 */
  hub: string | null;
  digest: string;
  size: number;
  /** 설치 순서대로 — 각각 릴리스 자리에 이미 전개·판정된 상태(prepareArtifact). 코드는 아직 한 줄도 돌지 않았다 */
  items: Prepared[];
}

/**
 * 묶음 준비 — 봉투를 열어 안쪽 봉투를 하나씩 prepareArtifact 에 넘긴다(봉인 검증·전개·판정·고지서,
 * 전부 정적). 안쪽 봉인은 묶음 매니페스트가 적은 값과 같아야 한다: 묶음을 열어 하나를 바꿔 끼운
 * 것을 여기서 거른다. 동의는 묶음 단위 한 번이고 활성은 activateSuite 가 적힌 순서대로 한다.
 */
export async function prepareSuite(ledger: Ledger, file: string): Promise<PreparedSuite> {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`없는 파일: ${file}`);
  fs.mkdirSync(path.join(RELAY_HOME, "run"), { recursive: true });
  const staging = fs.mkdtempSync(path.join(RELAY_HOME, "run", "suite-"));
  try {
    const written = unpackArtifact(abs, staging);
    if (!written.includes(SUITE_MANIFEST)) throw new Error(`묶음 봉투가 아닙니다 — ${SUITE_MANIFEST} 이 없습니다`);
    const sm = JSON.parse(fs.readFileSync(path.join(staging, SUITE_MANIFEST), "utf8")) as SuiteManifest;
    if (sm.schema !== SUITE_SCHEMA) throw new Error(`묶음 매니페스트 schema 불일치: ${String(sm.schema)} (기대 ${SUITE_SCHEMA})`);
    if (!SLUG.test(sm.name ?? "")) throw new Error(`묶음 이름 형식 위반: ${String(sm.name)}`);
    if (!Array.isArray(sm.packages) || !sm.packages.length) throw new Error("묶음에 패키지가 없습니다");
    const items: Prepared[] = [];
    for (const p of sm.packages) {
      if (!p.file || p.file.startsWith("/") || p.file.split("/").includes("..")) throw new Error(`묶음 매니페스트의 경로 위반: ${String(p.file)}`);
      const inner = path.join(staging, p.file);
      if (!fs.existsSync(inner)) throw new Error(`묶음 안에 없는 봉투: ${p.file}`);
      verifyArtifact(inner, p.digest);
      items.push(await prepareArtifact(ledger, inner, { digest: p.digest }));
    }
    return {
      id: crypto.randomBytes(12).toString("hex"),
      name: sm.name,
      label: (sm.label ?? "").trim() || sm.name,
      hub: sm.hub ?? null,
      digest: sha256File(abs),
      size: fs.statSync(abs).size,
      items,
    };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 묶음 활성 — 적힌 순서대로 앉히고(제공자 먼저), 그 설치 이름들로 묶음을 기록한다.
 *  같은 이름의 묶음이 이미 있으면 갈아 끼운다: 다시 받은 묶음이 폴더를 둘로 만들지 않는다 */
export async function activateSuite(ledger: Ledger, ps: PreparedSuite): Promise<{ suite: Suite; results: InstallResult[] }> {
  const results: InstallResult[] = [];
  for (const p of ps.items) results.push(await activatePrepared(ledger, p));
  const members = ps.items.map((p) => p.name);
  const hub = ps.hub ? ps.items.find((p) => p.ref === ps.hub)?.name ?? null : null;
  const suite = upsertSuite(ledger, { name: ps.name, label: ps.label, members, hub });
  return { suite, results };
}

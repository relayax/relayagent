// release.ts — 불변 스냅샷의 자리(~/.relay/releases/<이름>/<버전>/)와 그 위의 두 동사.
//
// draft 와 가른 이유: 릴리스는 draft 없이도 성립한다. 봉투로 설치한 패키지도
// releases/ 아래 스냅샷을 갖고(prepareArtifact), 그것을 열거하고 되돌릴 수 있다.
// 발행(publishDraft)만이 draft 의 종결 동사라 그쪽에 남는다 — 편집 이력을 커밋·태그하고
// 스냅샷을 뜨는 일은 draft 를 아는 쪽의 몫이다.
//
// 장부 전환은 rec.path 만 바꾼다 — ring·workspace·model·harness 는 결재·설정이라
// 판을 갈아도 지우지 않는다(installPkg·publishDraft 와 같은 계약).
import fs from "node:fs";
import path from "node:path";
import { RELAY_HOME, saveLedger, type Ledger } from "./ledger.ts";
import { loadManifest, type Manifest } from "./manifest.ts";
import { buildView } from "../runtime/view.ts";

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function assertSlug(name: string): void {
  if (!SLUG.test(name)) throw new Error(`이름 형식 위반: ${name}`);
}

/** 릴리스 뿌리 — draft(작업 사본)와 달리 여기 것은 불변이다 */
export function releasesPath(name: string): string {
  return path.join(RELAY_HOME, "releases", name);
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
export async function rollbackRelease(ledger: Ledger, name: string, version: string): Promise<{ name: string; version: string; path: string; manifest: Manifest }> {
  assertSlug(name);
  const snapshot = path.join(releasesPath(name), version);
  if (!fs.existsSync(snapshot)) throw new Error(`없는 릴리스: ${name}@${version}`);
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(snapshot);
  rec.path = snapshot;
  saveLedger(ledger);
  const build = await buildView(name, snapshot, m);
  if (build && !build.ok) throw new Error(`롤백 빌드 실패: ${build.out}`);
  return { name, version, path: snapshot, manifest: m };
}

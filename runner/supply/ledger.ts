import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

// .env = 체크아웃에 앉는 인스턴스 설정 (개발 인스턴스 = 자기 .env 를 가진 체크아웃 하나).
// 셸의 실제 환경변수가 항상 .env 를 이긴다. 항목은 .env.example 참조
const ENV_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");
if (fs.existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// 기판 데이터 정본은 전부 RELAY_HOME(기본 ~/.relay) 한 곳이다. 백업 = 이 디렉토리, 제거 = rm -rf 이 디렉토리.
// version / ledger.json / sessions/<pkg>/<slot>/{bundle,history.jsonl,label} / logs / vault.json / run
// releases/<pkg>/<버전> (도는 판 — 장부 path 가 가리킨다. 사람이 만지면 실행본이 흔들린다)
// 이 디렉토리는 기판 장기다: 모든 세션에 deny 로 주입되어 에이전트 도구 호출이 닿지 않는다.
// 에이전트가 딛는 땅은 둘뿐 — workspace(설치 때 결재된 폴더)와 stage(파일 교환 무대)
// RELAY_HOME + RELAY_PORT 를 함께 바꾸면 기판 인스턴스가 통째로 분리된다 (개발용 = 별도 홈 + 별도 포트)
export const RELAY_HOME = process.env.RELAY_HOME
  ? path.resolve(expandHome(process.env.RELAY_HOME))
  : path.join(os.homedir(), ".relay");
export const API_PORT = Number(process.env.RELAY_PORT ?? 4747);
if (!Number.isInteger(API_PORT) || API_PORT < 1 || API_PORT > 65535) {
  throw new Error(`RELAY_PORT: 포트가 아니다: ${process.env.RELAY_PORT}`);
}
export const API_URL = `http://127.0.0.1:${API_PORT}`;
// 폴더 결재의 기본 홈. workspace 미기록 패키지의 cwd 와 stage 가 이 아래 앉는다.
// 인스턴스별 분리 대상이 아니다: workspace 는 패키지별 결재로 이미 재지정 가능
const WORKSPACE_HOME = path.join(os.homedir(), "Relay");
const LAYOUT_VERSION = "2";

// 저작 트리 — 사람이 열어 보고 고치는 자리라 기판 장기가 아니라 **보이는 땅**에 산다.
// 여기 있는 것은 작업 사본(draft)뿐이고, 릴리스 스냅샷은 따라오지 않는다: 그건 도는 판이라
// 손대면 실행본이 흔들린다(draft.ts 머리 주석의 두 층 그대로).
// system 패키지가 `dir: ~/Relay/packages` 로 이 폴더에 문을 낸다 — 선언은 좌표에 이름을 붙일
// 뿐이고 폴더의 주인은 기판이다(같은 사실을 두 곳에 적지 않는다).
const PACKAGES_HOME = path.join(WORKSPACE_HOME, "packages");

/** 저작 트리의 좌표 — **만들지 않는다**(sessionPath 와 같은 결: 열거·조회는 실재를 전제하지 않는다) */
export function packagesPath(): string {
  return PACKAGES_HOME;
}

function ensureLayout(): void {
  for (const d of [RELAY_HOME, path.join(RELAY_HOME, "logs"), path.join(RELAY_HOME, "run")]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const v = path.join(RELAY_HOME, "version");
  const cur = fs.existsSync(v) ? fs.readFileSync(v, "utf8").trim() : null;
  if (cur === "1") migrateDrafts();
  if (cur !== LAYOUT_VERSION) fs.writeFileSync(v, LAYOUT_VERSION + "\n");
}

/**
 * layout 1 → 2 — 저작 트리가 ~/.relay/drafts 에서 ~/Relay/packages 로 나왔다.
 * 사용자의 작업 사본이라 조용히 버리지 않는다: 옮길 수 있는 것은 옮기고, 이름이 겹치는 것은
 * 그 자리에 남긴 뒤 로그에 적는다(덮어쓰면 둘 중 하나의 작업이 사라진다 — 어느 쪽이 최신인지
 * 기판은 모른다). RELAY_HOME 을 다른 볼륨에 둔 인스턴스가 있으므로 rename 실패는 복사로 받는다.
 */
function migrateDrafts(): void {
  const old = path.join(RELAY_HOME, "drafts");
  if (!fs.existsSync(old)) return;
  fs.mkdirSync(PACKAGES_HOME, { recursive: true });
  for (const name of fs.readdirSync(old)) {
    const from = path.join(old, name);
    const to = path.join(PACKAGES_HOME, name);
    if (fs.existsSync(to)) {
      logLine("layout", { migrate: "drafts", name, skipped: "같은 이름이 이미 있습니다", from });
      continue;
    }
    try {
      fs.renameSync(from, to);
    } catch {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
  }
  if (!fs.readdirSync(old).length) fs.rmdirSync(old);
}

/**
 * 설치 출처. 아티팩트(.relay)나 레지스트리에서 온 패키지의 신원 — 장부 키(설치 이름)는
 * 로컬 사정으로 바뀔 수 있으므로 ref 가 정본이다. 업데이트 대상 판정과 이름 충돌 해소,
 * 유출 추적이 전부 이 기록을 본다. 로컬 디렉토리 설치는 origin 이 없다.
 */
export interface PkgOrigin {
  /** 레지스트리 URL. 파일 직접 설치는 null */
  registry: string | null;
  /** 패키지 정식 이름 (@scope/name) */
  ref: string;
  version: string;
  /** 아티팩트 sha256 — 받은 것이 올린 그것이라는 증명 */
  digest: string;
  installedAt: string;
}

export interface PkgRecord {
  path: string;
  /** 폴더 결재의 기록 — 세션 cwd 의 절대경로. 미기록 = 기본 ~/Relay/<이름> */
  workspace?: string;
  ring?: 0;
  model?: string;
  /** 추론 강도 — RELAY_EFFORT 로 전달. 어댑터가 모르는 값은 무시한다 (capabilities: effort) */
  effort?: string;
  harness?: string;
  dirBindings?: Record<string, string>;
  origin?: PkgOrigin;
}

export interface Grant {
  consumer: string;
  provider: string;
  tools?: string[];
  mission?: string;
  /** components 소비 결재 — 설치가 edge 를 해석하면 앉고, 집행은 서빙이 심는 import map 이다 */
  components?: boolean;
}

export interface Ledger {
  secret: string;
  packages: Record<string, PkgRecord>;
  grants: Grant[];
}

const LEDGER = path.join(RELAY_HOME, "ledger.json");

export function loadLedger(): Ledger {
  ensureLayout();
  if (!fs.existsSync(LEDGER)) {
    const fresh: Ledger = { secret: crypto.randomBytes(24).toString("hex"), packages: {}, grants: [] };
    saveLedger(fresh);
    return fresh;
  }
  return JSON.parse(fs.readFileSync(LEDGER, "utf8"));
}

export function saveLedger(l: Ledger): void {
  fs.mkdirSync(RELAY_HOME, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

export function pkgToken(l: Ledger, name: string): string {
  return crypto.createHmac("sha256", l.secret).update(name).digest("hex").slice(0, 40);
}

export function tokenToPkg(l: Ledger, token: string): string | null {
  for (const name of Object.keys(l.packages)) if (pkgToken(l, name) === token) return name;
  return null;
}

/** 세션 살림의 좌표 — **만들지 않는다**. 실재를 전제하지 않는 소비(이력 읽기·삭제·열거)의
 *  자리다. sessionDir 로 읽으면 없는 세션을 조회하는 것만으로 빈 살림이 생기고, 그 빈 디렉토리가
 *  목록에 유령 행으로 선다(라벨 = 슬롯 이름) */
export function sessionPath(pkg: string, slot: string): string {
  return path.join(RELAY_HOME, "sessions", pkg, slot.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

export function sessionDir(pkg: string, slot: string): string {
  const d = sessionPath(pkg, slot);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// workspace = 세션 cwd = 폴더 결재 하나. 패키지 디렉토리는 코드 정본으로 남고 작업 산출물은
// 전부 여기 앉는다. 대화(slot)가 바뀌어도 파일은 이어진다. 채팅 파일 교환은 stage 가 맡는다
export function workspacePath(l: Ledger, pkg: string): string {
  return l.packages[pkg]?.workspace ?? path.join(WORKSPACE_HOME, pkg);
}

export function workspaceDir(l: Ledger, pkg: string): string {
  const d = workspacePath(l, pkg);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// artifacts = 로컬 마켓 선반. relay pack 이 구운 .relay 아티팩트와 index.json 이 앉는다.
// 레지스트리가 생기면 이 선반의 index 가 원격 index 로 바뀔 뿐, 설치 경로는 같다
export function artifactsDir(): string {
  const d = path.join(RELAY_HOME, "artifacts");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// 스토어 인덱스 URL. 기본값 = 빈 문자열(원격 없음, 로컬 선반만) — OSS 는 스토어 없이 완결된 놀이터다.
// 스토어 연결은 원하는 쪽이 켠다: 데스크탑 앱이 번들 데몬에 주입하거나, RELAY_STORE_INDEX 로 직접 지정.
// 클라이언트는 이 설정과 인덱스 version 계약만 안다 — C2C 호환 규율 1
const DEFAULT_STORE_INDEX = "";
export const STORE_INDEX_URL = (process.env.RELAY_STORE_INDEX ?? DEFAULT_STORE_INDEX).trim();

// 다운로드 캐시. digest 를 파일명 키로 쓰므로 불변이다 — 같은 봉인은 다시 받지 않는다
export function artifactCacheDir(): string {
  const d = path.join(RELAY_HOME, "cache", "artifacts");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// stage = 파일 교환 무대. 업로드가 앉고 다운로드 라우트가 여기로만 봉인된다.
// workspace 와 분리하는 이유: workspace 가 ~ 처럼 넓어도 HTTP 로 나가는 범위는 여기뿐이어야 한다
export function stageDir(pkg: string): string {
  const d = path.join(WORKSPACE_HOME, ".stage", pkg);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function logLine(kind: string, data: unknown): void {
  const d = path.join(RELAY_HOME, "logs");
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(path.join(d, kind + ".jsonl"), JSON.stringify({ t: new Date().toISOString(), ...(data as object) }) + "\n");
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export const PRINCIPAL = os.userInfo().username;

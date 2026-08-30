import fs from "node:fs";
import path from "node:path";
import { binaryEnv } from "../supply/binaries.ts";
import { vaultGet } from "../vault.ts";
import { RELAY_HOME } from "../supply/ledger.ts";
import { loadManifest, type BinaryRequire, type HarnessVariant, type Manifest } from "../supply/manifest.ts";

/**
 * 어댑터를 부르는 두 답 — **실행 파일이 어디 있나**와 **어떤 env 로 부르나**.
 *
 * 종전에는 이 둘을 호출부 15곳이 각자 조립했고, 그래서 답이 갈렸다:
 * 경로는 전부 `path.join(rec.path, v.source, v.entry)` 였고(패키지 사본만 존재), env 는
 * 조리법이 다섯 가지였다 — binaryEnv 만(setHarness·harnessLogin·launchHarnessLogin·electHarness),
 * llmEnv(harnessVerb·probeHarness), RELAY_* 위에 조립(runSession), 맨 process.env(headless
 * 로그인), 아무것도 없음(발행 시 재선출). 결과가 화면에 나왔다: 금고에 키를 넣어도 setHarness 는
 * "준비 안 됨", probeHarness 는 "준비됨" — 두 화면이 다른 답을 냈다.
 *
 * 문을 하나로 모으면 그 갈림이 사라지고, 그 다음에 **풀**(기판 소유 어댑터)이 얹힐 자리가 생긴다.
 * 경로 해석이 한 곳이므로 "사본이냐 풀이냐" 판정도 한 곳이다.
 */

/** 자격 조회 문 — 기본은 금고 직독. 권위 이음새를 쥔 호출부(세션)는 그것을 넘긴다 */
export type CredentialLookup = (scope: string) => Promise<string | null>;

const localCredential: CredentialLookup = async (scope) => vaultGet(scope);

/** 기판 소유 어댑터 풀 — 홈 하위. 설치된 패키지가 하나도 없어도 여기 있는 것은 후보다.
 *
 *  자리 이름이 harness 가 아닌 이유: 그 자리는 이미 임자가 있다. 도구 사본의 구판 자리가
 *  `RELAY_HOME/harness/<pkg>` 였고 removeBinaries 가 패키지 제거 때 그것을 지운다 —
 *  풀을 거기 두면 `codex` 라는 이름의 앱을 지우는 순간 풀의 codex 어댑터가 함께 날아간다. */
export const POOL_DIR = path.join(RELAY_HOME, "adapters");

/** 풀 어댑터의 선언 — 동봉 변형의 선언에 **레시피 사본**이 더 붙는다.
 *  풀은 매니페스트를 잃으므로 requires.binaries 참조를 이름만으로는 풀 수 없다 */
export interface PoolVariant extends HarnessVariant {
  /** binary 가 가리키는 requires.binaries 항목의 사본 — 조달이 이것으로 돈다 */
  recipe?: BinaryRequire;
}

/** 어댑터 하나의 실행 좌표 */
export interface HarnessSite {
  variant: HarnessVariant;
  /** 실행 파일 절대경로 */
  entry: string;
  /** bundled = 패키지가 동봉한 사본 · pool = 기판이 대는 것 */
  origin: "bundled" | "pool";
}

/** 풀에 이 이름의 어댑터가 있나 — 있으면 그 실행 파일 경로 */
export function poolEntry(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null; // 경로 조작 차단 — 이름은 slug 다
  const entry = path.join(POOL_DIR, name, "run");
  try {
    return fs.statSync(entry).isFile() ? entry : null;
  } catch {
    return null;
  }
}

/** 풀 어댑터의 선언 — 패키지 relay.yaml 의 variants 항목에서 source·entry 를 뺀 나머지.
 *  풀은 패키지가 아니므로 선언이 앉을 매니페스트가 없다: 어댑터 옆에 harness.json 으로 둔다 */
export function poolVariant(name: string): PoolVariant | null {
  const entry = poolEntry(name);
  if (!entry) return null;
  const dir = path.join(POOL_DIR, name);
  let decl: Partial<PoolVariant> = {};
  try {
    decl = JSON.parse(fs.readFileSync(path.join(dir, "harness.json"), "utf8"));
  } catch { /* 선언 없는 어댑터 — 이름만으로 돈다(자격 주입도 provider 표시도 없다) */ }
  return { ...decl, name, source: dir, entry: "run" };
}

/** 풀 변형이 동봉 조달 레시피를 찾을 때의 답 — 풀에 실린 사본을 돌려준다.
 *  없으면 null 이고, 그때는 소비 패키지의 requires.binaries 가 답할 차례다(동봉 변형의 길) */
export function poolRecipe(name: string): BinaryRequire | null {
  return poolVariant(name)?.recipe ?? null;
}

/** 풀에 깔린 어댑터 이름들 (정렬) */
export function poolNames(): string[] {
  try {
    return fs.readdirSync(POOL_DIR).filter((n) => poolEntry(n) != null).sort();
  } catch {
    return []; // 아직 안 펴짐 — 후보는 동봉분뿐
  }
}

/**
 * 어댑터 실행 파일의 절대경로. **사본과 풀이 갈리는 유일한 자리다.**
 *
 * 규율: 풀에 같은 이름이 있으면 풀이 이긴다. 사본은 패키지마다 따로 살면서 기판과 따로
 * 갱신돼 왔고(같은 claude-code 어댑터가 판이 갈린 채 네 벌 돌던 것이 실측 2026-08-30),
 * 그중 하나는 protocol 2 화석이었다. 기판이 대는 것이 있으면 그것이 정본이다.
 * 풀에 없는 이름(패키지가 데려온 새 하네스)만 사본으로 돈다 — 그 길이 새 하네스의 문이다.
 */
export function harnessSite(pkgPath: string, v: HarnessVariant): HarnessSite {
  const pooled = poolEntry(v.name);
  if (pooled) return { variant: poolVariant(v.name) ?? v, entry: pooled, origin: "pool" };
  // resolve 인 이유: 풀 변형의 source 는 절대경로다. join 이면 pkgPath 아래로 잘못 접힌다
  return { variant: v, entry: path.resolve(pkgPath, v.source, v.entry), origin: "bundled" };
}

/** 경로만 필요한 자리의 축약 */
export function harnessEntry(pkgPath: string, v: HarnessVariant): string {
  return harnessSite(pkgPath, v).entry;
}

/**
 * 어댑터가 보는 env — 기판 도구 사본을 PATH 앞에 두고, 선언한 provider 자격을 그 이름으로 싣는다.
 *
 * kind 를 가리지 않는다: oauth 변형도 선언이 env 이름을 말하면 기판이 댈 수 있다(무인 기판에는
 * 로그인할 사람이 없다). 선언이 없으면 항등이라 1인 기판에서는 도구 자신의 로그인이 그대로 답이다.
 */
export async function harnessEnv(
  v: HarnessVariant | null | undefined,
  pkg: string,
  opts: { base?: NodeJS.ProcessEnv; credential?: CredentialLookup } = {},
): Promise<NodeJS.ProcessEnv> {
  const env = binaryEnv(pkg, opts.base);
  const llm = v?.llm ?? (v ? poolVariant(v.name)?.llm : undefined);
  if (llm?.auth?.env && llm.provider) {
    const cred = await (opts.credential ?? localCredential)(`llm/${llm.provider}`);
    if (cred) env[llm.auth.env] = cred;
  }
  return env;
}

/**
 * 이 패키지가 쓸 수 있는 하네스 후보 전부 — 동봉분과 풀의 합집합.
 *
 * 마이그레이션 규율: **동봉 이름이 풀에도 있으면 그 선언은 "검증됨"으로 읽고 후보를 풀 전체로
 * 연다.** 종전 문법에는 "이 하네스만 쓴다"와 "이 하네스로 시험했다"를 가르는 자리가 없어서,
 * 스캐폴드가 준 한 줄이 사용자에게는 잠금으로 도달했다(설치본 9개 중 8개가 claude-code 한 줄만
 * 동봉 → 피커에 선택지가 하나). 잠글 의도가 있으면 harness.requires 로 이유를 말한다.
 * 풀에 없는 이름을 동봉했으면 그것은 진짜 동봉이므로 후보에 더한다.
 */
export function harnessCandidates(m: Manifest): HarnessVariant[] {
  const out: HarnessVariant[] = [];
  const seen = new Set<string>();
  for (const v of m.harness?.variants ?? []) {
    if (seen.has(v.name)) continue;
    seen.add(v.name);
    // 풀에 같은 이름이 있으면 풀의 선언이 정본이다(사본의 낡은 llm 선언을 따르지 않는다)
    out.push(poolVariant(v.name) ?? v);
  }
  // 풀은 선언과 무관하게 후보다. 동봉이 풀에 없는 이름만 가진 패키지도 풀을 함께 본다 —
  // 그쪽은 "이 하네스를 데려왔다"이지 "다른 것을 금한다"가 아니기 때문이다(금지는 requires)
  for (const name of poolNames()) {
    if (seen.has(name)) continue;
    seen.add(name);
    const v = poolVariant(name);
    if (v) out.push(v);
  }
  return out;
}

// ── 풀 펴기 ────────────────────────────────────────────────────────────────
// 어댑터의 집은 여전히 패키지다(CLAUDE.md 규율 5) — 콘솔 패키지가 넷을 동봉하고, 기판은 그것을
// 홈 하위 풀로 편다. 풀이 하는 일은 소유가 아니라 **공유**다: 콘솔만 갖고 있던 어댑터를 모든
// 패키지가 보게 만든다. 그래서 스캐폴드가 claude-code 한 줄만 준 앱도 codex·kimi 로 열린다.
//
// 갱신은 출처 지문(mtime·size)으로 판정한다 — 앱이 새 판으로 갈리면 다음 기동에 다시 편다.

/** 디렉토리 하나의 싼 지문 — 내용을 읽지 않고 mtime·size 로 잰다(bundleSourceSig 와 같은 관용구) */
function dirSig(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string, depth: number): void => {
    if (depth > 3) return;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p, depth + 1);
        continue;
      }
      try {
        const st = fs.statSync(p);
        rows.push(`${p}:${st.size}:${st.mtimeMs}`);
      } catch { /* 사라진 파일 — 지문에서 빠진다 */ }
    }
  };
  walk(dir, 0);
  return rows.join("\n");
}

/** 풀 선언(harness.json)의 스키마 판. **지문에 섞는다.**
 *
 *  지문이 어댑터 소스의 mtime·size 만 보면 seedPool 의 **변환 코드**가 바뀐 것을 못 본다 —
 *  소스는 그대로인데 담아야 할 것이 늘었을 때 조기 반환해서 낡은 harness.json 이 남는다.
 *  실사고 2026-08-30: protocol·capabilities 를 담도록 고쳐도 이미 펴진 기판은 안 고쳐졌다.
 *  이 상수를 올리면 다음 기동이 전부 다시 편다. **선언에 축을 더할 때마다 올린다.** */
const DECL_SCHEMA = 2;

export interface PoolSeed {
  /** 이번에 편 어댑터 이름들 */
  seeded: string[];
  /** 출처 패키지의 설치 이름 */
  from: string;
}

/**
 * 콘솔 패키지가 동봉한 하네스 어댑터를 풀로 편다. 이미 같은 출처 지문이면 아무것도 하지 않는다.
 *
 * 아이콘은 어댑터 폴더 안으로 따라온다(풀에는 패키지 상대경로를 풀 좌표가 없다) — 선언에는
 * 폴더 안 파일 이름만 남고, 화면은 /harness/<name>/asset/<file> 로 받는다.
 */
export function seedPool(
  ledger: { packages: Record<string, { path: string }> },
  consoleName: string,
): PoolSeed | null {
  const rec = ledger.packages[consoleName];
  if (!rec) return null;
  let m: Manifest;
  try {
    m = loadManifest(rec.path);
  } catch {
    return null; // 판정 실패한 콘솔 — 풀은 이전 것을 그대로 둔다
  }
  const variants = m.harness?.variants ?? [];
  if (!variants.length) return null;

  // 판을 앞에 섞는다 — 소스가 그대로여도 변환이 바뀌면 다시 편다
  const sig = `decl=${DECL_SCHEMA}\n` + variants.map((v) => dirSig(path.resolve(rec.path, v.source))).join("\n--\n");
  const stamp = path.join(POOL_DIR, ".source");
  try {
    if (fs.readFileSync(stamp, "utf8") === sig) return null; // 그대로다
  } catch { /* 첫 펴기 */ }

  const seeded: string[] = [];
  for (const v of variants) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(v.name)) continue; // 풀 좌표는 slug 다
    const src = path.resolve(rec.path, v.source);
    if (!fs.existsSync(path.join(src, v.entry))) continue;
    const dst = path.join(POOL_DIR, v.name);
    fs.rmSync(dst, { recursive: true, force: true });
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    // 진입 이름은 풀에서 run 으로 통일한다 — 풀 좌표에 매니페스트가 없으니 이름이 곧 계약이다
    if (v.entry !== "run") fs.cpSync(path.join(src, v.entry), path.join(dst, "run"));
    try { fs.chmodSync(path.join(dst, "run"), 0o755); } catch { /* Windows */ }

    // 선언은 **손실 없이** 옮긴다. 풀 변형은 relay.yaml 을 잃으므로 여기 안 담긴 것은
    // 그대로 사라진다 — 그리고 harnessCandidates 가 poolVariant 로 동봉 선언을 통째로
    // 대체하므로, 빠뜨린 축은 "풀이 펴진 순간 선언이 증발" 로 나타난다.
    // 실사고 2026-08-30: protocol·capabilities 를 빠뜨려 harness.requires 가 전부 실패했다
    // (후보 넷이 모두 "능력 미선언" 이 되어 requires 를 선언한 패키지의 세션이 서지 않았다).
    const decl: Record<string, unknown> = {};
    if (v.protocol != null) decl.protocol = v.protocol;
    if (v.capabilities) decl.capabilities = [...v.capabilities];
    if (v.llm) decl.llm = { ...v.llm };
    // binary 는 **이름만으로는 못 쓴다**: 그 이름이 가리키는 레시피는 콘솔 패키지의
    // requires.binaries 에 사는데, 풀 변형을 쓰는 쪽은 자기 매니페스트에서 그 이름을 찾는다
    // (provisionForVariant 는 소비 패키지의 m 을 본다). 그래서 이름과 레시피를 함께 싣는다 —
    // 그러지 않으면 "도구 없음" 화면의 설치 버튼이 영원히 같은 오류를 되풀이한다
    if (v.binary) {
      decl.binary = v.binary;
      const recipe = (m.requires?.binaries ?? []).find((b) => b.name === v.binary);
      if (recipe) decl.recipe = { ...recipe };
    }
    for (const [key, rel] of [["icon", v.icon], ["llmIcon", v.llm?.icon]] as const) {
      if (!rel) continue;
      const file = path.basename(rel);
      try {
        fs.cpSync(path.resolve(rec.path, rel), path.join(dst, file));
        if (key === "icon") decl.icon = file;
        else (decl.llm as Record<string, unknown>).icon = file;
      } catch { /* 아이콘 없는 어댑터 — 화면이 머리글자로 그린다 */ }
    }
    fs.writeFileSync(path.join(dst, "harness.json"), JSON.stringify(decl, null, 2));
    seeded.push(v.name);
  }
  fs.mkdirSync(POOL_DIR, { recursive: true });
  fs.writeFileSync(stamp, sig);
  return { seeded, from: consoleName };
}

// ── 후보 선택 ──────────────────────────────────────────────────────────────

export interface HarnessChoice {
  variant: HarnessVariant | null;
  /** 못 고른 이유 — 화면과 오류가 이 문장을 그대로 쓴다. 고른 경우 null */
  reason: string | null;
  /** requires 를 만족한 후보 전부(고른 것 포함) */
  candidates: HarnessVariant[];
}

/** 이 변형이 요구 능력을 만족하나. 선언이 없는 변형은 **판정 불가**라 만족으로 세지 않는다 —
 *  모르는 것을 된다고 하면 requires 가 거짓말이 되고, 사용자는 안 도는 앱을 고르게 된다 */
function meetsRequires(v: HarnessVariant, requires: string[]): boolean {
  if (!requires.length) return true;
  const caps = new Set(v.capabilities ?? []);
  return requires.every((c) => caps.has(c));
}

/**
 * 이 패키지가 지금 돌 하네스 하나. 종전 activeHarness 의 자리이고, 두 가지가 다르다:
 * 후보가 동봉분만이 아니라 **풀을 포함**하고, 못 고르면 **조용히 첫 번째로 넘어가지 않는다**.
 *
 * 종전 `vs.find(...) ?? vs[0] ?? null` 은 업데이트로 변형이 사라졌을 때 장부는 codex 인데
 * 런타임은 말없이 claude 로 돌게 했다 — 화면과 실제가 갈리고 아무도 알려주지 않았다.
 *
 * 우선순위: 사용자가 이 앱에 정한 것 → 저자의 prefers → 사용자 전역 선호 → 후보 첫 번째.
 * 앞의 셋은 **후보 안에 있을 때만** 이긴다(사라진 이름은 조용히 무시되는 대신 다음으로 넘어간다).
 */
export function chooseHarness(m: Manifest, selected?: string, globalPrefer?: string): HarnessChoice {
  const all = harnessCandidates(m);
  if (!all.length) {
    return { variant: null, reason: "쓸 수 있는 하네스가 없습니다 — 기판 풀이 비어 있고 패키지도 어댑터를 동봉하지 않았습니다", candidates: [] };
  }
  const requires = m.harness?.requires ?? [];
  const candidates = all.filter((v) => meetsRequires(v, requires));
  if (!candidates.length) {
    const has = all.map((v) => `${v.name}(${(v.capabilities ?? []).join(",") || "능력 미선언"})`).join(", ");
    return {
      variant: null,
      reason: `이 앱은 ${requires.join(", ")} 능력이 필요한데 만족하는 하네스가 없습니다 — 후보: ${has}`,
      candidates: [],
    };
  }
  for (const want of [selected, m.harness?.prefers, globalPrefer]) {
    if (!want) continue;
    const hit = candidates.find((v) => v.name === want);
    if (hit) return { variant: hit, reason: null, candidates };
  }
  return { variant: candidates[0], reason: null, candidates };
}

/** chooseHarness 의 축약 — 이유가 필요 없는 호출부용 */
export function selectHarness(m: Manifest, selected?: string, globalPrefer?: string): HarnessVariant | null {
  return chooseHarness(m, selected, globalPrefer).variant;
}

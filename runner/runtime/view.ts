import { runCommand } from "../spawn.ts";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { logLine, type Ledger } from "../supply/ledger.ts";
import { loadManifest, landingAgentName, type Manifest } from "../supply/manifest.ts";

import { MIME, json, streamFile, streamFileRevalidated } from "../http.ts";
import { jail } from "./dirs.ts";
import { injectShell, BASE_FOR_JS } from "./shell.ts";

export interface BuildResult {
  ok: boolean;
  out: string;
}

const TIMEOUT = 10 * 60_000;

/**
 * assetsAtDaemonRootInDoc — 문서 하나가 자기 자산을 **데몬 루트**로 가리키는가.
 *
 * view 는 /pkg/<설치이름>/view/ 아래로 서빙된다(api.ts serveView). 그래서 발행물 안의
 * 루트절대 자산 URL 은 그 접두사를 달고 있어야 한다. RELAY_BASE_PATH 없이 구우면 next 는
 * basePath 를 "" 로 잡고 모든 /_next/... 를 루트절대로 굽는다 — **빌드는 통과하는데** 서빙된
 * 문서가 자기 스타일시트와 청크를 404 받는다(무스타일 + 하이드레이션 없음). 실사고 2건.
 *
 * 판정 술어: 루트절대 참조가 out/ 안의 **실제 파일로 그대로 해석되면** 접두사가 빠진 것이다.
 * 프레임워크 이름을 모르는 술어라 기판이 next 를 아는 지식이 늘지 않는다. 오탐도 없다 —
 * 접두사를 제대로 단 /pkg/x/view/_next/... 는 out/ 안에서 그 경로로 존재하지 않고, 데몬 루트가
 * 정본인 /assets/chat-app.js 도 out/ 안에 없다.
 *
 * 문서 단위로 분리한 이유: 서빙 시점(api.ts serveViewFile)은 이미 문서를 문자열로 들고 있고,
 * 빌드·판정 시점은 트리를 걷는다. 술어가 한 벌이어야 세 자리의 판정이 갈라지지 않는다.
 */
export function assetsAtDaemonRootInDoc(html: string, outDir: string): string[] {
  const bad = new Set<string>();
  for (const m of html.matchAll(/(?:href|src)="(\/[^"]*)"/g)) {
    const ref = m[1].split(/[?#]/)[0];
    if (ref === "/") continue;
    const local = path.join(outDir, ref);
    // 경로 탈출 참조는 자기 자산이 아니다
    if (local !== outDir && !local.startsWith(outDir + path.sep)) continue;
    try {
      if (fs.statSync(local).isFile()) bad.add(ref);
    } catch { /* 자기 자산 아님 — 판정 대상 아님 */ }
  }
  return [...bad].sort();
}

/**
 * assetsAtOtherMount — 문서가 **다른 마운트**의 자산을 가리키는가.
 *
 * 같은 트리가 두 좌표로 설 수 있게 되면서 생긴 판정이다(/pkg/ 와 /draft/). out 산출은 구울 때
 * 접두사가 문서에 박히므로, /pkg 좌표로 구운 발행물을 /draft 좌표에서 내면 문서는 200 으로
 * 나가는데 그 청크는 **도는 판의 것**을 끌어온다 — 미리보기가 자기 것이 아닌 코드를 그리고,
 * 화면은 멀쩡해 보인다. 실측에서 바로 걸린 형태다(cardnews-studio, 2026-08-25).
 *
 * assetsAtDaemonRoot 는 이것을 못 잡는다: 그 술어는 "루트절대 참조가 out/ 안의 실제 파일로
 * 해석되는가" 를 묻는데, /pkg/x/view/_next/... 는 out/ 안에서 그 경로로 존재하지 않아 통과한다.
 * 여기는 반대편에서 본다 — 마운트 접두사를 달고 있는데 **내 접두사가 아닌** 참조.
 *
 * 기판 소유 자산(/assets/…, /shell.js)은 대상이 아니다: 그것들은 데몬 루트가 정본이라
 * 어느 마운트에서 보든 같은 자리다.
 *
 * 보는 것은 **문서가 스스로 적재하는 것** 둘뿐이다 — <script src> 와 <link href>. 여기서
 * href 를 무차별로 보면 남의 앱으로 가는 링크(<a href="/pkg/detail-page/view/">)까지 걸린다:
 * 그건 자산이 아니라 이동이고, 앱끼리 서로 여는 것은 이 기판의 정상 동작이다(실측에서 정적
 * 화면 하나가 이 오판으로 통째 503 이 됐다). 이미지·iframe 도 뺀다 — 같은 이유로 남의 것을
 * 가리키는 게 정상이고, "같은 빌드가 다른 좌표에 박혔다" 는 위험의 형태가 아니다.
 */
export function assetsAtOtherMount(html: string, base: string): string[] {
  const bad = new Set<string>();
  const check = (raw: string): void => {
    const ref = raw.split(/[?#]/)[0];
    if (!/^\/(?:pkg|draft)\//.test(ref)) return;
    if (ref === base || ref.startsWith(base + "/")) return;
    bad.add(ref);
  };
  for (const m of html.matchAll(/<script\b[^>]*?\ssrc="([^"]*)"/gi)) check(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*?\shref="([^"]*)"/gi)) check(m[1]);
  return [...bad].sort();
}

/** 발행물 전체를 같은 술어로 훑는다. */
export function assetsAtDaemonRoot(outDir: string): string[] {
  const bad = new Set<string>();
  const walk = (dir: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (e.name === "_next") continue; // 청크는 문서가 아니다
      const child = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(child);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith(".html")) continue;
      try {
        for (const ref of assetsAtDaemonRootInDoc(fs.readFileSync(child, "utf8"), outDir)) bad.add(ref);
      } catch { /* 경합 삭제 */ }
    }
  };
  walk(outDir);
  return [...bad].sort();
}

/** 같은 프로젝트 디렉토리의 빌드는 겹치지 않는다 — 산출(out/)을 두 손이 동시에 쓰면 반쪽 번들이 된다.
 *  비동기가 되면서 생긴 자리다: 동기일 때는 겹칠 수가 없었다 */
const inflight = new Map<string, Promise<unknown>>();

/**
 * npm 프로젝트 하나를 굽는다 — view 와 components 가 같이 쓴다.
 * node_modules 부재는 최초 설치 신호다(재빌드는 install 을 건너뛴다 — 굽는 시간의 대부분이 여기다).
 * 같은 src 의 앞선 빌드가 돌고 있으면 그 뒤에 선다(앞선 것이 실패해도 이번 것은 돈다).
 */
async function runProjectBuild(src: string, label: string, env: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  const pj = path.join(src, "package.json");
  if (!fs.existsSync(pj)) {
    return { ok: false, out: `${label}/package.json 없음 — out 을 선언한 표면은 빌드 가능한 프로젝트여야 합니다` };
  }
  let pjObj: { scripts?: { build?: string } };
  try {
    pjObj = JSON.parse(fs.readFileSync(pj, "utf8"));
  } catch (e) {
    return { ok: false, out: `${label}/package.json 파싱 실패: ${e}` };
  }
  if (!pjObj.scripts?.build) return { ok: false, out: `${label}/package.json 에 scripts.build 없음` };

  const runNpm = (args: string[]) => {
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
    return runCommand(command, commandArgs, { cwd: src, env, timeout: TIMEOUT });
  };

  const prev = inflight.get(src) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(async (): Promise<{ ok: boolean; out: string }> => {
    const steps: string[] = [];
    if (!fs.existsSync(path.join(src, "node_modules"))) {
      const i = await runNpm(["install", "--no-audit", "--no-fund"]);
      if (i.status !== 0) {
        return { ok: false, out: `npm install ${i.timedOut ? "시한 초과" : "실패"}:\n${(i.stdout + i.stderr).trim().slice(-600)}` };
      }
      steps.push("npm install 완료");
    }
    const b = await runNpm(["run", "build"]);
    const tail = (b.stdout + b.stderr).trim().slice(-800);
    if (b.status !== 0) return { ok: false, out: [...steps, b.timedOut ? `빌드 시한 초과(${TIMEOUT / 60_000}분) — 죽였습니다` : "", tail].filter(Boolean).join("\n") };
    return { ok: true, out: steps.join("\n") };
  });
  inflight.set(src, run);
  try {
    return await run;
  } finally {
    if (inflight.get(src) === run) inflight.delete(src);
  }
}

/**
 * surfaces.components.out 이 선언되면 설치·발행이 굽는다. view 와 같은 규율이되 basePath 축이 없다:
 * 번들은 소비자 문서가 import map 으로 부르는 자립 ESM 이라 자기 자산을 문서 상대주소로 가리키지
 * 않는다(그래서 설치 이름을 알 필요가 없고, 굽기가 설치 이름과 무관해진다).
 *
 * 산출 계약은 진입점 하나다: <out>/index.js. 없으면 소비자의 import 가 404 로 죽는데 그건 소비자
 * 화면에서야 발견된다 — 굽는 자리에서 fail-loud 로 잡는다. 스타일은 번들 안에 탄다(문법의 스타일
 * 규율): 옆에 낸 CSS 는 소비자가 설치 이름이 박힌 주소를 조립해야 닿으므로 계약이 아니다.
 */
export async function buildComponents(pkgPath: string, m: Manifest): Promise<BuildResult | undefined> {
  const comp = m.surfaces?.components;
  if (!comp?.out) return undefined;

  const src = path.join(pkgPath, comp.source);
  const env = { ...(process.env as Record<string, string>), NEXT_TELEMETRY_DISABLED: "1" };
  const r = await runProjectBuild(src, comp.source, env);
  if (!r.ok) return r;

  const outDir = path.join(src, comp.out);
  const entry = path.join(outDir, "index.js");
  if (!fs.existsSync(entry)) {
    return {
      ok: false,
      out: [
        r.out,
        `빌드는 통과했지만 진입점이 없습니다: ${comp.source}/${comp.out}/index.js`,
        `번들러의 산출 이름을 index.js 로 맞추세요 — 소비자는 이 파일 하나를 import 합니다.`,
      ].filter(Boolean).join("\n"),
    };
  }
  return { ok: true, out: [r.out, `${comp.source}/${comp.out} 빌드됨 (index.js)`].filter(Boolean).join("\n") };
}

/**
 * surfaces.view.out 이 선언되면 발행이 굽는다. 굽지 않으면 out 은 빈 약속이다.
 * 기판은 view 를 /pkg/<설치이름>/view/ 아래로 서빙하는데 설치 이름은 설치 시점에 정해지므로
 * 빌드도 설치 시점에 돌고, 접두사를 RELAY_BASE_PATH 로 넘긴다.
 */
export async function buildView(pkg: string, pkgPath: string, m: Manifest, base?: string): Promise<BuildResult | undefined> {
  const view = m.surfaces?.view;
  if (!view?.out) return undefined;

  const src = path.join(pkgPath, view.source);
  const env = {
    ...(process.env as Record<string, string>),
    RELAY_BASE_PATH: base ?? viewBase(pkg),
    NEXT_TELEMETRY_DISABLED: "1",
  };

  const r = await runProjectBuild(src, view.source, env);
  if (!r.ok) {
    // §8-2 잔여: buildView 는 설치 파이프라인(installer·draft) 깊숙이 있어 authority 주입이
    // installPkg·activatePrepared·publishDraft 전 시그니처 연쇄를 일으킨다 — audit 이사는 보류
    logLine("build", { pkg, ok: false });
    return r;
  }
  const steps = r.out ? [r.out] : [];

  const outDir = path.join(src, view.out);
  if (!fs.existsSync(outDir)) {
    return { ok: false, out: `빌드는 통과했지만 산출 디렉토리가 없습니다: ${view.source}/${view.out}` };
  }
  // 선언(basePath 를 주입했다) ↔ 현실(발행물이 그 접두사를 달았다) 대조. next.config 가
  // RELAY_BASE_PATH 를 읽지 않는 view 는 여기서 걸린다 — 서빙에서 404 로 발견되기 전에.
  const atRoot = assetsAtDaemonRoot(outDir);
  if (atRoot.length) {
    logLine("build", { pkg, ok: false });
    return {
      ok: false,
      out: [
        ...steps,
        `빌드는 통과했지만 발행물이 자기 자산을 데몬 루트로 가리킵니다 — ${env.RELAY_BASE_PATH} 접두사가 빠졌습니다:`,
        ...atRoot.slice(0, 5).map((r) => `  ${r}`),
        atRoot.length > 5 ? `  … 외 ${atRoot.length - 5}건` : "",
        `${view.source} 의 next.config 가 RELAY_BASE_PATH(=basePath)를 읽는지 확인하세요. 이대로 서빙하면 스타일시트·청크가 404 입니다.`,
      ].filter(Boolean).join("\n"),
    };
  }
  // 접두사가 붙어 있긴 한데 **주입한 것과 다른** 경우 — 하드코딩·다른 env·프리빌드 out/.
  // 위 술어는 그런 참조를 out/ 안에서 해석하지 못해 통과시킨다. 여기는 선언(주입값)이 손에
  // 있는 유일한 자리다: validate 는 설치 이름을 모르므로 이 대조를 할 수 없다.
  const wrong = new Set<string>();
  const idx = path.join(outDir, "index.html");
  if (fs.existsSync(idx)) {
    const html = fs.readFileSync(idx, "utf8");
    for (const mm of html.matchAll(/(?:href|src)="(\/[^"]*_next\/[^"]*)"/g)) {
      if (!mm[1].startsWith(env.RELAY_BASE_PATH + "/")) wrong.add(mm[1].split(/[?#]/)[0]);
    }
  }
  if (wrong.size) {
    logLine("build", { pkg, ok: false });
    return {
      ok: false,
      out: [
        ...steps,
        `빌드는 통과했지만 발행물의 자산 접두사가 주입한 basePath(${env.RELAY_BASE_PATH})와 다릅니다:`,
        ...[...wrong].sort().slice(0, 5).map((r) => `  ${r}`),
        `${view.source} 의 next.config 가 basePath 를 RELAY_BASE_PATH 이외의 값(하드코딩·다른 env·프리빌드 산출)으로 잡고 있습니다. 이대로 서빙하면 스타일시트·청크가 404 입니다.`,
      ].join("\n"),
    };
  }
  // §8-2 잔여: 위와 같은 사유
  logLine("build", { pkg, ok: true, base: env.RELAY_BASE_PATH });
  return { ok: true, out: [...steps, `${view.source}/${view.out} 빌드됨 (basePath ${env.RELAY_BASE_PATH})`].join("\n") };
}


// ── components 좌표 ─────────────────────────────────────────────────────────
// 서빙이 쓰는 세 함수. supply 에 있으면 runtime → supply 역방향 import 가 되어
// install ↔ view 가 순환한다(install 은 이미 buildView 를 부른다 — 정방향은 그쪽).
// 셋 다 장부(데이터)만 읽고 설치 로직을 부르지 않으므로 서빙 쪽이 소유가 맞다.

/** 제공자 번들의 서빙 주소. 소비자 문서의 import map 이 이 값을 그대로 싣는다 —
 *  마운트 문법을 아는 쪽(기판)만이 조립한다(surfaces.view 와 같은 규율) */
export function componentBundleUrl(installName: string): string {
  return `/pkg/${encodeURIComponent(installName)}/components/index.js`;
}

// ── 두 좌표 ─────────────────────────────────────────────────────────────────
// 한 패키지의 화면은 두 자리에 설 수 있다. 설치본은 /pkg/<이름>/ 에서 도는 판이고, 작업 사본은
// /draft/<이름>/ 에서 **발행 전에 눈으로 보는 판**이다. 두 땅이 갈려 있는 것은 계약이라
// (draft.ts 머리말: 작업 사본은 보이는 땅, 릴리스는 기판 장기) 그대로 두고 문만 하나 더 낸다.
//
// 접두사가 발행물에 구워지므로(next basePath) 좌표는 **굽는 자리와 내는 자리가 같은 함수**를
// 봐야 한다. 그래서 여기 한 벌만 둔다 — 갈라두면 미리보기가 자기 청크를 404 받는다.
export const viewBase = (pkg: string): string => `/pkg/${encodeURIComponent(pkg)}/view`;
export const draftViewBase = (pkg: string): string => `/draft/${encodeURIComponent(pkg)}/view`;
export const draftComponentBundleUrl = (pkg: string): string => `/draft/${encodeURIComponent(pkg)}/components/index.js`;

/**
 * 한 문서를 내는 데 필요한 것 전부. serveView 가 장부에서, serveDraftView 가 작업 사본에서
 * 같은 모양으로 만들어 같은 서빙 함수에 넘긴다 — 두 좌표가 갈라지지 않는 유일한 방법이다.
 */
interface ViewMount {
  pkg: string;
  /** 서빙 뿌리 — out 선언이면 산출 디렉토리, 아니면 source */
  root: string;
  /** 문서가 자기 자산에 달아야 할 접두사 */
  base: string;
  /** __RELAY_CONTEXT.base — 대화 위젯이 지나는 API 접두사. null 이면 주입하지 않는다 */
  api: string | null;
  /** 작업 사본의 문 — 위젯이 세션을 작업 사본 위에 민팅한다(__RELAY_CONTEXT.draft) */
  draft?: boolean;
  imports: Record<string, string>;
  fav: string;
  /** 접두사 판정이 실패했을 때 화면이 내미는 처방 */
  rebuild: string;
  /** 실패를 무엇으로 낼 것인가. 문의 손님이 정한다 — 미리보기 문은 언제나 브라우저가 열고,
   *  그 자리에 생 JSON 이 뜨면 사람은 무엇을 해야 하는지 알 수 없다(프레임 안에서는 특히) */
  faults: "json" | "html";
}

/**
 * 미리보기 문의 실패 화면. 처방이 판정의 본체라는 규율(규칙 2)을 사람이 읽는 자리로 옮긴 것뿐이다 —
 * 같은 사실을 JSON 으로도 내지만, 프레임 안에서는 그것이 아무것도 알려주지 않는다.
 */
function faultDoc(title: string, body: string, hint?: string): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;
      font:14px/1.7 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;
      background:#fafafa;color:#171717;padding:28px;box-sizing:border-box}
 main{max-width:460px;text-align:center}
 h1{margin:0 0 10px;font-size:15px;font-weight:600}
 p{margin:0 0 8px;font-size:13px;color:#737373}
 code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f0f0f0;border-radius:5px;padding:2px 6px}
 @media (prefers-color-scheme:dark){body{background:#171717;color:#e5e5e5}p{color:#a3a3a3}code{background:#262626}}
</style></head><body><main>
<h1>${esc(title)}</h1><p>${esc(body)}</p>${hint ? `<p><code>${esc(hint)}</code></p>` : ""}
</main></body></html>`;
}

/** 문의 손님에 맞춰 실패를 낸다 — 같은 사실, 다른 표현 */
function fault(
  mount: Pick<ViewMount, "faults" | "rebuild">,
  res: http.ServerResponse,
  status: number,
  title: string,
  body: string,
  hint?: string,
  /** json 문의 문구 — 종전 응답을 그대로 두기 위한 자리다(도는 판의 계약은 이 변경의 대상이 아니다) */
  jsonError?: string,
): void {
  if (mount.faults === "json") return void json(res, status, { error: jsonError ?? `${title} — ${body}` });
  res.writeHead(status, { "content-type": MIME[".html"], "cache-control": "no-store" });
  res.end(faultDoc(title, body, hint));
}

/** 제공자 번들의 트리 위 자리. out 미선언이면 source 가 곧 산출 디렉토리다(손저작 ESM) */
export function componentOutDir(pkgPath: string, m: Manifest): string | null {
  const comp = m.surfaces?.components;
  return comp ? path.join(pkgPath, comp.source, comp.out ?? "") : null;
}

/**
 * 서빙 시점의 import map 내용 — **결재**를 읽는다(선언이 아니라). 선언은 신청이고 장부에 앉은
 * 결재만이 화면에 심긴다. 판정하지 않고 조용히 건너뛰는 것이 여기서는 맞다: 서빙은 사용자를
 * 덮는 자리라 제공자가 지워진 뒤의 요청 하나가 문서 전체를 500 으로 만들면 안 된다. 빠진
 * 매핑은 소비자 화면의 import 실패로 드러나고, 그 진단은 설치·빌드 자리가 이미 들고 있다.
 */
export function componentImportsFor(ledger: Ledger, consumer: string): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const g of ledger.grants) {
    if (g.consumer !== consumer || !g.components) continue;
    const rec = ledger.packages[g.provider];
    if (!rec) continue;
    try {
      const pm = loadManifest(rec.path);
      if (pm.surfaces?.components) imports[pm.name] = componentBundleUrl(g.provider);
    } catch { /* 판정 실패한 제공자 — 매핑에서 빠진다 */ }
  }
  return imports;
}

// ── 서빙 ────────────────────────────────────────────────────────────────────
// 빌드와 한 파일인 이유: 접두사 판정 술어(assetsAtDaemonRoot)를 굽는 자리와 내는 자리가
// 같이 봐야 한다. 갈라두면 두 판정이 어긋나고, 그 어긋남이 실사고 2건의 형태였다.

/**
 * 작업 폴더의 파일 하나 — 패키지 자기 화면이 자기 산출물(구운 카드·로고)을 그리는 읽기전용 문.
 * GET /pkg/<설치이름>/workspace/<경로>.
 *
 * 동사가 본문을 JSON 에 실어 나르는 길은 파일 하나가 수백 KB 인 순간 목록이 통째로 무거워진다
 * (실측: 사진 박힌 카드). 결재 축은 아니다 — 화면도 폴더도 같은 패키지의 것이라 선언이 없다.
 * 대신 감금은 dir 문과 같은 벌(dirs.ts jail)을 지난다: 상대경로만·`..` 등반·심링크 탈출을 한
 * 판정으로 거부한다. 점으로 시작하는 조각과 폴더는 내지 않는다 — 목록도 숨은 파일도 이 문의
 * 일이 아니다. 응답은 재검증형(http.ts streamFileRevalidated): 같은 주소에 덮어쓰이는 산출물이
 * 옛 판으로 남던 것이 이 문이 생긴 이유의 절반이다.
 */
export function serveWorkspaceFile(root: string, rel: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  let target: string;
  try {
    target = jail(root, rel);
  } catch (e) {
    return void json(res, 403, { error: e instanceof Error ? e.message : String(e) });
  }
  if (path.relative(root, target).split(path.sep).some((seg) => seg.startsWith("."))) {
    return void json(res, 404, { error: "숨은 파일은 내지 않습니다" });
  }
  const st = fs.statSync(target, { throwIfNoEntry: false });
  if (!st || !st.isFile()) return void json(res, 404, { error: "없는 파일" });
  streamFileRevalidated(target, st, req, res);
}

export function serveView(ledger: Ledger, pkg: string, rest: string, res: http.ServerResponse): void {
  const rec = ledger.packages[pkg];
  if (!rec) return void json(res, 404, { error: `미설치 패키지: ${pkg}` });
  let m: Manifest;
  try {
    m = loadManifest(rec.path);
  } catch (e) {
    return void json(res, 500, { error: String(e) });
  }
  const view = m.surfaces?.view;
  if (!view) {
    // 화면 없는 대화형 패키지 — 위젯만 얹은 기본 대화 페이지를 서빙한다.
    // GUI 에서 카드를 눌러도 쓸 길이 없는 막다른 골목을 없애는 폴백이다.
    // 판정은 착지 에이전트의 실재다: "대화할 상대가 있는가" 를 별도 선언이 아니라 agents[] 가 답한다
    if (landingAgentName(m)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(chatFallbackDoc(pkg, m, "/pkg/" + encodeURIComponent(pkg), pkgIconHref(pkg, m), false));
    }
    return void json(res, 404, { error: `view 표면 없는 패키지: ${pkg}` });
  }
  const root = path.normalize(path.join(rec.path, view.source, view.out ?? ""));
  // out 선언은 서빙 뿌리 선언이다. 없으면 미빌드 — 소스로 물러나면 선언과 실체의 불일치가
  // "없음: /" 404 나 날 소스로 위장한다(규칙 2: 조용한 강등 금지). 처방이 판정의 본체다.
  if (view.out && !fs.existsSync(root)) {
    return void json(res, 503, {
      error: `view 미빌드: ${pkg} — 선언된 ${view.source}/${view.out} 이 없습니다: npm run relay -- build ${pkg}`,
    });
  }
  serveMounted({
    pkg,
    root,
    base: viewBase(pkg),
    api: `/pkg/${encodeURIComponent(pkg)}`,
    imports: componentImportsFor(ledger, pkg),
    fav: pkgIconHref(pkg, m),
    rebuild: `npm run relay -- build ${pkg}`,
    faults: "json",
  }, rest, res);
}

/**
 * 작업 사본의 화면 — 발행 전에 눈으로 보는 판. 설치본을 만지지 않고, 장부도 건드리지 않는다.
 *
 * 이 문이 없던 동안 스튜디오의 미리보기는 구조적으로 불가능했다: 서빙은 장부 rec.path(릴리스
 * 스냅샷)만 읽고 빌드는 발행 시점에만 돌았으므로, 고친 것을 보려면 **적용을 눌러 실제로 도는
 * 판을 갈아치우는 수밖에** 없었다. 미리보기가 발행을 요구하면 그건 미리보기가 아니다.
 *
 * 발행=커밋 교리와 부딪히지 않는다 — 여기서는 아무것도 커밋되지 않는다. 장부는 그대로고,
 * 도는 판도 그대로다. 바뀌는 것은 이 응답 하나뿐이다.
 */
export function serveDraftView(ledger: Ledger, pkg: string, pkgRoot: string, rest: string, res: http.ServerResponse): void {
  const F = { faults: "html" as const, rebuild: "스튜디오의 [미리보기 굽기]" };
  if (!fs.existsSync(pkgRoot)) {
    return void fault(F, res, 404, "작업 사본이 없습니다", `${pkg} 의 작업 사본을 찾지 못했습니다. 스튜디오에서 이 패키지를 한 번 열면 만들어집니다.`);
  }
  let m: Manifest;
  try {
    m = loadManifest(pkgRoot);
  } catch (e) {
    // 미리보기 중에는 매니페스트가 반쯤 고쳐진 상태일 수 있다 — 판정 실패를 그대로 알린다
    return void fault(F, res, 503, "relay.yaml 이 판정을 통과하지 못했습니다", String(e instanceof Error ? e.message : e).split("\n")[0], "왼쪽 [검사] 를 눌러 걸린 자리를 보세요");
  }
  const view = m.surfaces?.view;
  if (!view) {
    // 화면 없는 대화형 패키지 — 작업 사본 위 대화가 곧 미리보기다. 문(API)은 도는 판의 것이라
    // 설치된 적 없는 초안은 아직 말할 상대가 없다
    if (landingAgentName(m) && ledger.packages[pkg]) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(chatFallbackDoc(pkg, m, "/pkg/" + encodeURIComponent(pkg), draftIconHref(pkg, m), true));
    }
    return void fault(F, res, 404, "화면이 선언되지 않았습니다", "surfaces.view 를 선언하면 이 자리에 작업 사본의 화면이 뜹니다. 화면 없는 패키지의 미리보기는 대화가 맡습니다 — 한 번 적용한 뒤부터.");
  }
  const root = path.normalize(path.join(pkgRoot, view.source, view.out ?? ""));
  if (view.out && !fs.existsSync(root)) {
    return void fault(F, res, 503, "아직 굽지 않았습니다", `out 을 선언한 표면이라 굽기 전에는 낼 것이 없습니다 (${view.source}/${view.out} 없음).`, "미리보기 굽기");
  }
  // 자기 번들은 작업 사본 것을 본다 — 화면을 고치면서 그 화면이 마운트하는 부품도 같이 고치는
  // 것이 저작의 실제 모습이라, 여기서 설치본 번들을 물리면 한쪽만 새 판이 된다.
  const imports = componentImportsFor(ledger, pkg);
  if (m.surfaces?.components && m.name) imports[m.name] = draftComponentBundleUrl(pkg);
  serveMounted({
    pkg,
    root,
    base: draftViewBase(pkg),
    // 도는 판이 있으면 그 API 를 쓴다(대화·업로드가 갈 곳은 거기뿐이다). 없으면 주입하지
    // 않는다 — 없는 문을 가리키는 좌표를 심으면 위젯이 조용히 죽는다
    api: ledger.packages[pkg] ? `/pkg/${encodeURIComponent(pkg)}` : null,
    draft: true,
    imports,
    fav: draftIconHref(pkg, m),
    rebuild: `스튜디오의 [미리보기 굽기]`,
    faults: "html",
  }, rest, res);
}

/** 두 좌표가 공유하는 파일 해석 — 정적 발행물의 라우트 관례는 좌표와 무관하다 */
function serveMounted(mount: ViewMount, rest: string, res: http.ServerResponse): void {
  const root = mount.root;
  const target = path.normalize(path.join(root, rest === "" || rest === "/" ? "index.html" : rest));
  if (target !== root && !target.startsWith(root + path.sep)) return void fault(mount, res, 403, "경로 탈출", "발행물 뿌리 밖은 내지 않습니다.", undefined, "경로 탈출");
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // 정적 발행물의 라우트 관례: <경로>/index.html (trailingSlash) 또는 <경로>.html
    const idx = path.join(target, "index.html");
    if (fs.existsSync(idx)) return void serveViewFile(idx, mount, res);
    const html = target + ".html";
    if (fs.existsSync(html)) return void serveViewFile(html, mount, res);
    return void fault(mount, res, 404, "그 자리에 문서가 없습니다", `발행물 안에 ${rest || "index.html"} 이 없습니다.`, undefined, `없음: ${rest}`);
  }
  serveViewFile(target, mount, res);
}

/**
 * 패키지 컴포넌트 번들 서빙 — import map 이 가리키는 주소다(componentBundleUrl 의 짝).
 * no-store 인 이유는 채팅 위젯과 같다: 번들은 제공자의 재빌드와 원자적으로 움직여야 한다.
 * 소비자 문서가 캐시된 옛 번들을 들고 새 계약을 부르면 조용히 갈라지고 진단이 남지 않는다.
 */
export function serveComponents(ledger: Ledger, pkg: string, rest: string, res: http.ServerResponse): void {
  const rec = ledger.packages[pkg];
  if (!rec) return void json(res, 404, { error: `미설치 패키지: ${pkg}` });
  serveComponentsFrom(pkg, rec.path, rest, res, `npm run relay -- build ${pkg}`);
}

/** 작업 사본의 번들 — serveDraftView 와 같은 근거다. 장부를 지나지 않고 트리를 바로 읽는다 */
export function serveDraftComponents(pkg: string, pkgRoot: string, rest: string, res: http.ServerResponse): void {
  if (!fs.existsSync(pkgRoot)) return void json(res, 404, { error: `없는 작업 사본: ${pkg}` });
  serveComponentsFrom(pkg, pkgRoot, rest, res, `스튜디오의 [미리보기 굽기]`);
}

function serveComponentsFrom(pkg: string, pkgPath: string, rest: string, res: http.ServerResponse, rebuild: string): void {
  let m: Manifest;
  try {
    m = loadManifest(pkgPath);
  } catch (e) {
    return void json(res, 503, { error: `relay.yaml 판정 실패: ${String(e)}` });
  }
  const comp = m.surfaces?.components;
  if (!comp) return void json(res, 404, { error: `components 표면 없는 패키지: ${pkg}` });
  // out 선언은 서빙 뿌리 선언이다 — 미빌드를 소스로 강등하지 않는다(serveView 와 같은 규율)
  const root = path.normalize(componentOutDir(pkgPath, m)!);
  if (comp.out && !fs.existsSync(root)) {
    return void json(res, 503, {
      error: `components 미빌드: ${pkg} — 선언된 ${comp.source}/${comp.out} 이 없습니다: ${rebuild}`,
    });
  }
  const target = path.normalize(path.join(root, rest === "" || rest === "/" ? "index.js" : rest));
  if (target !== root && !target.startsWith(root + path.sep)) return void json(res, 403, { error: "경로 탈출" });
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return void json(res, 404, { error: `없음: ${rest}` });
  res.writeHead(200, { "content-type": MIME[path.extname(target)] ?? "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(target).pipe(res);
}

// 패키지 view 문서에 마운트 좌표를 심는다(client-protocol §2-6: 마운트를 아는 쪽이 주입한다).
// 이게 없으면 /assets 번들은 base 미주입으로 자동 마운트를 포기하고(main.tsx autoFloat 의
// fail-loud) mount() 도 뿌리 없는 상대 호출이 된다 — README §2 의 "스크립트 한 줄" 이 죽는다.
// 정적 발행물을 손대지 않고 서빙 시점에만 얹으므로 패키지 트리는 기판 마운트를 모른 채 남는다.
// 결재된 components 를 bare 이름으로 여는 import map. 좌표 주입과 같은 자리·같은 근거다:
// 마운트 문법을 아는 쪽은 기판뿐이라, 뷰는 `import { mount } from "@local/ui"` 만 쓴다.
// <head> 열림 직후에 심어야 한다 — import map 은 그것을 쓰는 첫 모듈 로드보다 앞서야 한다.
function componentImportMapTag(imports: Record<string, string>): string {
  if (!Object.keys(imports).length) return "";
  // </script> 조기 종료 방어 — 제공자 이름은 매니페스트에서 오는 남의 문자열이다
  const body = JSON.stringify({ imports }).replace(/</g, "\\u003c");
  return `<script type="importmap">${body}</script>`;
}

function viewContextTag(pkg: string, api: string, draft = false): string {
  // baseFor 동승(§2-6-a) — 이 문서의 패키지 말고 **다른 인스턴스**의 문 주소도 위젯이 알아야
  // 탭 하나가 자기 패키지에 말을 건다. 작업 사본 문서에서도 문 주소는 설치본의 것이다
  // (draft 는 base 가 아니라 별개 축 — 세션이 어느 나무 위에 서느냐를 가른다)
  return `<script>window.__RELAY_CONTEXT={base:${JSON.stringify(api)},root:"",instanceId:${JSON.stringify(pkg)},${BASE_FOR_JS}${draft ? ",draft:true" : ""}};</script>`;
}

/**
 * 화면 없는 대화형 패키지의 기본 대화 문서 — 위젯만 얹은 한 장. 설치본(/pkg)과 작업 사본(/draft)
 * 두 문이 같은 장을 낸다; draft 면 위젯이 세션을 작업 사본 위에 민팅한다.
 *
 * **탭 셸로 통일한다**(2026-08-29). 종전에는 이 문서만 `mount`(단일 pane)라, 화면 있는 패키지가
 * 얻는 것을 전부 놓쳤다 — 탭도, 보관함도, "이 화면에서 열 수 있는 대화" 안내도 없었다. 하필
 * 이 문서가 **화면 전체가 대화**인 패키지의 것이라, 에이전트를 여럿 둔 패키지에서 나머지
 * 상대에게 갈 문이 하나도 없었다(그 패키지엔 사이드바 항목도 하나뿐이다).
 * 탭 상태는 `variant="dock"` 의 저장소를 그대로 쓴다 — 화면 있는 패키지의 부유 도크와 **같은
 * 탭 묶음**이라, 화면을 오가도 열어 둔 대화가 따라온다.
 *
 * 선언은 **인스턴스 축만** 한다(declarePage — 대화 축 없음). 이 문서에는 `<AgentScope>` 를 쏠
 * 뷰 번들이 없어 `relay:scope` 가 오지 않으므로 크롬 자리에서 대신 알린다. 대화를 못박지 않는
 * 이유는 그것이 사실이기 때문이다: 이 문서는 "이 패키지의 대화 화면"이지 특정 슬롯의 페이지가
 * 아니다. 못박으면 "+ 새 대화"가 보던 탭이 아니라 페이지 좌표에서 갈라진다(ChatTabs PageDecl).
 * 슬롯 문자열을 기판이 조립하지 않는 규율(view-bridge §2-5)도 이 선택으로 함께 지켜진다.
 */
function chatFallbackDoc(pkg: string, m: Manifest, api: string, fav: string, draft: boolean): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  return injectShell(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${esc(fav)}">
<title>${esc(m.display_name ?? pkg)}${draft ? " · 작업 사본" : ""}</title>
<link rel="stylesheet" href="/assets/chat-app.css">
<style>html,body{height:100%;margin:0;background:#fafafa}#chat{height:100%;max-width:860px;margin:0 auto;box-sizing:border-box;border-left:1px solid var(--rc-line);border-right:1px solid var(--rc-line)}</style>
</head><body><div id="chat"></div>
${viewContextTag(pkg, api, draft)}<script>window.RELAY_CHAT_MANUAL=1;</script>
<script type="module">import { mountTabs } from "/assets/chat-app.js";
const h = mountTabs(document.getElementById("chat"), { instanceId: ${JSON.stringify(pkg)} });
h.declarePage({ instanceId: ${JSON.stringify(pkg)} });</script>
</body></html>`);
}

// 패키지 대표 아이콘의 서빙 주소 — 카드 아바타와 탭 favicon 이 같은 그림(manifest icon)을 본다
function pkgIconHref(pkg: string, m: Manifest): string {
  return m.icon ? `/pkg/${encodeURIComponent(pkg)}/asset/${m.icon}` : "/pkg/system/view/icon.svg";
}

// 작업 사본의 아이콘은 설치본 자산 문(/pkg/<이름>/asset/)에 없을 수 있다 — 아직 발행되지 않은
// 그림이면 그 문은 옛 판을 내거나 404 다. 미리보기는 자기 트리의 것을 봐야 한다.
function draftIconHref(pkg: string, m: Manifest): string {
  return m.icon ? `/draft/${encodeURIComponent(pkg)}/asset/${m.icon}` : "/pkg/system/view/icon.svg";
}

/**
 * 발행물 접두사 판정의 캐시. 키는 (뿌리, index.html mtime) — 빌드 한 번에 한 번만 stat 한다.
 *
 * 왜 서빙에도 판정이 있는가: 여기가 **사용자를 덮는 유일한 자리**다. validate 는 이 레포의
 * packages/* 만 걷지만 설치본은 rec.path 가 가리키는 아무 곳(마켓 산출·사용자 트리)에 산다.
 * 그 트리를 손으로 구운 사람에게는 판정해 줄 게 아무것도 없었고, 그래서 접두사 없는 발행물이
 * 200 으로 나가고 운영자는 /_next/... 404 벽만 보았다(실사고 2건, 진단은 어디에도 없었다).
 */
const prefixVerdicts = new Map<string, string[]>();
function assetsAtRootCached(root: string): string[] {
  let key = root;
  try {
    key = `${root}\u0000${fs.statSync(path.join(root, "index.html")).mtimeMs}`;
  } catch { /* 문서 없는 뿌리 — 뿌리만으로 캐시 */ }
  const hit = prefixVerdicts.get(key);
  if (hit) return hit;
  const bad = assetsAtDaemonRoot(root);
  prefixVerdicts.clear(); // 재빌드마다 키가 바뀐다 — 옛 키를 쌓아두지 않는다
  prefixVerdicts.set(key, bad);
  return bad;
}

function serveViewFile(file: string, mount: ViewMount, res: http.ServerResponse): void {
  const { pkg, root, fav, imports } = mount;
  if (path.extname(file) !== ".html") return void streamFile(file, res);
  const atRoot = assetsAtRootCached(root);
  if (atRoot.length) {
    const base = mount.base;
    logLine("view", { pkg, ok: false, base, at_root: atRoot.slice(0, 5) });
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    res.writeHead(500, { "content-type": MIME[".html"], "cache-control": "no-store" });
    return void res.end(injectShell(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>view 판정 실패: ${esc(pkg)}</title>
<style>body{font:14px/1.7 ui-monospace,monospace;margin:40px auto;max-width:760px;color:#111}code{background:#f5f5f5;padding:1px 4px;border-radius:3px}li{margin:2px 0}</style>
</head><body>
<h1>이 화면은 자기 자산을 데몬 루트로 가리킵니다</h1>
<p>발행물이 <code>${esc(base)}</code> 접두사 없이 구워져, 아래 자산이 서빙되지 않습니다:</p>
<ul>${atRoot.slice(0, 8).map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul>
<p><code>RELAY_BASE_PATH</code> 없이 <code>npx next build</code> 를 돌린 흔적입니다. 정본 경로로 다시 구우세요:</p>
<p><code>${esc(mount.rebuild)}</code></p>
<p>깨진 화면을 200 으로 내보내는 대신 여기서 멈춥니다 — 그 편이 <code>/_next</code> 404 벽보다 짧습니다.</p>
</body></html>`));
  }
  const html = fs.readFileSync(file, "utf8");
  // 두 좌표가 생긴 뒤의 두 번째 판정 — 이 문서가 **다른 마운트**의 청크를 부르는가.
  // 조용히 내보내면 미리보기가 도는 판의 코드를 그리고, 그 갈라짐은 화면상 아무 흔적이 없다
  const elsewhere = assetsAtOtherMount(html, mount.base);
  if (elsewhere.length) {
    logLine("view", { pkg, ok: false, base: mount.base, other_mount: elsewhere.slice(0, 5) });
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    res.writeHead(503, { "content-type": MIME[".html"], "cache-control": "no-store" });
    return void res.end(injectShell(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>다른 좌표로 구워진 발행물: ${esc(pkg)}</title>
<style>body{font:14px/1.7 ui-monospace,monospace;margin:40px auto;max-width:760px;color:#111}code{background:#f5f5f5;padding:1px 4px;border-radius:3px}li{margin:2px 0}</style>
</head><body>
<h1>이 발행물은 다른 자리에서 구워졌습니다</h1>
<p>지금 보고 있는 자리는 <code>${esc(mount.base)}</code> 인데, 문서가 부르는 자산은 다른 마운트를 가리킵니다:</p>
<ul>${elsewhere.slice(0, 8).map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul>
<p>그대로 내보내면 이 화면이 <b>다른 판의 코드</b>로 그려지고, 겉보기로는 구별되지 않습니다. 이 좌표로 다시 구우세요:</p>
<p><code>${esc(mount.rebuild)}</code></p>
</body></html>`));
  }
  // <head> 열림 직후 — 번들 로드보다 앞서야 한다(위젯이 로드 시점에 좌표를 읽고, import map 은
  // 그것을 쓰는 첫 모듈보다 앞서야 한다). <head> 가 없는 문서(손저작 단일 HTML 의 자연형)는
  // doctype 직후다: 0 에 심으면 doctype 앞에 내용이 생겨 문서가 quirks mode 로 떨어진다.
  const head = html.match(/<head\b[^>]*>/i) ?? html.match(/<!doctype[^>]*>/i);
  const at = head ? (head.index ?? 0) + head[0].length : 0;
  // favicon 도 좌표처럼 서빙 시점에 얹는다 — 발행물이 자기 favicon 을 선언했다면 그쪽을 존중
  const iconTag = /rel=["']?(?:shortcut\s+)?icon\b/i.test(html)
    ? ""
    : `<link rel="icon" href="${fav.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
  // 셸 크롬은 문서 말미다 — 좌표·import map 과 달리 렌더를 앞지를 이유가 없고, 패키지 문서의
  // 첫 페인트를 막지 않는다(defer). 주입 지점이 여기 하나뿐이라 "어떤 화면에는 사이드바가
  // 없다" 가 구조적으로 불가능하다. 미리보기 프레임에도 그대로 심는다 — 셸 스크립트가 top
  // 문서가 아니면 스스로 물러나므로(shell.ts 자가억제) iframe 안에서는 아무 일도 하지 않고,
  // 미리보기를 새 창으로 띄운 경우에는 크롬이 있는 편이 맞다
  const ctxTag = mount.api ? viewContextTag(pkg, mount.api, !!mount.draft) : "";
  res.end(injectShell(html.slice(0, at) + ctxTag + componentImportMapTag(imports) + iconTag + html.slice(at)));
}

// ── 세션 장부 조회 ─────────────────────────────────────────────────────────

// 권위 이음새 — 1인 기판은 로컬 권위(기본값). 조직 임베드는 여기 다른 구현을 꽂는다(api 는 모른다).
// opts 는 나머지 이음새의 같은 자리다(계약 축·문·스폰·문의 신뢰 좌표) — 전부 additive.

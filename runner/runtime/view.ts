import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { logLine, type Ledger } from "../supply/ledger.ts";
import { loadManifest, landingAgentName, type Manifest } from "../supply/manifest.ts";

import { MIME, json, streamFile } from "../http.ts";
import { injectShell } from "./shell.ts";

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

/**
 * npm 프로젝트 하나를 굽는다 — view 와 components 가 같이 쓴다.
 * node_modules 부재는 최초 설치 신호다(재빌드는 install 을 건너뛴다 — 굽는 시간의 대부분이 여기다).
 */
function runProjectBuild(src: string, label: string, env: Record<string, string>): { ok: boolean; out: string } {
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
    return spawnSync(command, commandArgs, { cwd: src, env, encoding: "utf8", timeout: TIMEOUT });
  };

  const steps: string[] = [];
  if (!fs.existsSync(path.join(src, "node_modules"))) {
    const i = runNpm(["install", "--no-audit", "--no-fund"]);
    if (i.status !== 0) {
      return { ok: false, out: `npm install 실패:\n${((i.stdout ?? "") + (i.stderr ?? "")).trim().slice(-600)}` };
    }
    steps.push("npm install 완료");
  }
  const b = runNpm(["run", "build"]);
  const tail = ((b.stdout ?? "") + (b.stderr ?? "")).trim().slice(-800);
  if (b.status !== 0) return { ok: false, out: [...steps, tail].join("\n") };
  return { ok: true, out: steps.join("\n") };
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
export function buildComponents(pkgPath: string, m: Manifest): BuildResult | undefined {
  const comp = m.surfaces?.components;
  if (!comp?.out) return undefined;

  const src = path.join(pkgPath, comp.source);
  const env = { ...(process.env as Record<string, string>), NEXT_TELEMETRY_DISABLED: "1" };
  const r = runProjectBuild(src, comp.source, env);
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
export function buildView(pkg: string, pkgPath: string, m: Manifest): BuildResult | undefined {
  const view = m.surfaces?.view;
  if (!view?.out) return undefined;

  const src = path.join(pkgPath, view.source);
  const env = {
    ...(process.env as Record<string, string>),
    RELAY_BASE_PATH: `/pkg/${pkg}/view`,
    NEXT_TELEMETRY_DISABLED: "1",
  };

  const r = runProjectBuild(src, view.source, env);
  if (!r.ok) {
    // §8-2 잔여: buildView 는 동기 설치 파이프라인(installer·draft) 깊숙이 있어 authority 주입이
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
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const fav = pkgIconHref(pkg, m);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(injectShell(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${esc(fav)}">
<title>${esc(m.display_name ?? pkg)}</title>
<link rel="stylesheet" href="/assets/chat-app.css">
<style>html,body{height:100%;margin:0;background:#f5f6f7}#chat{height:100%;max-width:760px;margin:0 auto;padding:14px;box-sizing:border-box}</style>
</head><body><div id="chat"></div>
<script>window.__RELAY_CONTEXT={base:${JSON.stringify("/pkg/" + encodeURIComponent(pkg))},root:"",instanceId:${JSON.stringify(pkg)}};window.RELAY_CHAT_MANUAL=1;</script>
<script type="module">import { mount } from "/assets/chat-app.js"; mount(document.getElementById("chat"), { instanceId: ${JSON.stringify(pkg)} });</script>
</body></html>`));
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
  const fav = pkgIconHref(pkg, m);
  const imports = componentImportsFor(ledger, pkg);
  const target = path.normalize(path.join(root, rest === "" || rest === "/" ? "index.html" : rest));
  if (target !== root && !target.startsWith(root + path.sep)) return void json(res, 403, { error: "경로 탈출" });
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // 정적 발행물의 라우트 관례: <경로>/index.html (trailingSlash) 또는 <경로>.html
    const idx = path.join(target, "index.html");
    if (fs.existsSync(idx)) return void serveViewFile(idx, pkg, root, res, fav, imports);
    const html = target + ".html";
    if (fs.existsSync(html)) return void serveViewFile(html, pkg, root, res, fav, imports);
    return void json(res, 404, { error: `없음: ${rest}` });
  }
  serveViewFile(target, pkg, root, res, fav, imports);
}

/**
 * 패키지 컴포넌트 번들 서빙 — import map 이 가리키는 주소다(componentBundleUrl 의 짝).
 * no-store 인 이유는 채팅 위젯과 같다: 번들은 제공자의 재빌드와 원자적으로 움직여야 한다.
 * 소비자 문서가 캐시된 옛 번들을 들고 새 계약을 부르면 조용히 갈라지고 진단이 남지 않는다.
 */
export function serveComponents(ledger: Ledger, pkg: string, rest: string, res: http.ServerResponse): void {
  const rec = ledger.packages[pkg];
  if (!rec) return void json(res, 404, { error: `미설치 패키지: ${pkg}` });
  const m = loadManifest(rec.path);
  const comp = m.surfaces?.components;
  if (!comp) return void json(res, 404, { error: `components 표면 없는 패키지: ${pkg}` });
  // out 선언은 서빙 뿌리 선언이다 — 미빌드를 소스로 강등하지 않는다(serveView 와 같은 규율)
  const root = path.normalize(componentOutDir(rec.path, m)!);
  if (comp.out && !fs.existsSync(root)) {
    return void json(res, 503, {
      error: `components 미빌드: ${pkg} — 선언된 ${comp.source}/${comp.out} 이 없습니다: npm run relay -- build ${pkg}`,
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

function viewContextTag(pkg: string): string {
  const base = JSON.stringify("/pkg/" + encodeURIComponent(pkg));
  return `<script>window.__RELAY_CONTEXT={base:${base},root:"",instanceId:${JSON.stringify(pkg)}};</script>`;
}

// 패키지 대표 아이콘의 서빙 주소 — 카드 아바타와 탭 favicon 이 같은 그림(manifest icon)을 본다
function pkgIconHref(pkg: string, m: Manifest): string {
  return m.icon ? `/pkg/${encodeURIComponent(pkg)}/asset/${m.icon}` : "/pkg/system/view/icon.svg";
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

function serveViewFile(file: string, pkg: string, root: string, res: http.ServerResponse, fav: string, imports: Record<string, string>): void {
  if (path.extname(file) !== ".html") return void streamFile(file, res);
  const atRoot = assetsAtRootCached(root);
  if (atRoot.length) {
    const base = "/pkg/" + pkg + "/view";
    logLine("view", { pkg, ok: false, base, at_root: atRoot.slice(0, 5) });
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    res.writeHead(500, { "content-type": MIME[".html"], "cache-control": "no-store" });
    return void res.end(injectShell(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>view 판정 실패: ${esc(pkg)}</title>
<style>body{font:14px/1.7 ui-monospace,monospace;margin:40px auto;max-width:760px;color:#111}code{background:#f2f3f5;padding:1px 4px;border-radius:3px}li{margin:2px 0}</style>
</head><body>
<h1>이 화면은 자기 자산을 데몬 루트로 가리킵니다</h1>
<p>발행물이 <code>${esc(base)}</code> 접두사 없이 구워져, 아래 자산이 서빙되지 않습니다:</p>
<ul>${atRoot.slice(0, 8).map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul>
<p><code>RELAY_BASE_PATH</code> 없이 <code>npx next build</code> 를 돌린 흔적입니다. 정본 경로로 다시 구우세요:</p>
<p><code>npm run relay -- build ${esc(pkg)}</code></p>
<p>깨진 화면을 200 으로 내보내는 대신 여기서 멈춥니다 — 그 편이 <code>/_next</code> 404 벽보다 짧습니다.</p>
</body></html>`));
  }
  const html = fs.readFileSync(file, "utf8");
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
  // 없다" 가 구조적으로 불가능하다
  res.end(injectShell(html.slice(0, at) + viewContextTag(pkg) + componentImportMapTag(imports) + iconTag + html.slice(at)));
}

// ── 세션 장부 조회 ─────────────────────────────────────────────────────────

// 권위 이음새 — 1인 기판은 로컬 권위(기본값). 조직 임베드는 여기 다른 구현을 꽂는다(api 는 모른다).
// opts 는 나머지 이음새의 같은 자리다(계약 축·문·스폰·문의 신뢰 좌표) — 전부 additive.

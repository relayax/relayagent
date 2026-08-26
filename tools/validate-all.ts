import fs from "node:fs";
import path from "node:path";
import { validateDir } from "../runner/supply/install.ts";
import { assetsAtDaemonRoot } from "../runner/runtime/view.ts";
import { loadManifest } from "../runner/supply/manifest.ts";

const packagesRoot = path.resolve(process.cwd(), "packages");
const entries = fs
  .readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * viewBuildIssues — 데몬이 서빙하는 view 발행물을 판정한다. 두 축이 있다.
 *
 * 데몬은 out 이 선언되면 소스 대신 그것을 서빙한다(api.ts serveView). 그래서 발행물이 틀리면
 * **소스가 맞아도 틀린 화면이 나간다**. typecheck 도 매니페스트 판정도 발행물을 보지 않아,
 * 이틀 사이 같은 자리에서 두 번 사고가 났다:
 *   ① 낡음 — 원자 컷(2639dae)이 콘솔 layout 에 위젯 배선을 넣고 out 을 다시 굽지 않아,
 *     구 배선은 사라지고 새 배선은 없는 문서가 서빙됐다("채팅 위젯이 없다").
 *   ② 접두사 누락 — 그 재빌드를 `npx next build` 로 맨손 실행해 RELAY_BASE_PATH 가 비었고,
 *     모든 /_next/... 가 루트절대로 구워져 스타일시트·청크가 전부 404 났다("CSS 가 안 뜬다").
 *     mtime 은 최신이라 ①의 검사로는 안 걸린다 — 별개의 축이다.
 *
 * 경로는 **매니페스트에서 읽는다**(규칙 1: 매니페스트가 BOM). 리터럴 "surfaces/view"·"out" 을
 * 박으면 다른 경로를 선언한 패키지는 판정을 통째로 비껴가고, out 을 선언하지 않은 패키지는
 * 기판이 서빙하지도 않는 잔재 디렉토리로 낙방한다.
 *
 * 발행물은 git 밖이다 — 갓 클론한 트리·CI 에는 아예 없다. 그래서 **없으면 침묵한다**:
 * 부재는 고장이 아니다.
 */
function viewBuildIssues(pkgDir: string): string[] {
  let view: { source: string; out?: string } | undefined;
  try {
    view = loadManifest(pkgDir).surfaces?.view;
  } catch {
    return []; // 매니페스트 판정(validateDir)이 이미 fail-loud — 겹쳐 울리지 않는다
  }
  if (!view?.out) return []; // out 미선언 = source 정적 서빙, 판정할 발행물이 없다
  const viewDir = path.join(pkgDir, view.source);
  const outDir = path.join(viewDir, view.out);
  if (!fs.existsSync(outDir)) return []; // 미빌드 — CI·갓 클론
  const declared = `${view.source}/${view.out}`;
  const remedy = `npm run relay -- build ${path.basename(pkgDir)}`;

  const issues: string[] = [];
  const stale = staleBuild(viewDir, outDir, "index.html");
  if (stale) {
    issues.push(
      `${declared} 이 소스보다 낡았습니다 — ${stale.rel} 가 ${stale.gap} 더 최신입니다. ` +
        `데몬은 발행물을 서빙하므로 고친 화면이 나가지 않습니다: ${remedy}`,
    );
  }
  const atRoot = assetsAtDaemonRoot(outDir);
  if (atRoot.length) {
    issues.push(
      `${declared} 이 자기 자산을 데몬 루트로 가리킵니다(${atRoot.length}건: ${atRoot.slice(0, 3).join(", ")}` +
        `${atRoot.length > 3 ? ", …" : ""}). view 는 /pkg/<설치이름>/view/ 아래로 서빙되므로 이대로면 ` +
        `스타일시트·청크가 404 입니다 — RELAY_BASE_PATH 없이 구운 흔적: ${remedy}`,
    );
  }
  return issues;
}

/**
 * componentsBuildIssues — 같은 판정의 컴포넌트 번들 판. 축은 낡음 하나다: 데몬은 굽힌 번들을
 * 서빙하므로 소스만 고치고 다시 굽지 않으면 소비자 화면이 옛 번들을 계속 마운트한다(view 의
 * "이틀간 옛 화면" 과 같은 사고 형태). 접두사 축은 없다 — 번들은 자기 자산을 문서 상대주소로
 * 가리키지 않는다.
 */
function componentsBuildIssues(pkgDir: string): string[] {
  let comp: { source: string; out?: string } | undefined;
  try {
    comp = loadManifest(pkgDir).surfaces?.components;
  } catch {
    return [];
  }
  if (!comp?.out) return []; // out 미선언 = source 를 그대로 서빙, 판정할 산출물이 없다
  const srcDir = path.join(pkgDir, comp.source);
  const outDir = path.join(srcDir, comp.out);
  if (!fs.existsSync(outDir)) return []; // 미빌드 — CI·갓 클론
  const stale = staleBuild(srcDir, outDir, "index.js");
  if (!stale) return [];
  return [
    `${comp.source}/${comp.out} 이 소스보다 낡았습니다 — ${stale.rel} 가 ${stale.gap} 더 최신입니다. ` +
      `데몬은 굽힌 번들을 서빙하므로 소비자 화면이 옛 컴포넌트를 마운트합니다: ` +
      `npm run relay -- build ${path.basename(pkgDir)}`,
  ];
}

/**
 * widgetBuildIssues — 채팅 위젯 번들의 낡음 판정. view·components 와 **같은 사고의 세 번째
 * 얼굴**인데, 앞의 둘과 달리 지금까지 판정이 없었다: 이 루프는 `packages/*` 를 도는데 위젯은
 * 패키지가 아니라 `chat/` 에 살아서 구조적으로 순회 밖이었다.
 *
 * 축은 낡음 하나다. **부재는 여기서 말하지 않는다** — view 와 같은 이유(갓 클론·CI 에는 없고
 * 부재는 고장이 아니다)에 더해, 부재를 아는 가장 좋은 자리가 따로 있기 때문이다: 데몬 부트
 * (daemon.ts widgetBundleNote). 거기는 "지금 채팅을 서빙하려는 참" 이라는 맥락이 있고 여기는
 * 없다 — 러너만 고치는 사람에게 위젯 미빌드로 낙방을 주면 판정이 소음이 된다.
 *
 * 비교 입력을 `chat/src` 로 한정한 이유: `chat/` 전체를 걸면 package-lock.json 이 `npm install`
 * 마다 갱신되어 소스를 한 줄도 안 고친 트리가 "낡았다" 로 낙방한다. 매번 틀리는 판정은 사람이
 * 무시하는 법을 배우게 만들고, 그러면 진짜 낡음도 같이 지나간다.
 */
function widgetBuildIssues(): string[] {
  const srcDir = path.resolve(process.cwd(), "chat", "src");
  const outDir = path.resolve(process.cwd(), "chat", "dist");
  if (!fs.existsSync(outDir) || !fs.existsSync(srcDir)) return []; // 미빌드 — 부재는 부트가 말한다
  const stale = staleBuild(srcDir, outDir, "chat-app.js");
  if (!stale) return [];
  return [
    `chat/dist 가 소스보다 낡았습니다 — ${stale.rel} 가 ${stale.gap} 더 최신입니다. ` +
      `데몬은 /assets 로 굽힌 번들을 서빙하므로 고친 위젯이 화면에 나가지 않습니다: npm run build:widget`,
  ];
}

/** 이름이 무엇이든 산출·툴 부산물은 빌드 입력이 아니다. .env* 는 next 의 입력이라 남긴다. */
const SKIP_ANYWHERE = new Set(["node_modules", ".next", ".git"]);
function isArtifact(name: string): boolean {
  return (
    name.endsWith(".tsbuildinfo") ||
    name.endsWith(".log") ||
    name.endsWith("~") ||
    (name.startsWith(".") && !name.startsWith(".env"))
  );
}

/**
 * 축 ①: 발행물이 빌드 입력보다 낡았는가(mtime 비교). 호출자가 발행물 존재를 이미 확인했다.
 *
 * 비교집합에서 부산물을 빼는 게 이 판정의 정확도다 — tsconfig.tsbuildinfo 는 `npm run typecheck`
 * 만 돌려도 갱신되므로, 남겨두면 소스를 한 줄도 안 고쳤는데 "낡았다" 고 낙방시킨다.
 */
function staleBuild(viewDir: string, outDir: string, entry: string): { rel: string; gap: string } | null {
  let outMs = 0;
  try {
    outMs = fs.statSync(path.join(outDir, entry)).mtimeMs;
  } catch {
    return null; // 문서 없는 발행물 — 낡음을 말할 기준이 없다
  }
  const outName = path.basename(outDir);
  let newest = { ms: 0, rel: "" };
  const walk = (dir: string, rel: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (SKIP_ANYWHERE.has(e.name) || isArtifact(e.name)) continue;
      if (rel === "" && e.name === outName) continue; // 발행물은 view 루트에서만 건너뛴다
      const child = path.join(dir, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        walk(child, childRel);
        continue;
      }
      if (!e.isFile()) continue;
      try {
        const ms = fs.statSync(child).mtimeMs;
        if (ms > newest.ms) newest = { ms, rel: childRel };
      } catch { /* 경합 삭제 */ }
    }
  };
  walk(viewDir, "");
  if (newest.ms <= outMs) return null;
  const sec = Math.round((newest.ms - outMs) / 1000);
  const gap = sec < 60 ? `${sec}초` : sec < 3600 ? `${Math.round(sec / 60)}분` : `${Math.round(sec / 3600)}시간`;
  return { rel: newest.rel, gap };
}

let failed = false;
for (const entry of entries) {
  const pkgDir = path.join(packagesRoot, entry.name);
  const result = validateDir(pkgDir);
  const viewIssues = [...viewBuildIssues(pkgDir), ...componentsBuildIssues(pkgDir)];
  if (result.ok && viewIssues.length === 0) {
    console.log(`${entry.name}: 판정 통과`);
    continue;
  }
  failed = true;
  console.error(`${entry.name}: 판정 실패`);
  for (const issue of [...result.issues, ...viewIssues]) console.error(`  - ${issue}`);
}

// 위젯은 패키지가 아니라 기판의 자산이다 — 루프 밖에서 한 번 판정한다
const widgetIssues = widgetBuildIssues();
if (widgetIssues.length) {
  failed = true;
  console.error("chat(위젯 번들): 판정 실패");
  for (const issue of widgetIssues) console.error(`  - ${issue}`);
}

process.exitCode = failed ? 1 : 0;

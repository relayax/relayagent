import fs from "node:fs";
import path from "node:path";
import { validateDir } from "./installer.ts";

const packagesRoot = path.resolve(process.cwd(), "packages");
const entries = fs
  .readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * staleViewBuild — view 정적 산출(out/)이 소스보다 낡았는가.
 *
 * 왜 판정에 있는가: 데몬은 `out/` 이 있으면 그것을 서빙한다(runner/api.ts serveView). 그래서
 * 소스를 고치고 다시 굽지 않으면 **고친 적 없는 화면이 계속 나간다** — 실사고: 원자 컷
 * (2639dae)이 콘솔 layout 에 새 위젯 배선(/assets/chat-app.js)을 넣었는데 out/ 을 다시 굽지
 * 않아, 구 배선은 이미 사라지고 새 배선은 아직 없는 문서가 이틀간 서빙됐다("채팅 위젯이 없다").
 * 컷이 소비자를 쓸었는지 보는 게이트들(typecheck·validate)이 **빌드 산출은 안 봤다**.
 *
 * `out/` 은 빌드 산출이라 git 밖이다 — 갓 클론한 트리·CI 에는 아예 없다. 그래서 **없으면
 * 침묵한다**(CI 는 view 를 굽지 않는다). 있으면서 낡은 것만 판정한다: 그게 "고친 줄 알았는데
 * 안 고쳐진" 상태다.
 */
function staleViewBuild(pkgDir: string): string | null {
  const viewDir = path.join(pkgDir, "surfaces", "view");
  const outDir = path.join(viewDir, "out");
  if (!fs.existsSync(outDir)) return null; // 미빌드 — CI·갓 클론. 판정 대상 아님
  let outMs = 0;
  try {
    outMs = fs.statSync(path.join(outDir, "index.html")).mtimeMs || fs.statSync(outDir).mtimeMs;
  } catch {
    return null;
  }
  // 소스 최신 mtime — 빌드 입력만 본다(node_modules·out·.next 는 산출·설치 상태).
  const SKIP = new Set(["node_modules", "out", ".next", ".git"]);
  let newest = { ms: 0, rel: "" };
  const walk = (dir: string, rel: string): void => {
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (SKIP.has(e.name)) continue;
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
  const ago = Math.round((newest.ms - outMs) / 60000);
  return `surfaces/view/out 이 소스보다 낡았습니다 — ${newest.rel} 가 ${ago}분 더 최신입니다. ` +
    `데몬은 out/ 을 서빙하므로 고친 화면이 나가지 않습니다: (cd ${path.relative(process.cwd(), viewDir)} && npx next build)`;
}

let failed = false;
for (const entry of entries) {
  const pkgDir = path.join(packagesRoot, entry.name);
  const result = validateDir(pkgDir);
  const stale = staleViewBuild(pkgDir);
  if (result.ok && !stale) {
    console.log(`${entry.name}: 판정 통과`);
    continue;
  }
  failed = true;
  console.error(`${entry.name}: 판정 실패`);
  for (const issue of result.issues) console.error(`  - ${issue}`);
  if (stale) console.error(`  - ${stale}`);
}

process.exitCode = failed ? 1 : 0;

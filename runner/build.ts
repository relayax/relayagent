import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logLine } from "./state.ts";
import type { Manifest } from "./manifest.ts";

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
 * surfaces.view.out 이 선언되면 발행이 굽는다. 굽지 않으면 out 은 빈 약속이다.
 * 기판은 view 를 /pkg/<설치이름>/view/ 아래로 서빙하는데 설치 이름은 설치 시점에 정해지므로
 * 빌드도 설치 시점에 돌고, 접두사를 RELAY_BASE_PATH 로 넘긴다.
 *
 * components = edges[].components 해석 결과(bare npm 이름 → tgz 절대경로, installer 가 굽는다).
 * 저작 선언("*")은 트리의 정본이라 그대로 두고, 빌드 동안만 file: 로 바꿔 쓴 뒤 복원한다 —
 * 릴리스 트리를 file: 절대경로로 오염시키면 재설치·이동이 조용히 깨진다. "*" 는 이 기판에서
 * "기판이 해석한다" 는 예약 표기다: 해석되지 않고 남은 "*" 는 레지스트리로 새는 대신 fail-loud.
 */
export function buildView(pkg: string, pkgPath: string, m: Manifest, components?: Record<string, string>): BuildResult | undefined {
  const view = m.surfaces?.view;
  if (!view?.out) return undefined;

  const src = path.join(pkgPath, view.source);
  const pj = path.join(src, "package.json");
  if (!fs.existsSync(pj)) {
    return { ok: false, out: `${view.source}/package.json 없음 — out 을 선언한 view 는 빌드 가능한 프로젝트여야 합니다` };
  }
  const pjRaw = fs.readFileSync(pj, "utf8");
  let pjObj: { scripts?: { build?: string }; dependencies?: Record<string, string> };
  try {
    pjObj = JSON.parse(pjRaw);
  } catch (e) {
    return { ok: false, out: `${view.source}/package.json 파싱 실패: ${e}` };
  }
  if (!pjObj.scripts?.build) return { ok: false, out: `${view.source}/package.json 에 scripts.build 없음` };

  const deps = pjObj.dependencies ?? {};
  let rewired = 0;
  for (const [nm, tgz] of Object.entries(components ?? {})) {
    if (deps[nm] != null) {
      deps[nm] = "file:" + tgz;
      rewired++;
    }
  }
  const orphan = Object.keys(deps).find((nm) => deps[nm] === "*");
  if (orphan) {
    return { ok: false, out: `"${orphan}": "*" 는 기판 해석 의존인데 해석되지 않았습니다 — relay.yaml edges 에 { provider: "${orphan}", components: true } 를 선언하세요` };
  }

  const env = {
    ...(process.env as Record<string, string>),
    RELAY_BASE_PATH: `/pkg/${pkg}/view`,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const runNpm = (args: string[]) => {
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const commandArgs = process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd", ...args] : args;
    return spawnSync(command, commandArgs, { cwd: src, env, encoding: "utf8", timeout: TIMEOUT });
  };

  if (rewired) fs.writeFileSync(pj, JSON.stringify(pjObj, null, 2) + "\n");
  try {
    const steps: string[] = [];
    // 컴포넌트 tgz 는 매 해석마다 새로 구워진다 — 고정된 file: 이 stale 사본을 남기지 않게
    // 재배선이 있으면 node_modules 유무와 무관하게 install 을 돌린다
    if (rewired || !fs.existsSync(path.join(src, "node_modules"))) {
      const i = runNpm(["install", "--no-audit", "--no-fund"]);
      if (i.status !== 0) {
        return { ok: false, out: `npm install 실패:\n${((i.stdout ?? "") + (i.stderr ?? "")).trim().slice(-600)}` };
      }
      steps.push(rewired ? `npm install 완료 (components ${rewired}건 file: 고정)` : "npm install 완료");
    }

    const b = runNpm(["run", "build"]);
    const tail = ((b.stdout ?? "") + (b.stderr ?? "")).trim().slice(-800);
    if (b.status !== 0) {
      // §8-2 잔여: buildView 는 동기 설치 파이프라인(installer·draft) 깊숙이 있어 authority 주입이
      // installPkg·activatePrepared·publishDraft 전 시그니처 연쇄를 일으킨다 — audit 이사는 보류
      logLine("build", { pkg, ok: false });
      return { ok: false, out: [...steps, tail].join("\n") };
    }

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
  } finally {
    if (rewired) fs.writeFileSync(pj, pjRaw);
  }
}

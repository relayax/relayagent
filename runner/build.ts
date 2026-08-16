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
    // §8-2 잔여: 위와 같은 사유
    logLine("build", { pkg, ok: true, base: env.RELAY_BASE_PATH });
    return { ok: true, out: [...steps, `${view.source}/${view.out} 빌드됨 (basePath ${env.RELAY_BASE_PATH})`].join("\n") };
  } finally {
    if (rewired) fs.writeFileSync(pj, pjRaw);
  }
}

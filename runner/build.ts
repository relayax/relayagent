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
 */
export function buildView(pkg: string, pkgPath: string, m: Manifest): BuildResult | undefined {
  const view = m.surfaces?.view;
  if (!view?.out) return undefined;

  const src = path.join(pkgPath, view.source);
  const pj = path.join(src, "package.json");
  if (!fs.existsSync(pj)) {
    return { ok: false, out: `${view.source}/package.json 없음 — out 을 선언한 view 는 빌드 가능한 프로젝트여야 합니다` };
  }
  let buildScript: string | undefined;
  try {
    buildScript = JSON.parse(fs.readFileSync(pj, "utf8")).scripts?.build;
  } catch (e) {
    return { ok: false, out: `${view.source}/package.json 파싱 실패: ${e}` };
  }
  if (!buildScript) return { ok: false, out: `${view.source}/package.json 에 scripts.build 없음` };

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
  if (b.status !== 0) {
    logLine("build", { pkg, ok: false });
    return { ok: false, out: [...steps, tail].join("\n") };
  }

  const outDir = path.join(src, view.out);
  if (!fs.existsSync(outDir)) {
    return { ok: false, out: `빌드는 통과했지만 산출 디렉토리가 없습니다: ${view.source}/${view.out}` };
  }
  logLine("build", { pkg, ok: true, base: env.RELAY_BASE_PATH });
  return { ok: true, out: [...steps, `${view.source}/${view.out} 빌드됨 (basePath ${env.RELAY_BASE_PATH})`].join("\n") };
}

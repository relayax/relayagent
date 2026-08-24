// view 를 실제 환경(기판이 서빙하는 정적 산출물)으로 계속 다시 굽는다.
// next dev 는 기판 API 가 없어 registry 404 가 뜨므로, 통합 테스트는 이 감시자 + 데몬 조합으로 한다.
//   1) relay daemon 을 띄운다
//   2) 이 스크립트를 돌린다 (npm run watch)
//   3) http://127.0.0.1:4747/pkg/<설치이름>/view/ 를 새로고침한다
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;
const RELAY = path.resolve(HERE, "../../../../runner/cli.ts");
// 설치 이름은 설치 시점에 정해진다. 기본은 이 레포의 ring-0 설치명
const PKG = process.env.RELAY_PKG ?? "system";
const WATCH = ["app", "components", "lib", "next.config.mjs", "package.json"];
const DEBOUNCE = 200;

let timer = null;
let running = false;
let again = false;

function build() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  const t0 = Date.now();
  // 설치·발행과 같은 경로로 굽는다 (basePath 주입은 relay 가 소유한다)
  const p = spawn(process.execPath, ["--experimental-strip-types", RELAY, "build", PKG], { stdio: "inherit" });
  p.on("exit", (code) => {
    running = false;
    console.log(code === 0 ? `[watch] 갱신 완료 (${((Date.now() - t0) / 1000).toFixed(1)}s) — 새로고침하세요` : `[watch] 빌드 실패 (exit ${code})`);
    if (again) {
      again = false;
      build();
    }
  });
}

function schedule() {
  clearTimeout(timer);
  timer = setTimeout(build, DEBOUNCE);
}

for (const target of WATCH) {
  const full = path.join(HERE, target);
  if (!fs.existsSync(full)) continue;
  fs.watch(full, { recursive: fs.statSync(full).isDirectory() }, (_e, file) => {
    if (file && /(^|\/)\.|~$/.test(file)) return; // 에디터 임시파일 무시
    schedule();
  });
}

console.log(`[watch] ${PKG} view 감시 중 — ${WATCH.join(", ")}`);
build();

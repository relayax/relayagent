// _load.mjs — node --test 는 TS 를 직접 못 읽으므로, chat-build.mjs 와 같은 도구(esbuild)로
// src/chat 모듈을 ESM 번들해 import 한다. 산출물은 dist/.test/ 아래(gitignore 범위).
//
// ⚠ 출력 경로에 pid 가 들어가는 이유: node --test 는 테스트 **파일마다 별도 프로세스**를 띄우고
// 그것들이 동시에 돈다. 세 파일이 같은 ChatTabs.tsx 를 적재하므로 공용 outfile 이면 한 프로세스가
// 쓰는 도중의 파일을 다른 프로세스가 import 한다 — 반쯤 쓰인 번들을 읽어 "SyntaxError: Invalid
// Unicode escape sequence" 로 죽는다(실측: cold 캐시에서 6~7회에 1회). 프로세스마다 자기 디렉토리를
// 쓰면 경합 자체가 없다. --test-concurrency=1 로 덮는 것보다 이쪽이 원인을 지운다.
import * as esbuild from "esbuild";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(__dirname, "../dist/.test", String(process.pid));

process.on("exit", () => rmSync(outdir, { recursive: true, force: true }));

export async function loadModule(relSrc) {
  const outfile = resolve(outdir, relSrc.replace(/\.(ts|tsx)$/, ".mjs"));
  await esbuild.build({
    entryPoints: [resolve(__dirname, "../src/chat", relSrc)],
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    jsx: "automatic",
    outfile,
    sourcemap: false,
    logLevel: "silent",
    // chat.css 의 url("/assets/…") — 기판이 서빙하는 절대 경로. chat-build.mjs 와 같은 취급
    external: ["/assets/*"],
    // css 는 테스트가 보지 않는다(tw.css 는 postcss 없이는 못 굽는다)
    loader: { ".css": "empty" },
  });
  return import(pathToFileURL(outfile).href + "?t=" + Date.now());
}

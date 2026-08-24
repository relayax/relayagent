// chat-build.mjs — src/chat(채팅 위젯)을 단일 ESM(+CSS)으로 번들한다. 기판이 /assets 로
// 정적 서빙한다. ESM 인 이유(계획 §4-e): 콘솔 inline 마운트가 `import { mount } from
// "/assets/chat-app.js"` 형태로 소비하고, 자동 마운트 게이트가 import.meta.url 로 로드
// 경로를 판별한다(main.tsx autoFloat). 번들 전용 런타임 의존은 이 패키지 devDependencies:
// file: 소비자(view 빌드)에 전파되지 않고, node_modules 가 하나라 react 이중화 축이 없다.
// Output → dist/chat-app.js + dist/chat-app.css (gitignored build artifacts).
import * as esbuild from "esbuild";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes("--dev");

// assistant-ui 0.11.58 bug: RemoteThreadListHookInstanceManager calls the runtime core's
// `__internal_setGetInitializePromise` method DETACHED (extracted to a var, then called) — a regular
// class method, so in a strict-mode ESM bundle `this` is undefined → "Cannot set properties of
// undefined (setting '_getInitializePromise')" and the whole chat fails to mount. Bind `this`.
const fixDetachedThis = {
  name: "fix-assistant-ui-detached-this",
  setup(build) {
    build.onLoad({ filter: /RemoteThreadListHookInstanceManager\.js$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const patched = src.replace(
        'const setGetInitializePromise = runtimeCore["__internal_setGetInitializePromise"];',
        'const __auiM = runtimeCore["__internal_setGetInitializePromise"]; const setGetInitializePromise = typeof __auiM === "function" ? __auiM.bind(runtimeCore) : __auiM;'
      );
      // 패턴 미발견 = 죽은 번들이다 — 이 패치가 헛돌면 채팅 마운트 전체가 죽는다. 경고로
      // 넘기지 않고 빌드를 실패시킨다(fail-loud, 계획 §4-c: 릴리스 컷에서 빌드 실패 = 릴리스 실패).
      if (patched === src) {
        throw new Error("fix-assistant-ui-detached-this: pattern not found (assistant-ui 버전 변경?) — 패치 갱신 전에는 번들을 출하할 수 없다");
      }
      return { contents: patched, loader: "js" };
    });
  },
};

await esbuild.build({
  entryPoints: [resolve(__dirname, "src/chat/main.tsx")],
  bundle: true,
  outfile: resolve(__dirname, "dist/chat-app.js"),
  format: "esm",
  jsx: "automatic",
  target: ["safari15", "chrome110"],
  platform: "browser",
  sourcemap: false,
  minify: !dev,
  legalComments: "none",
  define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"' },
  loader: { ".css": "css" },
  plugins: [fixDetachedThis],
  logLevel: "info",
});

console.log(`✓ relay-chat built (${dev ? "dev" : "prod"}) → dist/chat-app.js + dist/chat-app.css`);

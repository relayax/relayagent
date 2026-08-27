// chat-build.mjs — src/chat(채팅 위젯)을 단일 ESM(+CSS)으로 번들한다. 기판이 /assets 로
// 정적 서빙한다. ESM 인 이유(계획 §4-e): 콘솔 inline 마운트가 `import { mount } from
// "/assets/chat-app.js"` 형태로 소비하고, 자동 마운트 게이트가 import.meta.url 로 로드
// 경로를 판별한다(main.tsx autoFloat). 번들 전용 런타임 의존은 이 패키지 devDependencies:
// file: 소비자(view 빌드)에 전파되지 않고, node_modules 가 하나라 react 이중화 축이 없다.
// Output → dist/chat-app.js + dist/chat-app.css (gitignored build artifacts).
import * as esbuild from "esbuild";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { copyFile, readFile } from "node:fs/promises";
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

// 위젯 조각 밖으로 새지 않게 — tw.css 가 낳는 모든 규칙을 `:where(.rc-tw)` 자손으로 가둔다.
// 위젯은 남의 문서(콘솔·패키지 뷰, 대개 그쪽도 Tailwind)에 끼워지고, 유틸리티는 레이어 밖에
// 있어(tw.css 머리 주석) 호스트의 @layer 유틸리티를 무조건 이긴다. 같은 이름의 클래스가 양쪽에
// 있으면 호스트의 변형(sm:·hover:·focus-visible:)이 위젯의 기본형(.max-w-[…]·.bg-transparent)에
// 진다 — 실사고(2026-08-27): 콘솔 다이얼로그가 sm:max-w 를 잃고 뷰포트 전폭, 고스트 버튼 hover 무효.
// :where 는 명시도 0 이라 (0,1,0) 그대로 — 호스트 원소 규칙은 여전히 이기고, 호스트 원소에는
// 아예 닿지 않는다. .rc-tw 는 main.tsx 가 마운트 호스트에, ui/* 가 base-ui Portal 에 단다.
// 가두지 않는 것: :root(토큰), *(--tw-* 변수 기본값), @keyframes·@font-face·@property.
const SCOPE = ":where(.rc-tw)";
const scopeToWidget = {
  postcssPlugin: "relay-scope-to-widget",
  Rule(rule) {
    if (rule.parent?.type === "atrule" && /keyframes$/.test(rule.parent.name)) return;
    rule.selectors = rule.selectors.map((s) => {
      if (/^(:root|html|body|\*|:before|:after|::)/.test(s)) return s;
      if (s.startsWith(SCOPE)) return s;
      return `${SCOPE} ${s}`;
    });
  },
};

// Tailwind — tw.css(@import "tailwindcss/…") 만 postcss 로 굽는다. chat.css 는 손으로 쓴 CSS 그대로.
const tailwindCss = {
  name: "tailwind",
  setup(build) {
    // 경로 구분자를 둘 다 본다 — esbuild 는 args.path 를 OS 네이티브로 준다.
    // 슬래시만 보면 Windows 에서 이 로더가 통째로 안 걸리고, tw.css 가 postcss 를 타지 않아
    // @import "tw-animate-css" 가 esbuild 로 흘러가 죽는다(그 패키지는 exports 에 style 조건만
    // 있어 esbuild 가 해석할 수 없다 — Tailwind 가 인라인해 주는 것이 유일한 길이다).
    build.onLoad({ filter: /[\\/]tw\.css$/ }, async (args) => {
      const src = await readFile(args.path, "utf8");
      const out = await postcss([tailwind(), scopeToWidget]).process(src, { from: args.path });
      return { contents: out.css, loader: "css", resolveDir: dirname(args.path) };
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
  // css 의 url("/assets/…") 는 기판이 서빙하는 절대 경로다 — 번들에 넣지 않는다
  external: ["/assets/*"],
  plugins: [tailwindCss, fixDetachedThis],
  logLevel: "info",
});

// 글꼴 — 콘솔(next/font/local)·사이드바(@font-face)·위젯이 같은 Pretendard 를 쓴다. 기판이
// /assets/pretendard.woff2 로 서빙하므로 여기서 dist 로 복사한다(인트라넷·오프라인에서도 뜬다)
await copyFile(
  resolve(__dirname, "node_modules/pretendard/dist/web/variable/woff2/PretendardVariable.woff2"),
  resolve(__dirname, "dist/pretendard.woff2"),
);

console.log(`✓ relay-chat built (${dev ? "dev" : "prod"}) → dist/chat-app.js + dist/chat-app.css + dist/pretendard.woff2`);

// next-preset — 저작용 Next 설정 공용 프리셋 (구 8× 인라인 next.config 복붙 흡수).
// view 는 output:'export' 정적 산출 + @relay/* 를 TS 소스(file: symlink)로 소비하므로
// transpilePackages·extensionAlias·싱글턴 alias 가 매 view 마다 동일하게 필요했다 — 여기 한 곳에.
//
// 기판 중립 산물(view 정합 V2a) — 정본은 relayagent-oss chat/next-preset.mjs 이고 이
// 사본은 벤더링(deploy/relayagent.lock — 무패치·upstream-first)이다. 두 기판의 basePath 축을
// 다 받는다: OSS 는 설치 빌드가 RELAY_BASE_PATH env 를 주입하고(runner/runtime/view.ts), relayos 는
// env 없이 발행 파이프라인(next-config-wrap.mjs)이 빌드 직전 이 설정을 next.config.user 로
// 개명 후 basePath 자리표시자를 덮어 감싼다 — env 분기는 relayos 경로에서 no-op 이라 두 계층이
// 그대로 합성된다.
//
// 사용:  import relayNext from "@relay/chat/next-preset.mjs";
//        export default relayNext(import.meta.url);
//   추가 blessed 소스 패키지(@relay/ui 등)나 싱글턴 대상이 있으면:
//        export default relayNext(import.meta.url, {
//          transpilePackages: ["@relay/ui"],
//          singletons: ["@radix-ui/react-select", "class-variance-authority"],
//        });
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// react 이중화 방지 — @relay/* 가 file: symlink 라 라이브러리 쪽 node_modules 의 사본이 같이
// 번들되면 훅이 null 로 죽고(React 컨텍스트 분열), @tanstack 사본이 갈리면 relayQueryClient
// 싱글턴 캐시가 twin-path 로 갈라진다. 전부 앱(view) 사본으로 강제 단일화한다.
const BASE_SINGLETONS = ["react", "react-dom", "@tanstack/react-query"];

// 서피스 번들 버전 — 헤더(SurfaceHeader)가 표시한다. 정본은 패키지의 relay.package.yaml
// (view 기준 ../../relay.package.yaml). 빌드 시 env 로 심어 process.env.NEXT_PUBLIC_RELAY_VERSION
// 으로 인라인된다. best-effort: 파일이 없는 빌드 경로(control-ts 프리뷰/workspace 발행이 트리를
// 복사하는 경우)에선 빈 값 → 헤더가 버전만 생략한다(깨지지 않음).
function readPackageVersion(appDir) {
  try {
    const yaml = readFileSync(path.join(appDir, "..", "..", "relay.package.yaml"), "utf8");
    const m = yaml.match(/^version:\s*["']?([^"'\s#]+)/m);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}

// components edge 소비는 이 preset 이 손댈 일이 아니다 — 번들은 npm 의존이 아니라 기판이
// 주소로 서빙하는 자립 ESM 이고, 소비자 문서의 import map 이 bare 이름을 그 주소로 푼다.
// 무빌드 화면은 정적 import 로 끝나지만, **번들되는 view 는 다르다**: webpack 은 bare 이름을
// 빌드 시점에 해석하려 들고 output.module 이 아니라 import 문을 산출에 남기지도 못한다.
// 그래서 번들형 view 의 소비 형태는 webpack 이 건드리지 않는 동적 import 하나다 —
//   const { mount } = await import(/* webpackIgnore: true */ "@local/ui");
// 주석이 있으면 import 가 그대로 산출에 남고 브라우저가 import map 으로 푼다.

/**
 * @param {string} metaUrl  호출 next.config 의 import.meta.url (view 디렉토리 해석용).
 * @param {{ transpilePackages?: string[], singletons?: string[], webpack?: Function } & Record<string, unknown>} [user]
 * @returns {import('next').NextConfig}
 */
export default function relayNext(metaUrl, user = {}) {
  const appDir = path.dirname(fileURLToPath(metaUrl));
  const { transpilePackages = [], singletons = [], webpack: userWebpack, ...rest } = user;
  const singletonMods = [...BASE_SINGLETONS, ...singletons];

  return {
    output: "export",
    // OSS 설치 빌드 축 — 기판이 /pkg/<설치이름>/view 를 env 로 준다(설치 이름은 설치 시점에
    // 정해진다). relayos 발행 경로는 env 미설정(no-op) + next-config-wrap 이 덮는다.
    ...(process.env.RELAY_BASE_PATH ? { basePath: process.env.RELAY_BASE_PATH } : {}),
    transpilePackages: [...new Set(["@relay/chat", ...transpilePackages])],
    ...rest,
    // env 는 rest 뒤에 둔다 — 버전 주입이 저작자 env 를 덮지 않되(저작 키 보존) 항상 실린다.
    env: { NEXT_PUBLIC_RELAY_VERSION: readPackageVersion(appDir), ...(rest.env ?? {}) },
    webpack: (config, ctx) => {
      // @relay/chat 소스는 ESM 관습대로 상대 import 에 .js 확장자를 쓴다(실체는 .ts/.tsx).
      // webpack 은 tsc 와 달리 자동 매핑하지 않으므로 extensionAlias 가 필수.
      config.resolve.extensionAlias = {
        ...config.resolve.extensionAlias,
        ".js": [".ts", ".tsx", ".js"],
      };
      config.resolve.alias = { ...config.resolve.alias };
      for (const m of singletonMods) {
        config.resolve.alias[m] = path.join(appDir, "node_modules", ...m.split("/"));
      }
      return userWebpack ? userWebpack(config, ctx) : config;
    },
  };
}

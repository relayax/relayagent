#!/usr/bin/env node
// 판정 계약 패키지(@relay/contract) 패킹 — 릴리스 아티팩트 relay-contract-<tag>.tgz 의 원료.
// 임베더(relayos control-ts 판정 정본 뷰 · lib/sdk MCP 문 합성 뷰)가 소스 사본 대신 소비할
// npm 패키지를 굽는다. 내용물은 자기 완결 계약 4파일 + 문법 정본:
//   runner/supply/manifest.ts            판정기 (judge · disclosure · declaredPaths)
//   runner/authority-contract.ts  권위 이음새 계약 (의존성 0)
//   runner/runtime/mcp.ts                 MCP 문 합성 (의존성 0)
//   runner/runtime/oauth-rfc.ts           OAuth RFC 조각 (디스커버리·DCR·PKCE·교환·회전 — node:crypto 만)
//   relay.manifest.yaml           문법 정본 (판정기의 주석 짝)
//
// .js + .d.ts 로 굽는 이유(실측 2026-08-24): tsc 소비자(control-ts)는 node_modules 의 .ts 를
// 타입검사만 하고 에밋하지 않는다 — typecheck·빌드가 GREEN 인 채 런타임 require 가 죽는
// 최악의 실패 형태다(Node 의 --experimental-strip-types 도 node_modules 는 대상 밖).
// CJS 로 굽는 이유: commonjs require(control-ts dist)와 esbuild 번들 named import(sdk) 가
// 양쪽 다 성립하는 단일 형태다. exports 맵은 두지 않는다 — 소비는 깊은 경로 import
// ('@relay/contract/manifest' 등)가 계약이고, node10·nodenext·bundler 해석 전부에서 통한다.
//
// "no build step" 원칙(CLAUDE.md)과의 관계: 트리는 여전히 무빌드다 — 이 빌드는 릴리스
// 컷(release.yml)과 로컬 검증에서만 돌고, 산출물(out/)은 gitignore 아래라 커밋되지 않는다.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const root = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const yamlRange = root.dependencies?.yaml;
if (!yamlRange) {
  console.error("중단: 루트 package.json 에 yaml 의존이 없습니다 — manifest.ts 의 유일한 외부 의존인데 좌표가 사라졌습니다");
  process.exit(1);
}

// 발행 표면은 **평면**이다: 임베더는 '@relay/contract/manifest' 처럼 깊은 경로로 수입하고,
// 그 이름은 계약이다. 계약 파일이 트리 안에서 어디로 옮겨가든(supply/·runtime/ 재편) 굽는
// 결과의 자리는 바뀌면 안 된다 — 그래서 rootDir 을 트리에 걸지 않고, 세 파일을 평면 소스
// 디렉토리에 모아 거기서 굽는다. (트리 자리를 rootDir 로 쓰면 산출이 supply/manifest.js 로
// 눕어 소비자의 import 가 전부 깨진다 — 실측 2026-08-25.)
const SOURCES = ["runner/supply/manifest.ts", "runner/authority-contract.ts", "runner/runtime/mcp.ts", "runner/runtime/oauth-rfc.ts"];

const stage = join(repo, "out", "contract-stage");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

// 평면 소스 사본. 계약 4파일은 상대 import 가 0 인 자기완결 파일이라 사본이 원본과 같게 컴파일된다.
// 그 성질이 깨지면(누가 runner 내부로 상대 import 를 얻으면) 여기서 **해석 실패로 죽는다** —
// 아래 내용물 판정보다 이른, 더 정직한 자리다.
const src = join(repo, "out", "contract-src");
rmSync(src, { recursive: true, force: true });
mkdirSync(src, { recursive: true });
for (const f of SOURCES) copyFileSync(join(repo, f), join(src, basename(f)));

// 계약 4파일만 CJS + 선언으로 에밋한다. rootDir=평면 소스라 산출이 stage 바로 아래에 눕는다.
// --ignoreConfig: 루트 tsconfig(noEmit·NodeNext)은 이 빌드와 무관하다 — TS7 은 CLI 파일
// 지정과 tsconfig 동거를 조용히 넘기지 않고 이 플래그를 요구한다.
execFileSync(
  join(repo, "node_modules", ".bin", "tsc"),
  [
    ...SOURCES.map((f) => join(src, basename(f))),
    "--ignoreConfig",
    "--module", "commonjs", "--target", "ES2022", "--esModuleInterop",
    "--declaration", "--strict", "--skipLibCheck", "--types", "node",
    "--rootDir", src, "--outDir", stage,
  ],
  { cwd: repo, stdio: "inherit" },
);
rmSync(src, { recursive: true, force: true });

writeFileSync(
  join(stage, "package.json"),
  JSON.stringify(
    {
      name: "@relay/contract",
      version: root.version,
      description: "RelayAgent embedder contract — the relay.yaml judge, the authority seam, and the MCP gate, prebuilt as CJS + d.ts.",
      license: "MIT",
      homepage: root.homepage,
      repository: root.repository,
      // 계약 3파일의 외부 의존은 manifest.ts 의 yaml 하나가 전부다 — 루트 좌표를 그대로 승계
      dependencies: { yaml: yamlRange },
    },
    null,
    2,
  ) + "\n",
);
copyFileSync(join(repo, "relay.manifest.yaml"), join(stage, "relay.manifest.yaml"));

const outDir = join(repo, "out");
execFileSync("npm", ["pack", "--pack-destination", outDir], { cwd: stage, stdio: ["ignore", "ignore", "inherit"] });
rmSync(stage, { recursive: true, force: true });

// 내용물 판정 — 기대 집합과 다르면 실패한다. 이 판정이 곧 자기 완결 게이트다: 계약 파일이
// runner 내부 모듈로 상대 import 를 얻으면 tsc 가 그 모듈까지 에밋해 집합이 어긋난다
// (authority-contract.ts 머리의 "익명의 제3자 임베더 테스트"가 기계 판정이 된 것).
const tgz = join(outDir, `relay-contract-${root.version}.tgz`);
const want = new Set([
  "package/package.json",
  "package/manifest.js", "package/manifest.d.ts",
  "package/authority-contract.js", "package/authority-contract.d.ts",
  "package/mcp.js", "package/mcp.d.ts",
  "package/relay.manifest.yaml",
  "package/oauth-rfc.js", "package/mcp.d.ts",
  "package/oauth-rfc.d.ts", "package/mcp.d.ts",
]);
const got = new Set(
  execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").map((s) => s.trim()).filter(Boolean),
);
const extra = [...got].filter((f) => !want.has(f));
const missing = [...want].filter((f) => !got.has(f));
if (extra.length || missing.length) {
  console.error(
    `중단: 계약 패키지 내용물이 기대 집합과 다릅니다` +
      (extra.length ? `\n  잉여(계약이 runner 내부로 새 의존을 얻었는가?): ${extra.join(", ")}` : "") +
      (missing.length ? `\n  결손: ${missing.join(", ")}` : ""),
  );
  rmSync(tgz, { force: true });
  process.exit(1);
}
console.log(tgz);

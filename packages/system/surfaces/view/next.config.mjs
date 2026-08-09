import path from "node:path";

// 기판이 view 를 /pkg/<설치이름>/view/ 아래로 서빙한다. 설치 이름은 설치 시점에 정해지므로
// 빌드도 설치 시점에 일어나고, 기판이 RELAY_BASE_PATH 로 그 접두사를 주입한다.
const basePath = process.env.RELAY_BASE_PATH ?? "";

/** @type {import('next').NextConfig} */
export default {
  output: "export",
  trailingSlash: true,
  basePath,
  images: { unoptimized: true },
  // 설치가 무인으로 굽는다. 루트를 명시해 lockfile 추측을 막되, file: 의존성(@relay/relayjs =
  // <레포>/lib/relayjs 심링크)이 루트 밖으로 나가지 않도록 레포 루트를 못박는다
  turbopack: { root: path.resolve(import.meta.dirname, "../../../..") },
};

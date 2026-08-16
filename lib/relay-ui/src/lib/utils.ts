// shadcn CLI 가 요구하는 utils 착지점 — 실체는 @relay/relayjs 의 cn 하나다(사본 금지).
// 생성 직후 fix-imports 가 컴포넌트의 "@/lib/utils" 를 "@relay/relayjs" 로 되돌린다:
// @/ 별칭은 소비 앱(transpilePackages)에서 그 앱의 별칭으로 해석돼 깨지기 때문이다.
export { cn } from "@relay/relayjs";

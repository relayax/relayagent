// 부작용 css import(`import "./chat.css"`)의 선언 — 번들러(esbuild)가 처리하는 자산이라
// 타입은 없다. 선언이 없으면 타입 검사가 이 import 를 모듈 부재로 낙방시킨다.
declare module "*.css";

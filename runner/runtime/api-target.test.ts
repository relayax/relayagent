// api 서비스의 base 집행 — 매니페스트의 `api:` 선언과 고지서의 "이 주소로 나갑니다"는
// 자격 붙은 요청이 그 접두를 벗어나지 못할 때만 사실이다. 탈출은 한 길이 아니다: 남의 호스트로
// 가는 절대 URL, 접두를 흉내 내는 호스트(api.notion.com.evil…), ../ 등반, 경로 있는 base 에서의
// 루트 탈출이 전부 같은 판정 하나에 걸린다 — 그래서 그 자리가 무너지면 넷이 함께 열린다.
//
//   node --experimental-strip-types --test runner/runtime/api-target.test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { apiTarget } from "./scripts.ts";

test("선언 base 안쪽 요청은 그대로 지난다 — 절대·상대 경로, 질의, 경로 있는 base", () => {
  assert.equal(apiTarget("https://api.notion.com", "/v1/pages", "notion"), "https://api.notion.com/v1/pages");
  assert.equal(apiTarget("https://api.notion.com", "v1/pages", "notion"), "https://api.notion.com/v1/pages");
  assert.equal(apiTarget("https://api.example.com/v2", "things?q=1", "x"), "https://api.example.com/v2/things?q=1");
  assert.equal(apiTarget("https://api.example.com/v2/", "things", "x"), "https://api.example.com/v2/things");
  assert.equal(apiTarget("https://api.example.com/v2", "", "x"), "https://api.example.com/v2/");
});

test("base 를 벗어나는 네 길이 같은 판정에서 막힌다", () => {
  assert.throws(() => apiTarget("https://api.notion.com", "https://evil.example/x", "notion"), /base 밖 요청/);
  // 접두 문자열 비교만으로는 지나가는 자리 — root 를 슬래시로 닫아야 걸린다
  assert.throws(() => apiTarget("https://api.notion.com", "https://api.notion.com.evil.example/x", "notion"), /base 밖 요청/);
  assert.throws(() => apiTarget("https://api.example.com/v2", "/admin", "x"), /base 밖 요청/);
  assert.throws(() => apiTarget("https://api.example.com/v2", "../admin", "x"), /base 밖 요청/);
});

test("거절은 사유를 싣는다 — 서비스 이름과 두 주소", () => {
  assert.throws(
    () => apiTarget("https://api.notion.com", "https://evil.example/x", "notion"),
    (e: Error) => e.message.includes("notion") && e.message.includes("evil.example") && e.message.includes("api.notion.com"),
  );
});

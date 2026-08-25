import test from "node:test";
import assert from "node:assert/strict";
import { assetsAtOtherMount } from "./view.ts";

// 같은 트리가 두 좌표로 설 수 있게 된 뒤의 판정. 실사고의 형태는 이랬다: /pkg 좌표로 구운
// out/ 이 작업 사본에 남아 있고, 그것을 /draft 좌표에서 내면 문서는 200 인데 청크는 도는 판의
// 것을 끌어온다 — 미리보기가 자기 코드가 아닌 것을 그리고, 화면에는 아무 흔적이 없다.

const DRAFT = "/draft/cardnews-studio/view";
const LIVE = "/pkg/cardnews-studio/view";

test("도는 판의 청크를 부르는 문서는 미리보기 좌표에서 걸린다", () => {
  const html = `<link rel="stylesheet" href="${LIVE}/_next/static/chunks/a.css"/><script src="${LIVE}/_next/b.js"></script>`;
  const bad = assetsAtOtherMount(html, DRAFT);
  assert.deepEqual(bad, [`${LIVE}/_next/b.js`, `${LIVE}/_next/static/chunks/a.css`]);
});

test("자기 좌표의 자산은 통과한다", () => {
  const html = `<script src="${DRAFT}/_next/b.js"></script><link href="${DRAFT}/x.css">`;
  assert.deepEqual(assetsAtOtherMount(html, DRAFT), []);
});

test("기판 소유 자산은 대상이 아니다 — 데몬 루트가 정본이라 어느 마운트에서든 같은 자리다", () => {
  const html = `<link rel="stylesheet" href="/assets/chat-app.css"><script src="/shell.js" defer></script>`;
  assert.deepEqual(assetsAtOtherMount(html, DRAFT), []);
});

test("질의문자열은 좌표가 아니다", () => {
  const html = `<script src="${DRAFT}/_next/b.js?v=2"></script>`;
  assert.deepEqual(assetsAtOtherMount(html, DRAFT), []);
});

test("접두가 겹치는 남의 패키지는 통과하지 않는다 — 이름이 접두인 형제", () => {
  const html = `<script src="/pkg/cardnews-studio-old/view/_next/b.js"></script>`;
  assert.deepEqual(assetsAtOtherMount(html, LIVE), ["/pkg/cardnews-studio-old/view/_next/b.js"]);
});

test("반대 방향도 같은 술어다 — 미리보기 산출이 도는 자리로 새어 나가는 경우", () => {
  const html = `<script src="${DRAFT}/_next/b.js"></script>`;
  assert.deepEqual(assetsAtOtherMount(html, LIVE), [`${DRAFT}/_next/b.js`]);
});

test("남의 앱으로 가는 링크는 자산이 아니다 — 앱끼리 서로 여는 것은 정상 동작이다", () => {
  const html = `<a href="/pkg/detail-page/view/">상세페이지</a><a href="/pkg/offer-workbook/view/">제안서</a>`;
  assert.deepEqual(assetsAtOtherMount(html, DRAFT), []);
});

test("이미지·iframe 도 대상이 아니다 — 남의 것을 가리키는 게 정상이다", () => {
  const html = `<img src="/pkg/other/asset/logo.svg"><iframe src="/pkg/other/view/"></iframe>`;
  assert.deepEqual(assetsAtOtherMount(html, DRAFT), []);
});

test("속성 순서가 달라도 <link> 는 잡는다", () => {
  const html = `<link data-precedence="next" rel="stylesheet" href="${LIVE}/_next/a.css"/>`;
  assert.deepEqual(assetsAtOtherMount(html, DRAFT), [`${LIVE}/_next/a.css`]);
});

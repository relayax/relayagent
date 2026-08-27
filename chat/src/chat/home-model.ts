// home-model.ts — 홈(런처)의 순수 판정. 화면(Home.tsx)은 이걸 그리기만 한다.
import type { ShellItem, ShellNav } from "./nav";

/** 홈 예시 — [칩 이름, 상자에 들어갈 문장]. 묶음 단위로 ↻ 가 돌린다 */
export const EXAMPLES: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [["아침 요약 알림", "매일 아침 9시에 오늘 일정과 할 일을 요약해서 알려주는 에이전트"],
   ["슬랙 답변 봇", "슬랙 채널에 질문이 오면 사내 문서를 찾아 답해주는 에이전트"],
   ["가계부", "지출을 적으면 월별 합계와 그래프를 보여주는 가계부 에이전트"],
   ["문의 접수 폼", "고객 문의를 받는 폼 화면. 접수되면 나에게 알려주는 에이전트"]],
  [["메모 정리", "적어둔 메모를 매주 주제별로 정리해주는 에이전트"],
   ["뉴스 브리핑", "관심 키워드의 뉴스를 매일 저녁 모아서 짧게 브리핑해주는 에이전트"],
   ["독서 기록", "읽은 책과 감상을 기록하고 검색할 수 있는 화면을 가진 에이전트"],
   ["회의록 정리", "회의 녹취 텍스트를 넣으면 결정 사항과 할 일로 정리해주는 에이전트"]],
  [["습관 체크", "매일 저녁 오늘의 습관 체크를 물어보고 주간 달성률을 보여주는 에이전트"],
   ["번역 도우미", "붙여넣은 글을 자연스러운 한국어·영어로 번역해주는 에이전트"],
   ["일정 비서", "캘린더를 보고 회의 전에 준비할 것을 미리 알려주는 에이전트"],
   ["미니 게임", "간단한 퀴즈 게임 화면을 가진 에이전트"]],
];

/** page 번째 예시 묶음 — 끝에서 처음으로 돈다 */
export function examplesAt(page: number): ReadonlyArray<readonly [string, string]> {
  const n = EXAMPLES.length;
  return EXAMPLES[((page % n) + n) % n];
}

/** 홈 카드는 전부가 아니라 **지금 신경 쓸 것**만 — 수정 중·새 판·오류. 멀쩡히 도는 앱은
 *  사이드바가 이미 목록으로 보여 주므로 여기 또 세우면 같은 목록이 두 번 선다 */
export function todoOf(items: ReadonlyArray<ShellItem>): ShellItem[] {
  return items.filter((it) => it.editing || !!it.update || !!it.error);
}

/** 새 판이 나온 설치본 수 — 배너는 개수만 말한다(실행은 카드의 버튼) */
export function updateCount(items: ReadonlyArray<ShellItem>): number {
  return items.filter((it) => !!it.update).length;
}

/** 카드의 상태 칩 하나 + 버튼 하나. 홈 카드는 "지금 손볼 것"이라 카드 전체와 버튼이 같은 곳으로 간다 —
 *  수정 중 → 스튜디오(이어 수정), 새 판 → 서재(업데이트), 오류 → 상세(왜 실패했나). 우선순위는 그 순서 */
export interface CardAction { status: "editing" | "update" | "error"; chip: string; label: string; href: string }
export function cardAction(it: ShellItem, library: string | null): CardAction {
  if (it.error) return { status: "error", chip: "검사 실패", label: "확인", href: it.detail };
  if (it.update && library) return { status: "update", chip: `새 판 ${it.update}`, label: "업데이트", href: library };
  if (it.update) return { status: "update", chip: `새 판 ${it.update}`, label: "상세", href: it.detail };
  return { status: "editing", chip: "수정 중", label: "이어 수정", href: it.detail };
}

/** 아바타 글자 — 아이콘이 없을 때 이름 첫 글자 */
export function initialOf(label: string): string {
  return (label.trim()[0] || "?").toUpperCase();
}

/** 설명 한 줄 — 매니페스트 기본 문구("설명을 적어 주세요.")나 빈 값은 설명이 아니다 */
const PLACEHOLDER_DESC = /^(설명을 적어 주세요\.?|TODO|description)$/i;
export function describe(description: string): string | null {
  const d = (description || "").trim();
  return !d || PLACEHOLDER_DESC.test(d) ? null : d;
}

/** 초안 카드의 한 줄 — 칩이 "초안"을 말하므로 여기는 진행 정도만 */
export function draftLine(changes: number): string {
  return changes ? `바뀐 파일 ${changes}개` : "아직 내용이 없어요";
}

export function isEmptyNav(nav: ShellNav): boolean {
  return !nav.items.length && !nav.drafts.length;
}

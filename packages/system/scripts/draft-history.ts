// 기록(커밋) 이력 — 최근 것부터. 스튜디오 [기록] 다이얼로그가 "이 지점으로" 를 붙이는 목록이다
export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  if (!input.name) throw new Error("name 필수");
  return ctx.host.draftHistory(input.name);
}

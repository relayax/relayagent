// 기록 지점으로 되돌리기 — 작업 사본의 파일을 그 커밋의 모습으로. 이력은 그대로라 되돌린 결과는
// "기록하지 않은 변경" 으로 서고, 마음에 들면 다시 기록·적용한다
export default async function (input: { name: string; hash: string }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  if (!input.name) throw new Error("name 필수");
  if (!input.hash) throw new Error("hash 필수");
  return ctx.host.draftRestore(input.name, input.hash);
}

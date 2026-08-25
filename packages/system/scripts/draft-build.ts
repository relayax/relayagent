// 미리보기 굽기 — 작업 사본을 /draft/<이름>/ 좌표로 굽는다. 도는 판도 장부도 건드리지 않는다:
// out 을 선언한 표면은 굽지 않으면 미리보기가 설 자리가 없고, 그렇다고 발행을 요구하면
// 그건 미리보기가 아니다
export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  if (!input.name) throw new Error("name 필수");
  return ctx.host.draftBuild(input.name);
}

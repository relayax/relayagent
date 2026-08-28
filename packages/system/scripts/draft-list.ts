export default async function (_input: unknown, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  // ctx.host 는 워커의 거울이라 모든 호출이 Promise 다 — 객체에 넣기 전에 풀어야 결과가 문을 건넌다(구조 복제)
  return { drafts: await ctx.host.draftList() };
}

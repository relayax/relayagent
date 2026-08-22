export default async function (_input: unknown, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  // host.grants 는 권위 이음새를 지나는 비동기 계약 — await 없이는 빈 객체가 직렬화된다
  return { grants: await ctx.host.grants() };
}

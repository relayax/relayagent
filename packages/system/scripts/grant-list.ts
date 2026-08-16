export default async function (_input: unknown, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  // host.grants 는 권위 이음새를 지나는 비동기 계약 — await 없이는 빈 객체가 직렬화된다
  return { grants: await ctx.host.grants() };
}

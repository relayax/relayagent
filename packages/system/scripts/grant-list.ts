export default async function (_input: unknown, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  return { grants: ctx.host.grants() };
}

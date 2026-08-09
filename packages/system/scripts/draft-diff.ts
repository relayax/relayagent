export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  return ctx.host.draftDiff(input.name);
}

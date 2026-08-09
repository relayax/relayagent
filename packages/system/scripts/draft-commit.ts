export default async function (input: { name: string; message: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  return ctx.host.draftCommit(input.name, input.message);
}

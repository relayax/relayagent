export default async function (input: { name: string; file?: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  return ctx.host.draftRead(input.name, input.file);
}

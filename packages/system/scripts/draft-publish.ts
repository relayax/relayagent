export default async function (input: { name: string; version?: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  return ctx.host.draftPublish(input.name, { version: input.version });
}

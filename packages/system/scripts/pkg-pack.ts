export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  if (!input?.name) throw new Error("name 이 필요합니다");
  return ctx.host.pack(input.name);
}

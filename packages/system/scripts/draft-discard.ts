// draft 전체 폐기 — 되돌릴 수 없다. 마지막 커밋으로 되돌리려면 폐기 후 draft-open (설치본에서 다시 사본)
export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  return ctx.host.draftDiscard(input.name);
}

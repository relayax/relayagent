export default async function (
  input: { consumer: string; provider: string; tools?: string[]; mission?: string },
  ctx: any,
) {
  if (!ctx.host) throw new Error("ring-0 전용");
  if (!input.consumer || !input.provider) throw new Error("consumer + provider 필수");
  if (input.tools?.length && input.mission) throw new Error("tools 와 mission 동시 결재 불가");
  if (!input.tools?.length && !input.mission) throw new Error("tools 또는 mission 중 하나는 있어야 합니다");
  // 선언 캡(consumer 의 edges) 검사는 장부의 문인 addGrant 가 한다. 여기서는 형태만 보고 필드를 좁혀 넘긴다
  return ctx.host.grant({
    consumer: input.consumer,
    provider: input.provider,
    tools: input.tools,
    mission: input.mission,
  });
}

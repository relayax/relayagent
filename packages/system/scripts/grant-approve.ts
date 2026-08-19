export const meta = {
  description:
    "연결 결재 — consumer 가 provider 의 도구(tools) 또는 미션(mission)을 소비하도록 장부에 인가를 남긴다. tools 와 mission 은 배타적이고, 결재는 consumer 의 선언(edges)을 넘을 수 없다.",
  input: {
    type: "object",
    required: ["consumer", "provider"],
    additionalProperties: false,
    properties: {
      consumer: { type: "string", description: "소비하는 쪽의 설치 이름" },
      provider: { type: "string", description: "제공하는 쪽의 설치 이름" },
      tools: { type: "array", items: { type: "string" }, description: "결재할 도구 이름들 — mission 과 동시 지정 불가" },
      mission: { type: "string", description: "결재할 미션 이름 — tools 와 동시 지정 불가" },
    },
  },
};

export default async function (
  input: { consumer: string; provider: string; tools?: string[]; mission?: string },
  ctx: any,
) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
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

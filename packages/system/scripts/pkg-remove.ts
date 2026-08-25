export const meta = {
  description:
    "설치 제거 — 장부에서 패키지를 내리고 그 상주·자격·프로비저닝 바이너리를 걷는다. 이 패키지를 provider 로 쓰던 소비자는 함께 멈춘다(역색인은 셸 상세 화면이 제거 앞에 보여 준다).",
  input: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "제거할 설치 이름" },
    },
  },
};

export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  if (!input.name) throw new Error("name 필수");
  // 자기 자신을 내리면 이 동사를 부른 문이 같이 사라진다 — 되돌릴 길이 화면에 남지 않는다
  if (input.name === ctx.pkg) throw new Error(`${ctx.pkg} 은(는) 이 화면을 서빙하는 패키지입니다 — 스스로를 제거할 수 없습니다`);
  return ctx.host.remove(input.name);
}

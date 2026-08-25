export const meta = {
  description:
    "봉투 굽기 — 설치본을 .relay 아티팩트로 봉인해 선반에 앉히고, 그 사본을 이 대화의 파일 교환 무대에 놓는다(사용자가 답장에서 그대로 내려받는다). 선언 밖이라 빠진 파일은 excluded 로 함께 보고한다.",
  input: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "구울 설치 이름" },
    },
  },
};

export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  if (!input?.name) throw new Error("name 이 필요합니다");
  // 부른 쪽을 실어 보낸다 — 봉투 사본이 이 대화의 무대에 앉아야 사용자가 받는다.
  // 선반(~/.relay/artifacts)은 기판 장기라 세션이 열 수 없고, 그래서 종전에는 여기서
  // 굽기만 하고 "터미널에서 cp 하세요"로 끝났다
  return ctx.host.pack(input.name, ctx.pkg);
}

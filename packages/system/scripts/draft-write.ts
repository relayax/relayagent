interface Input {
  name: string;
  /** 키 = 패키지 루트 상대경로. relay.yaml 도 이 길로 고친다 */
  files?: Record<string, string>;
  delete?: string[];
}

export const meta = {
  description:
    "열린 draft 에 파일을 쓰고 지운다. 설치본은 실행 중이라 직접 만지지 않는다 — 편집은 draft, 반영은 draft-publish. relay.yaml 도 이 길로 고친다.",
  input: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "draft 를 연 패키지 이름 (draft-open 의 name)" },
      files: {
        type: "object",
        description: "키 = 패키지 루트 상대경로, 값 = 파일 전문(부분 패치 아님)",
        additionalProperties: { type: "string" },
      },
      delete: { type: "array", items: { type: "string" }, description: "지울 파일의 루트 상대경로" },
    },
  },
};

export default async function (input: Input, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  return ctx.host.draftWrite(input.name, input.files ?? {}, input.delete ?? []);
}

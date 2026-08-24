interface Input {
  name: string;
  /** 키 = 패키지 루트 상대경로. relay.yaml 도 이 길로 고친다 */
  files?: Record<string, string>;
  delete?: string[];
  /** 파일별 마지막 읽기 지문(draft-read 의 hash) — 동시 편집 방어(opt-in) */
  base?: Record<string, string | null>;
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
      base: {
        type: "object",
        description:
          "동시 편집 방어(opt-in) — 키 = 파일 경로, 값 = 마지막 draft-read 가 준 hash(없는 파일로 알고 있으면 null). 실은 경로가 그 사이 다른 손에 고쳐졌으면 아무것도 쓰지 않고 E_CONFLICT 로 실패한다",
        additionalProperties: { type: ["string", "null"] },
      },
    },
  },
};

export default async function (input: Input, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  return ctx.host.draftWrite(input.name, input.files ?? {}, input.delete ?? [], input.base);
}

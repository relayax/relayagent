// 동사 이름 → 짧은 서술. 패키지 화면의 "시킬 수 있는 일" 줄이 슬러그 대신 이것을 그린다.
// 뜻을 아는 쪽은 기판이라(세션 문의 tools/list 가 같은 서술을 싣는다) 여기서는 묻기만 한다.
export const meta = {
  description: "패키지 동사의 짧은 서술 목록. draft 를 주면 작업 사본의 코드에서 읽는다.",
  input: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "설치 이름 또는 작업 사본 이름" },
      draft: { type: "boolean", description: "작업 사본에서 읽기 (기본: 설치본)" },
    },
  },
};

export default async function (input: { name: string; draft?: boolean }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  return { labels: await ctx.host.verbLabels(input.name, !!input.draft) };
}

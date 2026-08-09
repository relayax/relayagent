interface Input {
  name: string;
  /** 키 = 패키지 루트 상대경로. relay.yaml 도 이 길로 고친다 */
  files?: Record<string, string>;
  delete?: string[];
}

export default async function (input: Input, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  return ctx.host.draftWrite(input.name, input.files ?? {}, input.delete ?? []);
}

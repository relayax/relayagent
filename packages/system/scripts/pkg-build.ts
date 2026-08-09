// surfaces.view.out 을 선언한 패키지의 view 를 다시 굽는다. 설치 때 한 번 굽고, 화면을 고친 뒤 이 동사로 재빌드한다
export default async function (input: { name: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  if (!input.name) throw new Error("name 필수");
  return ctx.host.build(input.name);
}

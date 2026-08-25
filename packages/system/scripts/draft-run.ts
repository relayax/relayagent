// 작업 사본의 동사 한 번 — 발행 전에 돌려보는 자리. 코드는 작업 사본, 맥락(작업 폴더·자격·
// 서비스)은 설치본이다. 짓자마자 확인할 길이 없으면 저작자는 발행을 확인 수단으로 쓰게 된다.
export default async function (input: { name: string; verb: string; input?: unknown }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  if (!input.name) throw new Error("name 필수");
  if (!input.verb) throw new Error("verb 필수");
  const t0 = Date.now();
  try {
    const result = await ctx.host.draftRun(input.name, input.verb, input.input ?? {});
    return { ok: true, ms: Date.now() - t0, result };
  } catch (e) {
    // 실패도 결과다 — 던지면 화면이 붉은 배너 하나를 얻고 걸린 시간을 잃는다
    return { ok: false, ms: Date.now() - t0, error: String(e instanceof Error ? e.message : e) };
  }
}

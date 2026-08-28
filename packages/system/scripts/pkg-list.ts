export default async function (_input: unknown, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  const reg = await ctx.host.registry();
  return {
    packages: reg.packages.map((p: any) => ({
      name: p.name,
      lineage: p.manifest?.name,
      version: p.manifest?.version,
      display_name: p.manifest?.display_name,
      description: p.manifest?.description,
      workspace: p.workspace,
      agents: (p.manifest?.agents ?? []).map((a: any) => a.name),
      services: (p.manifest?.services ?? []).map((s: any) => s.name),
      // 창구(채널)는 서비스가 아니다 — 들어오는 문이라 따로 센다. 종전엔 빠져 있어 에이전트가 채널을 못 봤다
      channels: (p.manifest?.surfaces?.channels ?? []).map((c: any) => c.name),
      missions: (p.manifest?.missions ?? []).map((m: any) => m.name),
      error: p.error,
    })),
    grants: reg.grants,
  };
}

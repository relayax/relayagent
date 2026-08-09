export default async function (_input: unknown, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  const reg = ctx.host.registry();
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
      missions: (p.manifest?.missions ?? []).map((m: any) => m.name),
      error: p.error,
    })),
    grants: reg.grants,
  };
}

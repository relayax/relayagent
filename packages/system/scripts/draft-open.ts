import { stringify } from "yaml";

interface Input {
  name: string;
  /** 새 패키지 스캐폴드 — 이미 있는 draft 나 설치본을 열 때는 생략한다 */
  manifest?: Record<string, any>;
  personas?: Record<string, string>;
  scripts?: Record<string, string>;
  /** 나머지 전부. 키 = 패키지 루트 상대경로 (icon, view, channels 진입, skills 등) */
  files?: Record<string, string>;
  /** 기존 draft 에 하네스 템플릿 추가 복사 (스튜디오의 + 하네스 후보) */
  seedHarness?: { source: string; entry: string }[];
}

const HARNESS_LLM: Record<string, unknown> = {
  "harness/claude-code": { provider: "anthropic", auth: { kind: "oauth" } },
  "harness/codex": { provider: "openai", auth: { kind: "oauth" } },
  "harness/pi": { provider: "vllm", auth: { kind: "token", env: "PI_API_KEY" } },
  "harness/kimi": { provider: "moonshot", auth: { kind: "token", env: "MOONSHOT_API_KEY" } },
};

function serviceStub(name: string, port?: number): string {
  if (!port) return `console.log("${name} 서비스 기동");\nsetInterval(() => {}, 60000);\n`;
  // 서비스 계약: 선언한 port 에서 listen 한다. PORT 는 기판이 주입한다
  return [
    `import http from "node:http";`,
    ``,
    `const port = Number(process.env.PORT ?? ${port});`,
    `http`,
    `  .createServer((_req, res) => {`,
    `    res.writeHead(200, { "content-type": "application/json" });`,
    `    res.end(JSON.stringify({ service: "${name}", ok: true }));`,
    `  })`,
    `  .listen(port, () => console.log("${name} listening on " + port));`,
    ``,
  ].join("\n");
}

export default async function (input: Input, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  const files: Record<string, string> = { ...(input.files ?? {}) };
  const seedHarness: { source: string; entry: string }[] = [];
  const m = input.manifest;

  if (m) {
    // 스캐폴드는 새 이름에만. 있는 draft 나 설치본 위에 매니페스트를 덮으면 편집 이력이 증발한다
    const drafts = ctx.host.draftList() as { name: string }[];
    const installed = (ctx.host.registry() as any).packages.some((p: any) => p.name === input.name);
    if (drafts.some((d) => d.name === input.name) || installed) {
      throw new Error(`이미 있는 대상입니다: ${input.name} — manifest 없이 열어 draft-write 로 고치세요`);
    }

    if ((m.agents ?? []).length > 0 && !m.harness?.variants?.length) {
      m.harness = { ...(m.harness ?? {}), variants: [{ name: "claude-code", source: "harness/claude-code", entry: "run" }] };
    }
    for (const v of m.harness?.variants ?? []) {
      if (!v.llm && HARNESS_LLM[v.source]) v.llm = HARNESS_LLM[v.source];
    }
    files["relay.yaml"] = stringify(m);

    for (const a of m.agents ?? []) {
      if (!a.persona) continue;
      files[a.persona] =
        input.personas?.[a.name] ??
        `당신은 ${a.name}입니다. ${m.display_name ?? input.name} 패키지의 에이전트입니다.\n\n# 역할\n${m.description ?? ""}\n`;
    }

    if (m.scripts?.source) {
      const given = Object.entries(input.scripts ?? {});
      for (const [n, body] of given) files[`${m.scripts.source}/${n}.ts`] = body;
      if (!given.length) files[`${m.scripts.source}/.gitkeep`] = "";
    }

    if (m.surfaces?.view?.source) {
      const prefix = m.surfaces.view.source + "/";
      if (!Object.keys(files).some((k) => k.startsWith(prefix))) {
        files[prefix + "index.html"] =
          `<!doctype html><meta charset="utf-8"><title>${m.display_name ?? input.name}</title>` +
          `<body style="font-family:sans-serif;padding:40px"><h1>${m.display_name ?? input.name}</h1>` +
          `<p>${m.description ?? ""}</p><script type="module" src="/assets/chat-widget.js"></script>`;
      }
    }

    for (const s of m.services ?? []) {
      if (s.source && s.entry && !files[`${s.source}/${s.entry}`]) files[`${s.source}/${s.entry}`] = serviceStub(s.name, s.port);
      if (s.source && s.dockerfile && !files[`${s.source}/${s.dockerfile}`]) {
        files[`${s.source}/${s.dockerfile}`] = `FROM alpine\nCMD ["sleep", "infinity"]\n`;
      }
    }
  }

  // 하네스 템플릿은 system 패키지에서 복사된다 (이미 있으면 draft.ts 가 건너뛴다)
  for (const v of m?.harness?.variants ?? []) {
    if (String(v.source ?? "").startsWith("harness/")) seedHarness.push({ source: v.source, entry: String(v.entry ?? "run") });
  }
  for (const s of input.seedHarness ?? []) {
    if (String(s.source ?? "").startsWith("harness/")) seedHarness.push({ source: s.source, entry: String(s.entry ?? "run") });
  }

  const opened = ctx.host.draftOpen(input.name, { files, seedHarness });
  return { ...(opened as object), ...(ctx.host.draftRead(input.name) as object) };
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, parseDocument } from "yaml";
import { judge, ManifestError, type Manifest } from "./manifest.ts";
import { CREATABLES } from "../../packages/system/surfaces/view/lib/create.ts";

// 저작 팔레트가 만드는 것은 전부 **문법을 통과해야 한다**.
//
// 만들기가 판정에 걸리는 선언을 앉히면 저작자는 만들자마자 빨간 줄을 본다 — 만드는 맛의
// 정반대다. 그리고 그 실패는 GUI 를 눌러 봐야만 드러나므로 타입 검사도 빌드도 잡지 못한다.
// 스캐폴드와 문법은 서로 다른 파일에 살기 때문에, 둘을 한자리에서 대조하는 자리가 필요하다.
//
// 이 시험은 화면을 띄우지 않는다: lib/create.ts 의 실행시 수입이 0 이라(형 수입뿐) 그대로 부를 수 있다.

const BASE = `schema: relay/v1
name: "@local/probe"
version: 0.1.0
display_name: 시험용
description: 스캐폴드가 문법을 통과하는지 보는 패키지
agents:
  - name: probe
    persona: agents/probe/AGENT.md
harness:
  variants:
    - name: codex
      source: harness/codex
      entry: run
`;

/** 스캐폴드가 쓴 파일을 실제로 앉힌다 — judge 는 선언이 가리키는 실체를 확인한다 */
function fakeCtx(dir: string, doc: Document) {
  const files: string[] = ["relay.yaml", "agents/probe/AGENT.md", "harness/codex/run"];
  return {
    ctx: {
      get manifest(): Manifest {
        return doc.toJS() as Manifest;
      },
      files,
      async apply(mutate: (d: Document) => void) {
        mutate(doc);
      },
      async createFile(p: string, content: string) {
        const abs = path.join(dir, p);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content);
        if (!files.includes(p)) files.push(p);
      },
      async seedHarness(source: string, entry: string) {
        const abs = path.join(dir, source, entry);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, "#!/usr/bin/env node\n");
        files.push(`${source}/${entry}`);
      },
    },
    files,
  };
}

const INPUT: Record<string, string> = {
  agent: "helper",
  skill: "probe",
  channel: "discord",
  script: "report-weekly",
  harness: "claude-code",
  "service-process": "indexer",
  "service-container": "db",
  "service-url": "notion",
  "service-api": "unsplash",
  "service-dir": "documents",
  "trigger-cron": "daily",
  "trigger-event": "on-install",
  mission: "summarize",
  "edge-tools": "@relay/mail",
  "edge-mission": "@relay/mail",
  "edge-components": "@relay/charts",
  "requires-binary": "git",
  "host-method": "host.draft_publish",
};

/** 둘째 칸이 있는 것 — 하나로는 만들 수 없는 선언이 있다 */
const SECOND: Record<string, string> = {
  "edge-mission": "summarize-week",
};

for (const c of CREATABLES) {
  test(`만들기: ${c.label} — 만든 것이 문법을 통과한다`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scaffold-"));
    try {
      fs.mkdirSync(path.join(dir, "agents/probe"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agents/probe/AGENT.md"), "당신은 probe 입니다.\n");
      fs.mkdirSync(path.join(dir, "harness/codex"), { recursive: true });
      fs.writeFileSync(path.join(dir, "harness/codex/run"), "#!/usr/bin/env node\n");
      const doc = parseDocument(BASE);
      const { ctx } = fakeCtx(dir, doc);

      const made = await c.make(ctx as never, INPUT[c.id] ?? "", SECOND[c.id]);
      fs.writeFileSync(path.join(dir, "relay.yaml"), doc.toString());

      // 영수증과 목적지는 계약이다 — 만든 뒤 데려갈 자리가 없으면 만들기가 끝나지 않는다
      assert.ok(made.receipt.length > 0, "영수증이 비었다");
      assert.ok(made.sec.length > 0, "데려갈 섹션이 없다");

      try {
        judge(doc.toJS() as Manifest, dir);
      } catch (e) {
        const why = e instanceof ManifestError ? e.issues.join(" · ") : String(e);
        assert.fail(`${c.id} 이 앉힌 선언이 판정에 걸린다: ${why}`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

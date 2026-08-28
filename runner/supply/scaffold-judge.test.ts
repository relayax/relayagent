import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Document, parseDocument } from "yaml";
import { judge, ManifestError, type Manifest } from "./manifest.ts";
import { CREATABLES, HARNESS_TEMPLATES } from "../../packages/system/surfaces/view/lib/create.ts";

// 저작 팔레트가 만드는 것은 전부 **문법을 통과해야 한다**.
//
// 만들기가 판정에 걸리는 선언을 앉히면 저작자는 만들자마자 빨간 줄을 본다 — 만드는 맛의
// 정반대다. 그리고 그 실패는 GUI 를 눌러 봐야만 드러나므로 타입 검사도 빌드도 잡지 못한다.
// 스캐폴드와 문법은 서로 다른 파일에 살기 때문에, 둘을 한자리에서 대조하는 자리가 필요하다.
//
// 이 시험은 화면을 띄우지 않는다: lib/create.ts 는 같은 lib 의 표시 이름표(describe.ts)만 실행시로
// 수입하고 나머지는 형 수입뿐이라, 리액트 없이 그대로 부를 수 있다.

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
        // 실물을 그대로 복사한다 — 기판의 씨앗도 폴더째 옮긴다(supply/draft.ts). entry 만
        // 흉내 내면 아이콘 같은 동봉물을 가리키는 선언이 여기서 통과하고 GUI 에서만 걸린다
        const src = path.join(import.meta.dirname, "..", "..", "packages", "system", source);
        const abs = path.join(dir, source);
        fs.cpSync(src, abs, { recursive: true });
        for (const f of fs.readdirSync(abs, { recursive: true, withFileTypes: true })) {
          if (f.isFile()) files.push(path.posix.join(source, path.relative(abs, path.join(f.parentPath, f.name))));
        }
        assert.ok(fs.existsSync(path.join(abs, entry)), `씨앗에 시작 파일이 없다: ${source}/${entry}`);
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

// 엔진은 네 개이고 서로 다르다 — pi 에는 icon.png 가 없고 kimi 에는 레시피가 없다. 위 반복은
// 종류마다 입력 하나만 넣으므로(claude-code) 나머지 셋은 아무도 판정에 대지 않았다. 붙인 엔진이
// 목록에만 서고 돌지 않던 결함이 여기 있었다: 자격(llm.auth)도 실행 파일(binary→requires)도
// 선언이 데려와야 하고, binary 참조는 requires 에 대상이 없으면 판정이 설치를 막는다.
for (const tpl of HARNESS_TEMPLATES) {
  test(`엔진 붙이기: ${tpl} — 선언이 자격과 실행 파일을 함께 데려온다`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-"));
    try {
      fs.mkdirSync(path.join(dir, "agents/probe"), { recursive: true });
      fs.writeFileSync(path.join(dir, "agents/probe/AGENT.md"), "당신은 probe 입니다.\n");
      // 엔진이 하나도 없는 데서 시작한다 — 붙이는 손이 처음 세우는 자리다
      const doc = parseDocument(BASE.replace(/harness:\n(?:.*\n)*$/, ""));
      const { ctx } = fakeCtx(dir, doc);
      (ctx as { files: string[] }).files.splice(2, 1); // harness/codex/run 은 아직 없다

      await CREATABLES.find((c) => c.id === "harness")!.make(ctx as never, tpl);
      const m = doc.toJS() as Manifest;
      const v = (m.harness?.variants ?? []).find((x) => x.name === tpl);
      assert.ok(v, "변형이 안 섰다");
      assert.ok(v!.llm?.auth?.env, "자격 이름이 없다 — 금고의 값이 세션 env 로 실리지 않는다");
      if (v!.binary) {
        assert.ok(
          (m.requires?.binaries ?? []).some((b) => b.name === v!.binary && b.manager && b.package),
          "binary 참조에 레시피가 없다 — 기판이 도구 사본을 깔 길이 없다",
        );
      }
      fs.writeFileSync(path.join(dir, "relay.yaml"), doc.toString());
      judge(m, dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

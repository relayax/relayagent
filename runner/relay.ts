#!/usr/bin/env node --experimental-strip-types
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { API_URL, RELAY_HOME, loadLedger, workspacePath, PRINCIPAL } from "./state.ts";
import { installPkg, removePkg, addGrant, validateDir, registryData } from "./installer.ts";
import { createApi, makeHostBridge } from "./api.ts";
import { startServices, stopAll } from "./run.ts";
import { Ticker } from "./tick.ts";
import { runSession, recoverDanglingTurns, listSessionSlots, enableResidents, retireAllResidents } from "./session.ts";
import { loadManifest } from "./manifest.ts";
import { vaultSet, credKey } from "./vault.ts";

const [, , cmd, ...args] = process.argv;

async function tryApi(path: string, body: unknown): Promise<unknown | null> {
  try {
    const res = await fetch(API_URL + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch {
    return null;
  }
}

function flag(name: string): string | undefined {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
}

function has(name: string): boolean {
  return args.includes("--" + name);
}

async function main(): Promise<void> {
  const ledger = loadLedger();

  switch (cmd) {
    case "daemon": {
      const pidFile = path.join(RELAY_HOME, "run", "daemon.pid");
      if (fs.existsSync(pidFile)) {
        const old = Number(fs.readFileSync(pidFile, "utf8").trim());
        let alive = false;
        try {
          process.kill(old, 0);
          alive = true;
        } catch {
          alive = false;
        }
        if (alive) throw new Error(`데몬이 이미 실행 중입니다: pid ${old} (${API_URL})`);
      }
      fs.writeFileSync(pidFile, String(process.pid) + "\n");
      // 상주 하네스는 데몬만 허용한다 — CLI 1회 실행이 상주를 남기면 고아가 된다
      enableResidents();
      let ticker: Ticker | null = null;
      const host = makeHostBridge(() => loadLedger(), () => ticker);
      ticker = new Ticker(() => loadLedger(), host);
      createApi(() => loadLedger(), host, ticker);
      ticker.start();
      const l = loadLedger();
      // 지난 기동이 턴 도중에 끊겼다면 그 자리에 답이 없다. 서비스보다 먼저 줍는다 —
      // 도는 중인 턴이 없는 이 시점이 죽은 턴과 살아 있는 턴을 구별할 수 있는 유일한 순간이다
      for (const [name] of Object.entries(l.packages)) {
        for (const slot of listSessionSlots(name)) {
          try {
            if (recoverDanglingTurns(name, slot)) console.log(`${name}/${slot}: 끊긴 턴 복구`);
          } catch (e) {
            console.error(`${name}/${slot}: 턴 복구 실패 - ${e}`);
          }
        }
      }
      for (const [name, rec] of Object.entries(l.packages)) {
        try {
          const notes = startServices(l, name, rec.path, loadManifest(rec.path));
          for (const n of notes) console.log(n);
        } catch (e) {
          console.error(`${name}: 서비스 기동 실패 - ${e}`);
        }
      }
      console.log(`relay daemon: ${API_URL} (principal: ${PRINCIPAL})`);
      console.log(`콘솔: ${API_URL}/pkg/system/view/`);
      process.on("SIGINT", () => {
        ticker?.stop();
        retireAllResidents();
        stopAll();
        fs.rmSync(pidFile, { force: true });
        process.exit(0);
      });
      break;
    }

    case "install": {
      const dir = args.find((a) => !a.startsWith("--"));
      if (!dir) throw new Error("사용법: relay install <디렉토리> [--ring0] [--name n] [--workspace dir]");
      const viaApi = await tryApi("/install", { path: dir, ring0: has("ring0"), workspace: flag("workspace") });
      if (viaApi && !(viaApi as any).error) {
        console.log(`설치됨(daemon): ${JSON.stringify(viaApi)}`);
        break;
      }
      const r = installPkg(ledger, dir, {
        ring0: has("ring0"),
        name: flag("name"),
        workspace: flag("workspace"),
      });
      // workspace 는 폴더 결재다 — 설치 출력이 그 결재를 사용자 눈앞에 남긴다
      console.log(`설치됨: ${r.name} (${r.manifest.name}@${r.manifest.version}, workspace: ${workspacePath(ledger, r.name)}${ledger.packages[r.name].ring === 0 ? ", ring-0" : ""})`);
      if (r.setup && !r.setup.ok) console.error(`  하네스 setup 실패: ${r.setup.out}`);
      if (r.build) console.log(`  view ${r.build.ok ? "빌드됨" : "빌드 실패"}: ${r.build.out}`);
      break;
    }

    case "build": {
      const { buildPkg } = await import("./installer.ts");
      const pkg = args[0];
      if (!pkg) throw new Error("사용법: relay build <패키지>");
      const viaApi = await tryApi(`/pkg/${encodeURIComponent(pkg)}/build`, {});
      const r = (viaApi && !(viaApi as any).error ? viaApi : buildPkg(ledger, pkg)) as { ok: boolean; out: string };
      console.log(r.ok ? r.out : `빌드 실패:\n${r.out}`);
      process.exitCode = r.ok ? 0 : 1;
      break;
    }

    case "ls": {
      const data = registryData(ledger) as { packages: { name: string; manifest: { name: string; version: string } | null; workspace: string; ring: number | null; error: string | null }[]; grants: unknown[] };
      for (const p of data.packages) {
        console.log(`${p.name}\t${p.manifest ? `${p.manifest.name}@${p.manifest.version}` : "(판정 실패)"}\tworkspace=${p.workspace}${p.ring === 0 ? "\tring-0" : ""}${p.error ? "\t" + p.error : ""}`);
      }
      if (!data.packages.length) console.log("설치된 패키지 없음");
      break;
    }

    case "rm": {
      if (!args[0]) throw new Error("사용법: relay rm <이름>");
      removePkg(ledger, args[0]);
      console.log(`제거됨: ${args[0]}`);
      break;
    }

    case "validate": {
      const r = validateDir(args[0] ?? ".");
      console.log(r.ok ? "판정 통과" : "판정 실패:\n" + r.issues.map((i) => "  - " + i).join("\n"));
      process.exitCode = r.ok ? 0 : 1;
      break;
    }

    case "run": {
      const pkg = args[0];
      if (!pkg) throw new Error("사용법: relay run <패키지> [프롬프트]");
      const prompt = args.slice(1).filter((a) => !a.startsWith("--")).join(" ");
      if (!prompt) {
        await runSession({ ledger, pkg, interactive: true });
      } else {
        const r = await runSession({ ledger, pkg, prompt });
        console.log(r.reply);
      }
      break;
    }

    case "connect": {
      const [pkg, service] = args;
      if (!pkg || !service) throw new Error("사용법: relay connect <패키지> <서비스>");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const token = await new Promise<string>((resolve) => rl.question(`${pkg}/${service} 토큰 붙여넣기: `, resolve));
      rl.close();
      vaultSet(credKey(pkg, service), token.trim());
      console.log(`저장됨: ${credKey(pkg, service)} (vault)`);
      break;
    }

    case "harness": {
      const [pkg, name] = args;
      if (!pkg) throw new Error("사용법: relay harness <패키지> [이름]");
      const { setHarness } = await import("./installer.ts");
      const m = loadManifest(ledger.packages[pkg].path);
      if (!name) {
        const active = ledger.packages[pkg].harness ?? m.harness?.variants?.[0]?.name;
        for (const v of m.harness?.variants ?? []) {
          console.log(`${v.name === active ? "*" : " "} ${v.name}\t(llm: ${v.llm?.provider ?? "어댑터 기본"})`);
        }
      } else {
        const r = setHarness(ledger, pkg, name);
        console.log(`활성 하네스: ${r.active}`);
        console.log(`setup: ${r.setup.ok ? "준비됨" : "불가"} — ${r.setup.out}`);
      }
      break;
    }

    case "harness-check": {
      const pkg = args[0];
      if (!pkg) throw new Error("사용법: relay harness-check <패키지>");
      const { conformPkg } = await import("./conform.ts");
      let allOk = true;
      for (const r of conformPkg(ledger, pkg)) {
        console.log(`${r.ok ? "통과" : "위반"}  ${r.variant}`);
        for (const c of r.checks) console.log(`  ${c.ok ? "o" : "x"} ${c.verb}: ${c.note}`);
        allOk = allOk && r.ok;
      }
      process.exitCode = allOk ? 0 : 1;
      break;
    }

    case "login": {
      const [pkg, ...rest] = args;
      if (!pkg) throw new Error("사용법: relay login <패키지> [--token]");
      const { harnessLogin } = await import("./installer.ts");
      process.exitCode = harnessLogin(ledger, pkg, rest);
      break;
    }

    case "model": {
      const [pkg, model] = args;
      if (!pkg) throw new Error("사용법: relay model <패키지> [모델]");
      const { harnessVerb } = await import("./installer.ts");
      if (!model) {
        const r = harnessVerb(ledger, pkg, "models");
        console.log(`지원 모델: ${r.out}`);
        console.log(`현재 설정: ${ledger.packages[pkg]?.model ?? "(어댑터 기본)"}`);
      } else {
        ledger.packages[pkg].model = model;
        const { saveLedger } = await import("./state.ts");
        saveLedger(ledger);
        console.log(`설정됨: ${pkg} -> ${model}`);
        // 저장 시점 재검증 — 장부에 없는 모델이 조용히 썩는 사고의 답. 직접 입력은 막지 않는다
        try {
          const arr = JSON.parse(harnessVerb(ledger, pkg, "models").out);
          if (Array.isArray(arr) && !arr.includes(model)) {
            console.log("주의: 어댑터 모델 목록에 없는 이름입니다 — 세션에서 거부되면 relay model " + pkg + " 로 목록을 확인하세요");
          }
        } catch { /* models 불달 — 판정 불가 */ }
      }
      break;
    }

    case "effort": {
      const [pkg, level] = args;
      if (!pkg) throw new Error("사용법: relay effort <패키지> [강도|off]");
      if (!ledger.packages[pkg]) throw new Error(`미설치 패키지: ${pkg}`);
      if (!level) {
        console.log(`현재 설정: ${ledger.packages[pkg].effort ?? "(어댑터 기본)"}`);
        break;
      }
      // RELAY_EFFORT 로 전달된다. capabilities 에 effort 를 선언한 어댑터만 반영하고 나머지는 무시한다
      if (level === "off") delete ledger.packages[pkg].effort;
      else ledger.packages[pkg].effort = level;
      const { saveLedger } = await import("./state.ts");
      saveLedger(ledger);
      console.log(`설정됨: ${pkg} -> ${level === "off" ? "(어댑터 기본)" : level}`);
      break;
    }

    case "draft": {
      const { openDraft, readDraft } = await import("./draft.ts");
      const name = args.find((a) => !a.startsWith("--"));
      if (!name) throw new Error("사용법: relay draft <이름>");
      const r = openDraft(ledger, name);
      const s = readDraft(ledger, name);
      const fromLabel = { installed: "설치본 사본", empty: "빈 스캐폴드", existing: "기존 draft" }[r.from];
      console.log(`draft 열림: ${r.path} (${fromLabel}${s.version.draft ? `, v${s.version.draft}` : ""})`);
      if (s.changes.length) console.log(`미커밋 변경 ${s.changes.length}건:\n` + s.changes.map((c) => `  ${c.state} ${c.file}`).join("\n"));
      console.log(`발행: relay publish ${name}`);
      break;
    }

    case "publish": {
      const name = args.find((a) => !a.startsWith("--"));
      if (!name) throw new Error("사용법: relay publish <이름> [--version x.y.z]");
      // 데몬이 떠 있으면 그쪽에서 — 서비스 갈아타기와 이벤트 발화가 데몬 소유다
      const viaApi = await tryApi("/pkg/system/script/draft-publish", { input: { name, version: flag("version") } });
      const r = ((viaApi as any)?.result ?? viaApi) as { published?: boolean; version?: string; path?: string; note?: string; error?: string; build?: { ok: boolean; out: string } | null } | null;
      if (r && !r.error) {
        console.log(r.published ? `발행됨(daemon): ${name}@${r.version} -> ${r.path}` : `발행 안 함: ${r.note}`);
        if (r.build) console.log(`  view ${r.build.ok ? "빌드됨" : "빌드 실패"}: ${r.build.out}`);
        break;
      }
      if (r?.error) throw new Error(r.error);
      const { publishDraft } = await import("./draft.ts");
      const d = publishDraft(ledger, name, { version: flag("version") });
      console.log(d.published ? `발행됨: ${name}@${d.version} -> ${d.path} (데몬 꺼짐 — 서비스는 다음 기동 때 새 릴리스로 뜹니다)` : `발행 안 함: ${d.note}`);
      if (d.build) console.log(`  view ${d.build.ok ? "빌드됨" : "빌드 실패"}: ${d.build.out}`);
      break;
    }

    case "releases": {
      const name = args[0];
      if (!name) throw new Error("사용법: relay releases <이름>");
      const { listReleases } = await import("./draft.ts");
      const rs = listReleases(ledger, name);
      for (const rel of rs) console.log(`${rel.live ? "*" : " "} ${rel.version}\t${new Date(rel.time).toISOString()}`);
      if (!rs.length) console.log("릴리스 없음 — relay publish 로 발행하세요");
      break;
    }

    case "rollback": {
      const [name, version] = args;
      if (!name || !version) throw new Error("사용법: relay rollback <이름> <버전>");
      const viaApi = await tryApi("/pkg/system/script/release-rollback", { input: { name, version } });
      const r = ((viaApi as any)?.result ?? viaApi) as { version?: string; error?: string } | null;
      if (r && !r.error) {
        console.log(`롤백됨(daemon): ${name}@${r.version}`);
        break;
      }
      if (r?.error) throw new Error(r.error);
      const { rollbackRelease } = await import("./draft.ts");
      const d = rollbackRelease(ledger, name, version);
      console.log(`롤백됨: ${name}@${d.version} -> ${d.path}`);
      break;
    }

    case "grant": {
      const [consumer, provider] = args;
      if (!consumer || !provider) throw new Error("사용법: relay grant <consumer> <provider> [--tools a,b] [--mission m]");
      addGrant(ledger, {
        consumer,
        provider,
        tools: flag("tools")?.split(","),
        mission: flag("mission"),
      });
      console.log(`결재됨: ${consumer} -> ${provider}`);
      break;
    }

    default:
      console.log(
        [
          "relay - 개인 기판 씨앗",
          "",
          "  relay daemon                          기판 기동 (API, 서비스, 트리거, 콘솔)",
          "  relay install <dir> [--ring0] [--workspace dir]  패키지 설치 (디렉토리 = 설치본, workspace = 폴더 결재)",
          "  relay ls | rm <이름>                   목록 | 제거",
          "  relay validate <dir>                  manifest 판정",
          "  relay draft <이름>                     수정 레이어 열기 (설치본 사본, ~/.relay/drafts)",
          "  relay publish <이름> [--version v]     draft 판정 + 릴리스 스냅샷 + 장부 전환",
          "  relay releases <이름> | rollback <이름> <버전>  릴리스 목록 | 이전 버전 복귀",
          "  relay build <패키지>                   surfaces.view.out 재빌드",
          "  relay run <패키지> [프롬프트]           세션 (프롬프트 없으면 대화형)",
          "  relay harness-check <패키지>           하네스 계약 적합성 판정",
          "  relay login <패키지> [--token]         하네스 로그인 (대화형, login 동사 지원 시)",
          "  relay model <패키지> [모델]             모델 설정 (없으면 목록·현재 설정)",
          "  relay effort <패키지> [강도|off]        추론 강도 (effort capability 어댑터만 반영)",
          "  relay connect <패키지> <서비스>         자격 붙여넣기 (Keychain)",
          "  relay grant <consumer> <provider> --tools a,b | --mission m",
        ].join("\n"),
      );
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});

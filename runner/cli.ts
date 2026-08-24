#!/usr/bin/env node --experimental-strip-types
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { API_URL, RELAY_HOME, STORE_INDEX_URL, loadLedger, workspacePath } from "./supply/ledger.ts";
import { installPkg, removePkg, validateDir, registryData } from "./supply/install.ts";
import { startDaemon } from "./daemon.ts";
import { runSession } from "./runtime/harness.ts";
import { loadManifest } from "./supply/manifest.ts";
import { credKey } from "./vault.ts";
import { localAuthority } from "./authority.ts";

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

/** 반복 가능한 플래그 수집 (--bind a=b --bind c=d) */
function flagAll(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === "--" + name && args[i + 1]) out.push(args[i + 1]);
  return out;
}

/** dir 서비스 결재 파싱 — <서비스이름>=<경로> */
function parseBindings(): Record<string, string> | undefined {
  const list = flagAll("bind");
  if (!list.length) return undefined;
  const out: Record<string, string> = {};
  for (const b of list) {
    const i = b.indexOf("=");
    if (i <= 0) throw new Error(`--bind 형식: <dir서비스>=<경로>: ${b}`);
    out[b.slice(0, i)] = b.slice(i + 1);
  }
  return out;
}

/** 권한 고지서를 터미널 문장으로. 안 하는 것도 문장으로 적는다 — 없는 항목과 안 보여준 항목은 다르다 */
function printDisclosure(d: import("./supply/manifest.ts").Disclosure, name: string): string {
  const lines: string[] = ["", "  설치하면 이렇게 됩니다"];
  for (const f of d.folders) lines.push(`    폴더    ${f.path} 를 만들고 읽고 씁니다 (${f.name})`);
  lines.push(`    폴더    workspace ~/Relay/${name} 이 세션의 땅이 됩니다 (설치 시 변경 가능)`);
  for (const l of d.llm) lines.push(`    LLM     ${l.provider} 계정으로 돕니다 (${l.auth})`);
  for (const n of d.network) lines.push(`    외부    ${n.url} 로 나갑니다 (자격: ${n.auth})`);
  for (const w of d.wakeups) lines.push(`    자동    ${w.when} 에 스스로 깨어납니다 (${w.id})`);
  for (const s of d.spawns) lines.push(`    실행    ${s} 를 띄웁니다`);
  for (const b of d.borrows) lines.push(`    차용    ${b} — 활성화는 별도 결재(grant)`);
  if (d.connector) lines.push(`    자격    커넥터 계약 (${d.connector}) — relay connect ${name} ${name.split("/").pop()} 로 연결`);
  if (d.hostMethods.length) lines.push(`    기판    host 브리지 선언: ${d.hostMethods.join(", ")}`);
  if (d.host.length) lines.push(`    호스트  ${d.host.join(", ")} 가 있어야 합니다`);
  if (d.denied.length) lines.push(`    담장    ${d.denied.join(", ")} 에는 닿지 않겠다고 선언했습니다`);
  const nots: string[] = [];
  if (!d.network.length) nots.push("인터넷으로 나가지 않고");
  if (!d.wakeups.length) nots.push("스스로 깨어나지 않고");
  if (!d.borrows.length) nots.push("다른 패키지의 능력을 빌리지 않습니다");
  if (nots.length) lines.push(`    이 패키지는 ${nots.join(", ").replace(/, ([^,]*)$/, ", $1")}`);
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const ledger = loadLedger();
  // 권위 이음새 — CLI 도 데몬과 같은 문을 지난다 (자격·결재·감사). 1인 기판은 로컬 권위
  const authority = localAuthority(() => ledger);

  switch (cmd) {
    case "daemon": {
      startDaemon();
      break;
    }

    case "install": {
      const target = args.find((a) => !a.startsWith("--"));
      if (!target) throw new Error("사용법: relay install <디렉토리|아티팩트.relay|@scope/name> [--store 인덱스URL] [--key RELAY-...] [--ring0] [--name n] [--workspace dir] [--yes] [--digest sha256:...]");

      // 아티팩트(.relay) 또는 스토어 ref(@scope/name) — 봉인 검증과 동의 관문을 지나
      // 릴리스 자리로 앉는다. 디렉토리 설치와 달리 동의 전에는 패키지 코드가 한 줄도 실행되지 않는다
      if (/\.relay$/i.test(target) || target.startsWith("@")) {
        const { prepareArtifact, activatePrepared } = await import("./supply/install.ts");
        let p: import("./supply/install.ts").Prepared;
        if (target.startsWith("@")) {
          // 스토어 연결은 부르는 쪽이 켠다: --store 일회 지정 > RELAY_STORE_INDEX. 기본은 꺼짐 (OSS 에 마켓 없음)
          const storeUrl = flag("store") ?? STORE_INDEX_URL;
          if (!storeUrl) throw new Error("스토어가 설정되지 않았습니다 — --store <인덱스 URL> 을 붙이거나 .env 에 RELAY_STORE_INDEX 를 지정하세요");
          const { fetchStoreIndex, downloadArtifact, redeemArtifact } = await import("./supply/registry.ts");
          const idx = await fetchStoreIndex(storeUrl);
          const entry = idx.entries.find((e) => e.ref === target);
          if (!entry) throw new Error(`스토어에 없는 패키지: ${target}`);
          let file: string;
          const { cacheHit } = await import("./supply/registry.ts");
          const paidCache = entry.price != null && !entry.url ? cacheHit(entry.digest) : null;
          if (paidCache) {
            file = paidCache; // 이미 받은 봉투 — 키를 묻지 않는다
          } else if (entry.price != null && !entry.url) {
            const key = flag("key") ?? await authority.credential(`store-key/${entry.ref}`);
            if (!key) {
              throw new Error(`유료 패키지입니다 (₩${entry.price.toLocaleString()}) — 구매 후 받은 키를 --key RELAY-... 로 넣으세요`);
            }
            file = await redeemArtifact(storeUrl, idx.redeem, entry, key);
            await authority.setCredential(`store-key/${entry.ref}`, key.trim());
          } else {
            file = await downloadArtifact(storeUrl, entry);
          }
          console.log(`받음: ${entry.ref}@${entry.version} (${(entry.size / 1024).toFixed(0)}KB, 봉인 대조 통과)`);
          p = prepareArtifact(ledger, file, { name: flag("name"), digest: entry.digest, registry: storeUrl });
        } else {
          p = prepareArtifact(ledger, target, { name: flag("name"), digest: flag("digest") });
        }
        console.log(`${p.manifest.display_name} (${p.ref}@${p.version}, ${(p.size / 1024).toFixed(0)}KB)`);
        console.log(`  봉인 확인됨 ${p.digest.slice(0, 22)}...`);
        console.log(printDisclosure(p.disclosure, p.name));
        if (!has("yes")) {
          if (!process.stdin.isTTY) throw new Error("비대화형 설치에는 --yes 가 필요합니다 (위 고지서에 동의한다는 뜻입니다)");
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const answer = await new Promise<string>((resolve) => rl.question(p.fresh ? "설치할까요? [y/N] " : `업데이트할까요? (${p.name}) [y/N] `, resolve));
          rl.close();
          if (!/^y(es)?$/i.test(answer.trim())) {
            console.log("설치하지 않았습니다");
            break;
          }
        }
        const r = activatePrepared(ledger, p, { ring0: has("ring0"), workspace: flag("workspace"), bindings: parseBindings() });
        console.log(`${p.fresh ? "설치됨" : "업데이트됨"}: ${r.name} (${p.ref}@${p.version}, workspace: ${workspacePath(ledger, r.name)})`);
        if (r.setup && !r.setup.ok) console.error(`  하네스 setup 실패: ${r.setup.out}`);
        if (r.build) console.log(`  빌드됨: ${r.build.out}`);
        console.log("  데몬이 떠 있었다면 서비스는 다음 기동 때 새 릴리스로 뜹니다");
        break;
      }

      const viaApi = await tryApi("/install", { path: target, ring0: has("ring0"), workspace: flag("workspace"), bindings: parseBindings() });
      if (viaApi && !(viaApi as any).error) {
        console.log(`설치됨(daemon): ${JSON.stringify(viaApi)}`);
        break;
      }
      const r = installPkg(ledger, target, {
        ring0: has("ring0"),
        name: flag("name"),
        workspace: flag("workspace"),
        bindings: parseBindings(),
      });
      // workspace 는 폴더 결재다 — 설치 출력이 그 결재를 사용자 눈앞에 남긴다
      console.log(`설치됨: ${r.name} (${r.manifest.name}@${r.manifest.version}, workspace: ${workspacePath(ledger, r.name)}${ledger.packages[r.name].ring === 0 ? ", ring-0" : ""})`);
      if (r.setup && !r.setup.ok) console.error(`  하네스 setup 실패: ${r.setup.out}`);
      if (r.build) console.log(`  view ${r.build.ok ? "빌드됨" : "빌드 실패"}: ${r.build.out}`);
      break;
    }

    case "pack": {
      const target = args.find((a) => !a.startsWith("--"));
      if (!target) throw new Error("사용법: relay pack <설치이름|디렉토리> [--out 파일]");
      // 설치 이름이면 장부 path(릴리스 스냅샷)를, 아니면 디렉토리를 굽는다
      const dir = ledger.packages[target]?.path ?? path.resolve(target);
      const { packDir, updateMarketIndex } = await import("./supply/pack.ts");
      const out = flag("out");
      const r = packDir(dir, out);
      console.log(`구움: ${r.ref}@${r.version} -> ${r.file}`);
      console.log(`  파일 ${r.included.length}개, ${(r.size / 1024).toFixed(0)}KB, ${r.digest}`);
      if (r.excluded.length) {
        console.log(`  선언 밖이라 뺀 파일 ${r.excluded.length}개:`);
        for (const f of r.excluded.slice(0, 20)) console.log(`    - ${f}`);
        if (r.excluded.length > 20) console.log(`    ... 외 ${r.excluded.length - 20}개`);
      }
      if (!out) console.log(`  로컬 마켓 등재: ${updateMarketIndex(dir, r)}`);
      break;
    }

    case "build": {
      const { buildPkg } = await import("./supply/install.ts");
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
        await runSession({ ledger, pkg, authority, interactive: true });
      } else {
        const r = await runSession({ ledger, pkg, authority, prompt });
        console.log(r.reply);
      }
      break;
    }

    case "oauth": {
      const [pkg, service] = args;
      if (!pkg || !service) throw new Error("사용법: relay oauth <패키지> <서비스> — auth.kind: oauth 인 url 서비스의 인가 흐름");
      const rec = ledger.packages[pkg];
      if (!rec) throw new Error(`미설치 패키지: ${pkg}`);
      const m = loadManifest(rec.path);
      const svc = (m.services ?? []).find((s) => s.name === service);
      if (!svc || !("url" in svc) || svc.url == null) throw new Error(`url 서비스 아님: ${service}`);
      if (svc.auth?.kind !== "oauth") throw new Error(`oauth 자격 서비스 아님(${svc.auth?.kind ?? "none"}) — token 형은 relay connect`);
      const { runOAuthFlow } = await import("./runtime/oauth.ts");
      const bundle = await runOAuthFlow(svc.url, svc.auth, {
        clientId: async () => {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          const v = await new Promise<string>((resolve) => rl.question("등록된 앱의 client_id: ", resolve));
          rl.close();
          return v;
        },
      });
      await authority.setCredential(credKey(pkg, service), JSON.stringify(bundle));
      console.log(`연결됨: ${credKey(pkg, service)} (vault — access${bundle.refresh_token ? "+refresh" : ""}${bundle.expires_at ? ", 자동 회전" : ""})`);
      break;
    }

    case "keygen": {
      // 발행 키 — 개인 키는 vault, 공개 키는 배포 대상에게 전달(설치 기판이 RELAY_PUBKEYS 로 고정)
      const { keygen, SIGNING_VAULT_KEY } = await import("./supply/sign.ts");
      if (await authority.credential(SIGNING_VAULT_KEY) && !has("force")) {
        throw new Error("발행 키가 이미 있습니다 — 교체하려면 --force (이전 키로 서명된 봉투는 옛 공개 키로만 검증됩니다)");
      }
      const k = keygen();
      await authority.setCredential(SIGNING_VAULT_KEY, k.privatePem);
      console.log("발행 키 생성됨 (vault: signing/ed25519). 이후 relay pack 이 자동으로 서명합니다.");
      console.log("공개 키 (설치 기판의 RELAY_PUBKEYS 에 고정할 값):");
      console.log(k.publicB64);
      break;
    }

    case "connect": {
      const [pkg, service] = args;
      if (!pkg || !service) throw new Error("사용법: relay connect <패키지> <서비스>");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const token = await new Promise<string>((resolve) => rl.question(`${pkg}/${service} 토큰 붙여넣기: `, resolve));
      rl.close();
      await authority.setCredential(credKey(pkg, service), token.trim());
      console.log(`저장됨: ${credKey(pkg, service)} (vault)`);
      break;
    }

    case "harness": {
      const [pkg, name] = args;
      if (!pkg) throw new Error("사용법: relay harness <패키지> [이름]");
      const { setHarness } = await import("./supply/install.ts");
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
      const { conformPkg } = await import("./supply/conform.ts");
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
      const { harnessLogin } = await import("./supply/install.ts");
      process.exitCode = harnessLogin(ledger, pkg, rest);
      break;
    }

    case "model": {
      const [pkg, model] = args;
      if (!pkg) throw new Error("사용법: relay model <패키지> [모델]");
      const { harnessVerb } = await import("./supply/install.ts");
      if (!model) {
        const r = harnessVerb(ledger, pkg, "models");
        console.log(`지원 모델: ${r.out}`);
        console.log(`현재 설정: ${ledger.packages[pkg]?.model ?? "(어댑터 기본)"}`);
      } else {
        ledger.packages[pkg].model = model;
        const { saveLedger } = await import("./supply/ledger.ts");
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
      const { saveLedger } = await import("./supply/ledger.ts");
      saveLedger(ledger);
      console.log(`설정됨: ${pkg} -> ${level === "off" ? "(어댑터 기본)" : level}`);
      break;
    }

    case "draft": {
      const { openDraft, readDraft } = await import("./supply/draft.ts");
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
      const { publishDraft } = await import("./supply/draft.ts");
      const d = publishDraft(ledger, name, { version: flag("version") });
      console.log(d.published ? `발행됨: ${name}@${d.version} -> ${d.path} (데몬 꺼짐 — 서비스는 다음 기동 때 새 릴리스로 뜹니다)` : `발행 안 함: ${d.note}`);
      if (d.build) console.log(`  view ${d.build.ok ? "빌드됨" : "빌드 실패"}: ${d.build.out}`);
      break;
    }

    case "releases": {
      const name = args[0];
      if (!name) throw new Error("사용법: relay releases <이름>");
      const { listReleases } = await import("./supply/draft.ts");
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
      const { rollbackRelease } = await import("./supply/draft.ts");
      const d = rollbackRelease(ledger, name, version);
      console.log(`롤백됨: ${name}@${d.version} -> ${d.path}`);
      break;
    }

    case "grant": {
      const [consumer, provider] = args;
      if (!consumer || !provider) throw new Error("사용법: relay grant <consumer> <provider> [--tools a,b] [--mission m] [--components]");
      await authority.recordGrant({
        consumer,
        provider,
        tools: flag("tools")?.split(","),
        mission: flag("mission"),
        ...(has("components") ? { components: true } : {}),
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
          "  relay install <dir|.relay|@scope/name> [--store url] [--key k] [--bind svc=path]  패키지 설치",
          "  relay ls | rm <이름>                   목록 | 제거",
          "  relay validate <dir>                  manifest 판정",
          "  relay draft <이름>                     수정 레이어 열기 (설치본 사본, ~/.relay/drafts)",
          "  relay publish <이름> [--version v]     draft 판정 + 릴리스 스냅샷 + 장부 전환",
          "  relay releases <이름> | rollback <이름> <버전>  릴리스 목록 | 이전 버전 복귀",
          "  relay build <패키지>                   surfaces.{view,components}.out 재빌드",
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

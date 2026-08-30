import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIME, json, esc, readBody, streamFile } from "./http.ts";
import { spawn } from "node:child_process";
import { API_PORT, API_URL, RELAY_HOME, STORE_INDEX_URL, loadLedger, stageDir, sessionDir, workspacePath, artifactsDir, runningDaemonPid, runningDaemonRunner, takeoverReason, markDaemonStarting, markDaemonListening, clearDaemonMark, homeId, type Grant, type Ledger, type RunnerId } from "./supply/ledger.ts";
import { callbackUrlFor, closeTlsDoor, moveTlsDoor, openTlsDoor, tlsDoor, trustLocalCert } from "./tls.ts";
import { credKey } from "./vault.ts";
import { loadManifest, landingAgentName, listScripts, agentScriptScope, shortName, outwardService, type Manifest, type ServiceDecl } from "./supply/manifest.ts";
import { runSession, retireResident, retireResidents, retireAllResidents, setEnvelopeTap, setTurnTap, isSessionBusy, recoverDanglingTurns, listSessionSlots, enableResidents, resumeRemotes, stopAllRemotes, localSessionIO } from "./runtime/harness.ts";
import { handleClientWire, tapSessionEvent, adoptSessionTurn, releaseSessionTurn, recordSessionParent, type ClientWireIO } from "./runtime/wire.ts";
import { runScript, runScriptFrom, scriptMeta, verbLabelsAt, mcpCall, localServiceIO, type HostBridge, type ServiceIO } from "./runtime/scripts.ts";
// 동사 워커 — 상주(retireResidents)와 같은 자리에서 은퇴한다: 뿌리가 바뀌면 옛 코드의 워커는 조용해진 뒤 내려간다
import { retireScriptWorkers, retireAllScriptWorkers } from "./runtime/script-pool.ts";
import { handleMcp, sweepPendingDeliveries } from "./runtime/tools.ts";
import { handleStore } from "./supply/store.ts";
import { packDir, deliverToStage, updateMarketIndex } from "./supply/pack.ts";
import type { McpIO } from "./runtime/mcp.ts";
import { installPkg, buildPkg, removePkg, resolveProvider, registryData, validateDir, harnessVerb, probeHarness, connectHarnessToken, launchHarnessLogin, provisionHarness } from "./supply/install.ts";
import { openDraft, readDraft, writeDraft, diffDraft, commitDraft, validateDraft, publishDraft, stageRelease, discardDraft, listDrafts, buildDraft, draftPath, historyDraft, restoreDraft } from "./supply/draft.ts";
import { listReleases, rollbackRelease } from "./supply/release.ts";
import { saveLedger, consoleInstall } from "./supply/ledger.ts";
import { serveView, serveComponents, serveDraftView, serveDraftComponents, serveWorkspaceFile } from "./runtime/view.ts";
import { shellNav, storeLatest, homeDoc, SHELL_JS, consoleHref } from "./runtime/shell.ts";
import { loadSuites, upsertSuite, removeSuite, packSuite } from "./supply/suites.ts";
import { serviceStatuses, channelStatuses, connectionsOverview, probeProviders } from "./runtime/connections.ts";
import { assembleCredential, assembleFields, forgetAccount, judgeAccount, rememberAccount } from "./runtime/credential.ts";
import { logLine } from "./supply/ledger.ts";
import { dirCall, resolveDirService } from "./runtime/dirs.ts";
import { startServices, startChannels, startOneChannel, stopChannel, channelPid, runningServices, stopServices, stopAll, localIO, type RunnerIO } from "./runtime/services.ts";
import { verifyChannel } from "./supply/conform.ts";
import { Ticker } from "./runtime/triggers.ts";
import { loginStart, loginRead, loginInput, loginStop } from "./runtime/login.ts";
import { seedPool, poolNames, chooseHarness, POOL_DIR } from "./runtime/harness-entry.ts";
import { localAuthority, type Authority } from "./authority.ts";
import { fixedRedirect, receiveOAuthCallback, serviceAuthHeader, startServiceOAuth, serviceOAuthStatus, verifyService } from "./runtime/oauth.ts";
import { a2aMissionMarker, a2aMissionSlot, a2aToolName, edgeToolName, parseA2aToolName, parseEdgeToolName, sanitizeToolSegment, SLOT_RE, PARAM_SLUGS_RE } from "./protocol.ts";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));

/** 이 프로세스가 어느 러너에서 떴는가 — 앱 번들과 체크아웃을 가르는 실경로 + 판.
 *  기동이 옛 데몬을 물려받을지 판정하는 근거이자, /instance 가 감독자에게 내는 답이다 */
export const RUNNER_ID: RunnerId = {
  dir: (() => { try { return fs.realpathSync(RUNNER_DIR); } catch { return RUNNER_DIR; } })(),
  version: (() => {
    try { return String(JSON.parse(fs.readFileSync(path.join(RUNNER_DIR, "..", "package.json"), "utf8")).version ?? "0.0.0"); } catch { return "0.0.0"; }
  })(),
};
const SCHEMA_FILE = path.join(RUNNER_DIR, "..", "relay.manifest.yaml");
// 서빙 정본은 번들 산출물이다 — 소스가 아니라 컷이 구운 dist 를 낸다(계획 §4-a)
const ASSETS_DIR = path.join(RUNNER_DIR, "..", "chat", "dist");

// 채널의 '최근 오류'와 비밀 지우기는 runtime/connections.ts 로 이사했다 — 패키지 단위 상태
// (/pkg/…/channels)와 전 패키지 집계(/connections)가 같은 판정을 읽어야 해서다
/**
 * 폴더 고르기 — **네이티브 탐색기**를 띄우고 사람이 고른 경로를 답한다.
 *
 * 브라우저만으로는 안 된다: showDirectoryPicker 도 webkitdirectory 도 핸들·상대경로만 주고
 * 절대경로를 주지 않는다(설계상 그렇다). 그래서 경로 칸이 자유 입력으로 남아 있었고, 아무도
 * "~/Relay/memo" 를 손으로 치지 않는다. 기판은 그 컴퓨터에서 도니 진짜 탐색기를 열 수 있다.
 *
 * 고른 값은 홈 아래면 ~ 로 되돌린다 — 매니페스트에 기계 경로(/Users/이름/…)가 박히면 그 파일은
 * 그 컴퓨터에서만 맞는 것이 된다. 되돌린 뒤에도 판정은 그대로 지난다(설치 시 ~ 는 결재 대상).
 */
function pickFolder(prompt: string): Promise<{ dir?: string; canceled?: boolean; error?: string }> {
  const plan: [string, string[]] | null =
    process.platform === "darwin"
      ? ["osascript", ["-e", `POSIX path of (choose folder with prompt ${JSON.stringify(prompt)})`]]
      : process.platform === "win32"
        ? ["powershell", ["-NoProfile", "-Command", "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }"]]
        : ["zenity", ["--file-selection", "--directory", `--title=${prompt}`]];
  if (!plan) return Promise.resolve({ error: "이 운영체제에서는 폴더 고르기를 열 수 없습니다" });
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(plan[0], plan[1], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve({ error: `${plan[0]} 을 실행할 수 없습니다` });
    }
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", () => resolve({ error: `${plan[0]} 을 실행할 수 없습니다` }));
    child.on("close", (code) => {
      const picked = out.trim();
      // 취소는 실패가 아니다 — 화면은 아무 일도 하지 않아야 한다. 판정은 **로케일과 무관해야**
      // 한다: macOS 는 취소를 그 컴퓨터의 말로 답한다("사용자가 취소함. (-128)"). 영어 단어를
      // 찾으면 한국어 맥에서 취소가 빨간 오류로 뜬다. 숫자 -128 은 어느 말에서도 같다.
      // zenity 는 취소를 종료 코드 1 + 빈 stderr 로 답하므로 그것도 취소로 읽는다
      if (!picked) {
        const canceled = code === 0 || /\(-128\)/.test(err) || !err.trim();
        return resolve(canceled ? { canceled: true } : { error: err.trim() });
      }
      const home = os.homedir();
      const abs = picked.replace(/\/$/, "");
      resolve({ dir: abs === home ? "~" : abs.startsWith(home + path.sep) ? "~/" + abs.slice(home.length + 1) : abs });
    });
  });
}

/** 폴더 하나를 OS 파일 탐색기로 — 데이터의 거처가 폴더라는 약속을 한 클릭으로 증명하는 문 */
function openInFinder(dir: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(opener, [dir], { detached: true, stdio: "ignore" }).unref();
}



/** 데몬 자신의 오리진 — 상태를 바꾸는 요청의 Origin 화이트리스트(CSRF 판정). 데몬이 굽는
 *  화면(설치 동의·패키지 view·직결 채팅)은 전부 여기서 서빙되므로 이 집합이 곧 전부다 */
const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${API_PORT}`,
  `http://localhost:${API_PORT}`,
  `http://[::1]:${API_PORT}`,
]);

/** TLS 문이 선 뒤에 그 오리진을 자기 집합에 넣는다 — 같은 라우트의 두 번째 문이라 같은 자격이다.
 *  상수로 미리 계산하지 않는 이유: 문은 기동 뒤에 열리고 포트도 그때 정해진다(runner/tls.ts).
 *  빠뜨리면 조용히 깨진다 — 문은 열리는데 그 오리진에서 온 상태 변경 요청이 CSRF 로 튕긴다 */
function adoptTlsOrigins(port: number | null): void {
  if (port == null) return;
  for (const host of ["127.0.0.1", "localhost", "[::1]"]) SELF_ORIGINS.add(`https://${host}:${port}`);
}

/** 문의 신뢰 좌표 — 임베더가 **넓히는 선언**만 할 수 있다. 끄는 스위치는 없다.
 *
 *  왜 목록이고 술어가 아닌가: DNS rebinding 방어(아래 Host 검사)의 의도는 "Host 가 **선언된
 *  집합** 안이어야 한다"이고, loopback 이름 셋은 1인 기판의 그 집합일 뿐이다. 술어를 받으면
 *  `() => true` 가 합법이 되어 방어가 형태만 남는다. 목록을 받으면 임베더는 자기 Service DNS
 *  이름을 적을 수 있고 방어는 그대로다.
 *
 *  왜 env 가 아닌가: 환경변수는 사용자가 넘길 수 있는 문턱이라, 인증 없는 데몬이 실수로
 *  밖에 서는 길이 된다. 코드로만 넘긴다 — 임베더는 자기 문을 앞에 세운 뒤 이것을 쓴다. */
export interface ApiDoor {
  /** 추가로 허용할 Host 이름(포트 무관, 대소문자 무시). loopback 셋은 항상 통과한다 */
  hosts?: string[];
  /** 상태 변경 요청의 추가 허용 Origin(정확 문자열, 대소문자 무시) */
  origins?: string[];
  /** listen 좌표. 미지정 = 현행(127.0.0.1:API_PORT) · false = 임베더가 반환된 서버를 직접 listen.
   *  소켓을 넓히는 것만으로는 문이 열리지 않는다 — Host 선언이 짝으로 있어야 한다 */
  listen?: false | { port?: number; host?: string };
}

/** MCP 문 이음새(mcp.ts McpIO)를 세울 때 문이 아는 것 — 임베더가 기본 구현을 감싸거나 갈아 끼운다 */
export interface McpDoorContext {
  ledger: Ledger;
  authority: Authority;
  host: HostBridge;
  pkg: string;
  agent: string;
  /** 발신 슬롯 — 위임 완료 배달의 회신 주소. 구 번들은 null */
  session: string | null;
}

/** createApi 의 이음새 주입점 — 전부 미지정이면 1인 기판 현행 그대로다(additive).
 *  권위(4번째 인자)와 함께, 임베더가 데몬 문에서 갈아 끼울 수 있는 축의 전부다 */
export interface ApiOptions {
  /** 계약 축(client-protocol v1)의 저장소 — 세션 목록·이력·무대·설정 쓰기·하네스 조회 */
  wire?: ClientWireIO;
  /** 세션이 보는 도구 문 — 미지정이면 localMcpIO */
  mcp?: (ctx: McpDoorContext) => McpIO;
  /** 스폰의 env 반쪽 — 미지정이면 localIO(장부 HMAC·vault·홈 로그).
   *  임베더 장부에 secret 이 없으면 그 기본값의 토큰이 조용히 틀린다 */
  runner?: (ledger: Ledger) => RunnerIO;
  /** 동사가 보는 몸 주소(ctx.service) — 미지정이면 localServiceIO(이 호스트의 docker/프로세스 몸).
   *  임베더는 몸이 다른 pod(사람마다 다른 몸)에 있으므로 여기서 갈아 끼운다. 이것이 없던 동안
   *  HTTP 동사 문·트리거·draft-run 은 임베더 몸을 모른 채 localhost 를 두드렸다(실측 2026-08-26) */
  service?: ServiceIO;
  door?: ApiDoor;
}

// 브리지를 그대로 두고 권위 구현만 갈아 끼운다 (조립 지점: relay.ts daemon · createApi)
export function makeHostBridge(getLedger: () => Ledger, getTicker: () => Ticker | null, authority: Authority, service: ServiceIO = localServiceIO): HostBridge {
  return {
    registry: () => registryData(getLedger()),
    install: async (dir, opts) => {
      const r = await installPkg(getLedger(), dir, { ring0: opts?.ring0, workspace: opts?.workspace, bindings: opts?.bindings });
      retireResidents(r.name); // 재설치라면 상주가 옛 코드·옛 번들로 떠 있다
      retireScriptWorkers(r.name);
      await startServices(getLedger(), r.name, getLedger().packages[r.name].path, r.manifest);
      startChannels(getLedger(), r.name, getLedger().packages[r.name].path, r.manifest);
      getTicker()?.emit("relay.package.installed", { pkg: r.name });
      // setup 과 build 결과를 여기서 버리면 "설치 성공" 이 검증 없이 참이 된다
      return { name: r.name, setup: r.setup ?? null, build: r.build ?? null };
    },
    build: (name) => buildPkg(getLedger(), name),
    remove: (name) => {
      removePkg(getLedger(), name);
      return { removed: name };
    },
    grants: () => authority.grants() as Promise<Grant[]>,
    grant: async (g) => {
      await authority.recordGrant(g);
      return { ok: true };
    },
    validate: (dir) => validateDir(dir),
    draftOpen: (name, opts) => openDraft(getLedger(), name, opts),
    draftRead: (name, file) => (file ? readDraft(getLedger(), name, file) : readDraft(getLedger(), name)),
    draftWrite: (name, files, deletes, base) => writeDraft(name, files ?? {}, deletes ?? [], base),
    draftDiff: (name) => diffDraft(name),
    draftCommit: (name, message) => commitDraft(name, message),
    draftValidate: (name) => validateDraft(name),
    draftPublish: async (name, opts) => {
      const l = getLedger();
      // 임베더가 착지를 맡는 기판(Authority.publish) — 발행물은 여기 장부에 앉지 않는다. 스냅샷을
      // 봉투로 굽고 넘기며, 설치는 그쪽의 별 걸음이다. 거부는 그대로 throw(스튜디오가 사유를 낸다)
      if (authority.publish) {
        const st = await stageRelease(name, opts);
        if ("published" in st) return { ...st, landed: "org" };
        const env = packDir(st.path, path.join(os.tmpdir(), `relay-publish-${name}-${st.version}-${process.pid}.tgz`));
        try {
          const landing = await authority.publish({ name: st.name, version: st.version, digest: env.digest, file: env.file, manifest: st.manifest });
          return { published: true, name: st.name, version: st.version, landed: "org", note: landing?.note, href: landing?.href };
        } finally {
          fs.rmSync(env.file, { force: true });
          fs.rmSync(env.file + ".sig", { force: true });
        }
      }
      const r = await publishDraft(l, name, opts);
      if (r.published && r.path && r.manifest) {
        // 서비스·상주는 옛 릴리스 코드로 떠 있다 — 새 스냅샷으로 갈아탄다. 실패해도 발행 자체는 유효
        retireResidents(name);
        retireScriptWorkers(name);
        stopServices(name);
        const notes = [...(await startServices(l, name, r.path, r.manifest)), ...startChannels(l, name, r.path, r.manifest)];
        getTicker()?.emit(r.fresh ? "relay.package.installed" : "relay.package.published", { pkg: name, version: r.version });
        return { ...r, manifest: undefined, services: notes, landed: "local" };
      }
      return { ...r, manifest: undefined, landed: "local" };
    },
    draftDiscard: (name) => discardDraft(name),
    draftList: () => listDrafts(getLedger()),
    // 동사의 짧은 서술 — 설치본은 장부의 뿌리에서, 작업 사본은 draft 뿌리에서. 모듈을 import 만
    // 하고 부르지 않는다(scriptMeta 와 같은 규율). 없는 이름은 빈 답
    verbLabels: async (name, draft) => {
      const root = draft ? draftPath(name) : getLedger().packages[name]?.path;
      return root && fs.existsSync(root) ? verbLabelsAt(root) : {};
    },
    draftHistory: (name) => historyDraft(name),
    draftRestore: (name, hash) => restoreDraft(name, hash),
    // 미리보기 굽기 — 작업 사본을 /draft/<이름>/ 좌표로 굽는다. 장부도 도는 판도 건드리지
    // 않는다: 산출은 작업 사본 안의 out/ 이고 그것은 스냅샷에서 빠지는 임시물이다
    draftBuild: (name) => buildDraft(name),
    // 작업 사본의 동사 한 번 — 발행 전에 돌려보는 자리. 짓자마자 확인할 길이 없으면
    // 저작자는 발행을 확인 수단으로 쓰게 된다(그 순간 발행이 결정이 아니게 된다)
    draftRun: (name, verb, input) =>
      // host 를 넘기지 않는다(null) — 시험 삼아 도는 코드에 ring-0 권능까지 주면
      // 미리보기가 설치·발행을 할 수 있는 자리가 된다. 맥락은 주되 권능은 주지 않는다
      runScriptFrom(getLedger(), name, draftPath(name), verb, input, { principal: authority.principal() }, null, authority, service),
    // 굽기 — 설치본을 봉투 하나로 만들어 선반에 앉힌다.
    // 파일을 사람 손에 쥐여 주지 않는 것이 요점이다: 봉인(sha256)과 요구 범위가 함께
    // 계산된 상태로 선반에 남고, 등재 화면이 그 선반을 읽는다. 손으로 옮기는 순간
    // "빌더가 준 것"과 "스토어가 받은 것"이 어긋날 자리가 생긴다.
    pack: (name, deliverTo) => {
      const rec = getLedger().packages[name];
      if (!rec) throw new Error(`설치되지 않은 패키지입니다: ${name}`);
      const r = packDir(rec.path);
      const shelf = updateMarketIndex(rec.path, r);
      // 구운 봉투를 부른 쪽의 무대에 놓는다 — 굽기는 사람에게 건네려고 하는 일이고, 선반은
      // 세션이 닿지 못하는 자리다. 이 사본이 턴 끝의 무대 diff 에 걸려 대화의 다운로드가 된다
      const delivered = deliverTo ? deliverToStage(r.file, stageDir(deliverTo)) : [];
      return {
        ref: r.ref,
        version: r.version,
        file: path.basename(r.file),
        size: r.size,
        digest: r.digest,
        files: r.included.length,
        // 선언 밖이라 빠진 파일 — 빌더가 "왜 안 들어갔지"를 묻기 전에 먼저 보여준다
        excluded: r.excluded,
        shelf,
        /** 무대에 놓인 사본 — 대화가 이 이름으로 파일을 건넨다 */
        delivered,
      };
    },
    releaseList: (name) => listReleases(getLedger(), name),
    releaseRollback: async (name, version) => {
      const l = getLedger();
      const r = await rollbackRelease(l, name, version);
      retireResidents(name);
      retireScriptWorkers(name);
      stopServices(name);
      const notes = [...(await startServices(l, name, r.path, r.manifest)), ...startChannels(l, name, r.path, r.manifest)];
      return { name: r.name, version: r.version, path: r.path, services: notes };
    },
    dispatch: async (providerRef, mission, payload, consumer, consumerSlot) => {
      const ledger = getLedger();
      const provider = resolveProvider(ledger, providerRef);
      if (!provider) throw new Error(`provider 미설치: ${providerRef}`);
      const m = loadManifest(ledger.packages[provider].path);
      if (!(m.missions ?? []).some((x) => x.name === mission)) throw new Error(`미선언 미션: ${mission}`);
      // 첫 줄은 위임 마커다 — 수신 대화의 화면이 이 마커를 발신자 아이콘 카드로 렌더한다
      const prompt = `${a2aMissionMarker(mission, consumer)}\n${payload}`;
      // 열쇠는 (발신 패키지, 미션) — 문법 정본은 protocol.ts 다(도구 문의 진행 중 판정이 같은 벌을 쓴다)
      const slot = a2aMissionSlot(mission, consumer);
      // 위임 대화도 세션 목록의 시민이다 — 이름이 없으면 마커 원문이 라벨 행세를 해서 흉하다
      const labelFile = path.join(sessionDir(provider, slot), "label");
      if (!fs.existsSync(labelFile)) fs.writeFileSync(labelFile, `⇄ ${consumer ?? "외부"} → ${mission}`);
      // 부모 좌표(§5.3-26) — 이 미션이 **어느 대화의 부탁인지**. 서브에이전트 위임과 달리
      // 부모가 다른 패키지에 살아서 슬롯만으로는 못 가리킨다: 인스턴스를 함께 적는다.
      // 매번 덮는다(존재 시 생략이 아니다) — 같은 슬롯은 재위임에 재사용되므로 마지막으로
      // 시킨 대화가 곧 📬 를 받을 대화이고(deliverOnSettle 의 회신 주소와 같은 값이어야 한다),
      // 발신 슬롯 미상이면 지운다: 낡은 부모를 남기면 앞선 대화가 시키지도 않은 일을 자기
      // 현황 줄에 세운다
      recordSessionParent(provider, slot, consumerSlot && consumer ? { slot: consumerSlot, instance: consumer } : null);
      const r = await runSession({ ledger, pkg: provider, authority, prompt, slot });
      return r.reply;
    },
  };
}


export function createApi(
  getLedger: () => Ledger,
  host: HostBridge,
  ticker: Ticker,
  authority: Authority = localAuthority(getLedger),
  opts: ApiOptions = {},
): http.Server {
  // 신 wire 의 턴 장부는 세션이 흘리는 봉투를 방청해 쌓인다 — 이 배선이 없으면 stream/attach 가
  // reply 만 보고 delta·tool 이 통째로 사라진다(왕복은 성공하는데 스트리밍만 죽는 형태)
  setEnvelopeTap(tapSessionEvent);
  // wire 밖에서 열린 턴(도구 위임·트리거·CLI)도 관찰 창에 든다 — 이 배선이 없으면 그 턴들은
  // 붙을 id 가 없어 화면이 물음만 그린 채 멈춘다(위임 대화가 "안 도는 것처럼" 보이던 자리)
  setTurnTap({ open: adoptSessionTurn, close: releaseSessionTurn });
  const wire = { getLedger, authority, io: opts.wire };
  const runnerIO = (l: Ledger): RunnerIO => (opts.runner ?? localIO)(l);
  const extraHosts = new Set((opts.door?.hosts ?? []).map((h) => h.toLowerCase()));
  const extraOrigins = new Set((opts.door?.origins ?? []).map((o) => o.toLowerCase()));
  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      // URL 파싱은 try 안에서 — "//" 같은 기형 경로의 파싱 예외가 밖으로 새면
      // 요청 하나가 데몬 프로세스 전체를 죽인다 (2026-08-06 실사고)
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const p = url.pathname;
      // DNS rebinding 방어: 외부 도메인을 127.0.0.1 로 재바인딩한 브라우저 요청은
      // Host 가 그 도메인으로 오므로 여기서 끊긴다. 통과 집합은 loopback 이름 셋 + 임베더가
      // **선언한** 이름(ApiDoor.hosts)뿐이다 — 미선언 이름은 여전히 403 이라 방어는 그대로다
      const hostHdr = String(req.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHdr)
        && !extraHosts.has(hostHdr.toLowerCase())
        && !extraHosts.has(hostHdr.replace(/:\d+$/, "").toLowerCase())) {
        return void json(res, 403, { error: `허용되지 않은 Host: ${hostHdr}` });
      }
      // CSRF 방어: Host 검사는 DNS rebinding 만 막는다. 아무 웹페이지나 이 데몬으로 상태를
      // 바꾸는 요청을 보낼 수 있고(응답은 못 읽어도 부수효과는 난다 — 턴 개설은 곧 호스트
      // 권한 에이전트에 임의 프롬프트를 넣는 축이다), 문에는 인증이 없다. 브라우저는 비
      // GET/HEAD 요청에 Origin 을 반드시 싣는다는 성질이 유일한 판별점이다: 실려 있으면
      // 데몬 자신의 오리진이어야 하고, 없으면 브라우저 밖(어댑터·CLI·컨테이너)이라 통과다
      if (req.method !== "GET" && req.method !== "HEAD") {
        const reqOrigin = String(req.headers.origin ?? "").toLowerCase();
        if (reqOrigin && !SELF_ORIGINS.has(reqOrigin) && !extraOrigins.has(reqOrigin)) {
          return void json(res, 403, { error: `허용되지 않은 Origin: ${req.headers.origin}` });
        }
      }
      // 셸 홈 — 설치된 앱을 늘어놓는 런처. 앱 하나의 화면이 아니므로 패키지에 두지 않고
      // 기판이 낸다(runtime/shell.ts homeDoc). 종전에는 여기서 콘솔 패키지로 302 했다
      if (p === "/" || p === "") {
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        return void res.end(homeDoc(getLedger()));
      }
      // 이 문은 누구인가 — 홈(인스턴스의 신원)과 듣는 자리. 포트가 같아도 홈이 다르면 다른 기판이고,
      // 같은 포트에 다른 인스턴스가 설 수 있으므로(홈은 사람이 고른다) 부르는 쪽은 이것으로 대조한다.
      // 자격도 장부도 싣지 않는다 — 신원 한 줄이다
      if (p === "/instance" && req.method === "GET") {
        // runner 는 감독자(데스크톱 앱)가 "이 데몬이 내 번들에서 떴는가"를 묻는 자리다 —
        // 포트가 답한다는 사실만으로는 최신인지 알 수 없다(Node 는 적재한 모듈을 다시 읽지 않는다)
        return void json(res, 200, { home: homeId(), port: API_PORT, principal: authority.principal(), runner: RUNNER_ID.dir, version: RUNNER_ID.version });
      }
      if (p === "/registry" && req.method === "GET") return void json(res, 200, registryData(getLedger()));

      // 상주 한 방 — 셸 사이드바 상태점의 원천. 패키지마다 /pkg/<이름>/channels 를 물으면
      // 항목 수만큼 왕복이 나고, 그 응답의 대부분(자격 형태·최근 오류 로그 꼬리)은 점 하나에
      // 필요 없다. 자식 프로세스 맵의 키(<패키지>/<이름>)를 그대로 낸다 — 판정 없는 사실이라
      // 화면이 "이 패키지에 속한 키가 하나라도 있는가" 로 점을 켠다
      if (p === "/residency" && req.method === "GET") return void json(res, 200, { running: runningServices() });

      // 자격 전경 한 방 — 전 패키지의 바깥 서비스·창구 자격 상태. 연결 화면(콘솔 페이지)의 본문이고
      // 사이드바 배지·홈 배너가 같은 수를 읽는다. 채널과 서비스는 두 축으로 따로 실린다 — 성질이 다른
      // 두 문을 한 목록으로 섞지 않는다. 값은 실리지 않는다(hasCred 뿐)
      if (p === "/connections" && req.method === "GET") return void json(res, 200, await connectionsOverview(getLedger(), (k) => authority.credential(k)));
      // 연결 딥링크 — 패키지 화면이 "연결하러 가기" 로 보내는 안정 주소. 콘솔의 설치 이름은 장부가 답하므로
      // (consoleInstall) 패키지는 콘솔 페이지 주소를 조립하지 않는다. ?p=<패키지>&s=<서비스|채널> 은 그대로 넘긴다
      // TLS 문 두 동사 — 화면에 스위치는 없다(문은 조건 없이 열린다). 여기 있는 것은 **처방**이다:
      // 못 열었을 때의 재시도와, 기록된 포트가 점유됐을 때의 이동. 이동은 등록해 둔 콜백 주소를
      // 전부 고쳐야 하는 행위라 기판이 스스로 하지 않고 사람이 부르는 이 문만 지난다
      if (p === "/tls" && req.method === "GET") return void json(res, 200, tlsDoor());
      if (p === "/tls/open" && req.method === "POST") {
        const d = await openTlsDoor(handle);
        adoptTlsOrigins(d.port);
        return void json(res, d.open ? 200 : 409, { ...d, callback: callbackUrlFor(true) });
      }
      // 인증서 신뢰 — 안 눌러도 인가는 성립한다(브라우저 경고에서 "계속"). 이 문은 그 경고를
      // 없애려는 사람의 한 번의 행위이고, OS 인증 창이 곧 그 승인이다. 기판이 스스로 부르지 않는다
      if (p === "/tls/trust" && req.method === "POST") {
        try {
          await trustLocalCert();
          return void json(res, 200, { ok: true });
        } catch (e) {
          return void json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (p === "/tls/move" && req.method === "POST") {
        const b = await readBody(req);
        try {
          const d = await moveTlsDoor(Number(b.port), handle);
          adoptTlsOrigins(d.port);
          return void json(res, d.open ? 200 : 409, { ...d, callback: callbackUrlFor(true) });
        } catch (e) {
          return void json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      if (p === "/connect" && req.method === "GET") {
        res.writeHead(302, { location: consoleHref(getLedger(), "connections/") + url.search, "cache-control": "no-store" });
        return void res.end();
      }
      // 인가 콜백의 고정 문 — 등록된 OAuth 앱의 redirect_uri(OAUTH_CALLBACK_URL)가 여기다. 임시 포트는 등록이 안 되므로
      // 데몬의 문이 직접 받는다. state 로 기다리는 흐름에만 답이 닿고, 모르는 state 는 404 다(아무 페이지나 두드릴 수 있는 GET 문)
      if (p === "/oauth/cb" && req.method === "GET") {
        const taken = receiveOAuthCallback(url.searchParams);
        res.writeHead(taken ? 200 : 404, { "content-type": MIME[".html"], "cache-control": "no-store" });
        return void res.end(taken
          ? "<meta charset='utf-8'>연결되었습니다 — 이 창을 닫아도 됩니다."
          : "<meta charset='utf-8'>기다리는 인가 흐름이 없습니다 — 연결 화면에서 다시 시작하세요.");
      }

      // 전역 셸 크롬(runtime/shell.ts) — 모든 view 문서에 주입되는 사이드바의 본체와 그 데이터.
      // 스크립트는 기판과 원자적으로 움직여야 한다(위젯 번들과 같은 사유): 캐시된 옛 크롬이
      // 새 nav 계약을 읽으면 조용히 갈라진다
      if (p === "/shell.js" && req.method === "GET") {
        res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
        return void res.end(SHELL_JS);
      }
      // 초안(작업 사본)도 함께 싣는다 — 발행 전 패키지가 어느 화면에도 안 보이면 만들다 만 것이
      // 잃어버린 것처럼 보인다(스튜디오 시작 화면·홈이 "만드는 중" 으로 그린다)
      if (p === "/shell/nav" && req.method === "GET") {
        // 배지의 수는 연결 화면과 같은 집계(connections.ts)에서 온다 — 두 화면이 다른 수를 말하면 안 된다
        const overview = await connectionsOverview(getLedger(), (k) => authority.credential(k));
        const l = getLedger();
        return void json(res, 200, shellNav(l, runningServices(), await storeLatest(), await listDrafts(l), { credentials: overview.attention }, loadSuites(l)));
      }
      // 묶음(supply/suites.ts) — 사이드바 폴더이자 .relaypackages 봉투의 단위. 기판 상태라 셸과 같은 자리에서 낸다.
      // 판정 실패(미설치 구성원·이름 형식·순환)는 400 으로 사유를 그대로 낸다 — 화면이 그 문장을 보여 준다
      if (p === "/shell/suites" && req.method === "GET") return void json(res, 200, { suites: loadSuites(getLedger()) });
      if (p === "/shell/suites" && req.method === "POST") {
        const b = await readBody(req);
        try {
          const suite = upsertSuite(getLedger(), {
            name: String(b.name ?? ""),
            label: String(b.label ?? ""),
            members: Array.isArray(b.members) ? b.members.map(String) : [],
            hub: b.hub ? String(b.hub) : null,
          });
          return void json(res, 200, { suite });
        } catch (e) {
          return void json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }
      if (p === "/shell/suites/remove" && req.method === "POST") {
        const b = await readBody(req);
        return void json(res, 200, { removed: removeSuite(String(b.name ?? "")) });
      }
      if (p === "/shell/suites/pack" && req.method === "POST") {
        const b = await readBody(req);
        try {
          const r = packSuite(getLedger(), String(b.name ?? ""));
          const file = path.basename(r.file);
          // 받는 문은 선반 내보내기(store.ts /store/export)다 — 개별 봉투와 같은 길
          return void json(res, 200, { ...r, file, href: `/store/export/${encodeURIComponent(file)}` });
        } catch (e) {
          return void json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // 클라이언트 전송 계약 v1(docs/client-protocol.md) — 턴·세션·이력·파일·하네스 조회·열거.
      // 마운트 문법(/pkg/<pkg>·/)은 여기서만 해석되고 클라이언트는 base 주입으로 받는다(§2-6).
      // 매치되면 응답까지 책임지므로 아래 기판 라우트는 계약 밖 표면(설치·스토어·관리)만 남는다
      if (await handleClientWire(wire, req, res, url)) return;

      // 봉투가 오가는 표면(supply/store.ts) — 스토어 설치·선반 조회·내보내기·가져오기.
      // wire 와 같은 규약이다: 매치되면 응답까지 책임지고 true 를 준다
      if (await handleStore({ getLedger, authority, runnerIO, ticker }, req, res, url, p)) return;


      // 패키지 이미지 자산(카드 아바타 icon, 채널 배지 icon). 이미지 확장자만, 패키지 봉인
      const pkgAsset = p.match(/^\/pkg\/([^/]+)\/asset\/(.+)$/);
      if (pkgAsset && req.method === "GET") {
        const rec = getLedger().packages[decodeURIComponent(pkgAsset[1])];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        if (!/\.(svg|png|jpe?g|webp|ico|gif|avif)$/i.test(pkgAsset[2])) return void json(res, 404, { error: "이미지 자산만 서빙합니다" });
        const root = path.normalize(rec.path);
        const target = path.normalize(path.join(root, decodeURIComponent(pkgAsset[2])));
        if (target !== root && !target.startsWith(root + path.sep)) return void json(res, 403, { error: "경로 탈출" });
        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return void json(res, 404, { error: "없는 자산" });
        return void streamFile(target, res);
      }

      // 기판 소유 클라이언트 자산(채팅 위젯 번들). 패키지 view 가 아니라 기판이 서빙한다 —
      // 위젯은 하네스와의 연결지점이라 구현이 기판과 함께 움직여야 하기 때문.
      // 번들은 릴리스 컷이 굽는다(chat/ chat-build.mjs → dist) — js · css · 글꼴(woff2) 세 갈래다
      const asset = p.match(/^\/assets\/([a-z0-9-]+\.(?:js|css|woff2))$/);
      if (asset && req.method === "GET") {
        const file = path.join(ASSETS_DIR, asset[1]);
        if (!fs.existsSync(file)) {
          // 번들은 트리에 커밋하지 않는다(빌드 산출물) — 갓 클론한 트리에는 없다.
          // 조용한 404 로 두면 "채팅이 안 뜬다"가 원인 없이 남는다
          const hint = fs.existsSync(ASSETS_DIR) ? "" : " — 위젯 번들이 없습니다. `npm run build:widget` 을 먼저 실행하세요";
          return void json(res, 404, { error: `없는 자산: ${asset[1]}${hint}` });
        }
        // 위젯은 기판과 함께 움직이는 자산이다 — 낡은 캐시가 새 기판 API 와 어긋나면 조용히 깨진다
        res.setHeader("cache-control", "no-store");
        return void streamFile(file, res);
      }
      if (p === "/schema" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/yaml; charset=utf-8" });
        return void res.end(fs.readFileSync(SCHEMA_FILE, "utf8"));
      }
      if (p === "/schema.json" && req.method === "GET") {
        const { parse } = await import("yaml");
        return void json(res, 200, parse(fs.readFileSync(SCHEMA_FILE, "utf8")));
      }
      // 결재 문은 하나다 — HTTP 결재도 권위 이음새(recordGrant/removeGrant)를 지난다
      if (p === "/grants" && req.method === "POST") {
        const g = (await readBody(req)) as Grant;
        await authority.recordGrant(g);
        return void json(res, 200, { ok: true });
      }
      if (p === "/grants/remove" && req.method === "POST") {
        await authority.removeGrant((await readBody(req)) as Grant);
        return void json(res, 200, { ok: true });
      }
      if (p === "/install" && req.method === "POST") {
        const b = await readBody(req);
        const r = await host.install(String(b.path), { ring0: !!b.ring0, workspace: b.workspace ? String(b.workspace) : undefined, bindings: b.bindings && typeof b.bindings === "object" ? b.bindings : undefined });
        return void json(res, 200, r);
      }
      const buildRoute = p.match(/^\/pkg\/([^/]+)\/build$/);
      if (buildRoute && req.method === "POST") {
        return void json(res, 200, await host.build(decodeURIComponent(buildRoute[1])));
      }
      if (p === "/validate" && req.method === "POST") {
        const b = await readBody(req);
        return void json(res, 200, validateDir(String(b.path)));
      }

      const mcp = p.match(/^\/mcp\/([^/]+)$/);
      if (mcp && req.method === "POST") {
        const pkg = decodeURIComponent(mcp[1]);
        const token = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        const owner = await authority.packageForToken(token);
        if (owner !== pkg) return void json(res, 401, { error: "토큰 불일치" });
        const agent = url.searchParams.get("agent") ?? landingAgentName(loadManifest(getLedger().packages[pkg].path)) ?? "";
        // session = 발신 슬롯(composeBundle 이 mcp url 에 싣는다) — 위임 완료 배달의 목적지
        const ledger = getLedger();
        const session = url.searchParams.get("session");
        // 문 이음새 주입점 — 미지정이면 handleMcp 의 기본값(localMcpIO)이 그대로 선다
        const mcpIO = opts.mcp?.({ ledger, authority, host, pkg, agent, session });
        return void (await handleMcp(ledger, authority, host, pkg, agent, await readBody(req), res, session, mcpIO));
      }

      const hs = p.match(/^\/pkg\/([^/]+)\/harness$/);
      if (hs && req.method === "GET") {
        const l = getLedger();
        const pkg = decodeURIComponent(hs[1]);
        const rec = l.packages[pkg];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        const m = loadManifest(rec.path);
        // probe=1 이면 variant 전수를 실제로 실행해 준비 상태·계정·capabilities 를 싣는다.
        // 어댑터 구현이 정상이면 행마다 무조건 뜬다 — 활성만 점검하던 구멍의 답
        const probes = url.searchParams.get("probe") === "1"
          ? new Map((await probeHarness(l, pkg)).map((x) => [x.name, x]))
          : null;
        // 후보는 동봉분 ∪ 기판 풀이다. 선언만 읽으면 목록과 실제로 고를 수 있는 것이 갈린다 —
        // 전환(POST)은 후보에서 고르므로, 화면에 안 뜨는 것으로 바꿀 수 있는 상태가 된다
        const choice = chooseHarness(m, rec.harness, l.preferences?.harness);
        const verified = new Set(m.harness?.verified ?? []);
        const variants = choice.candidates.map((v) => ({
          name: v.name,
          provider: v.llm?.provider ?? null,
          // 풀 어댑터의 자산은 패키지 아래 있지 않다 — 주소가 갈린다
          icon: v.icon ? (poolNames().includes(v.name) ? `/harness/${encodeURIComponent(v.name)}/asset/${v.icon}` : v.icon) : null,
          llm_icon: v.llm?.icon ? (poolNames().includes(v.name) ? `/harness/${encodeURIComponent(v.name)}/asset/${v.llm.icon}` : v.llm.icon) : null,
          verified: verified.has(v.name),
          ...(probes?.get(v.name) ?? {}),
        }));
        return void json(res, 200, {
          active: choice.variant?.name ?? null,
          // 후보가 비면 사유를 싣는다 — 화면이 "왜 고를 게 없나" 를 그 자리에서 말한다
          reason: choice.reason,
          variants,
        });
      }
      if (hs && req.method === "POST") {
        const b = await readBody(req);
        const { setHarness } = await import("./supply/install.ts");
        const pkg = decodeURIComponent(hs[1]);
        retireResidents(pkg); // 상주는 이전 하네스로 떠 있다
        return void json(res, 200, await setHarness(getLedger(), pkg, String(b.name ?? "")));
      }

      // token 자격형의 웹 연결 경로 — vault 에 provider 소속으로 앉는다
      const hc = p.match(/^\/pkg\/([^/]+)\/harness\/connect$/);
      if (hc && req.method === "POST") {
        const b = await readBody(req);
        const setup = await connectHarnessToken(getLedger(), decodeURIComponent(hc[1]), String(b.token ?? ""));
        return void json(res, 200, { ok: setup.ok, setup });
      }

      // ── 채널 운영면 — 하네스 설정 다이얼로그의 자매. 저작(스튜디오)이 아니라 운영(콘솔)이다 ──
      // 상태 조회: 상주 pid·자격 존재·최근 오류를 합친다. 자격 값은 절대 싣지 않는다(hasCred 만)
      const chs = p.match(/^\/pkg\/([^/]+)\/channels$/);
      if (chs && req.method === "GET") {
        const l = getLedger();
        const pkg = decodeURIComponent(chs[1]);
        const rec = l.packages[pkg];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        // 판정은 connections.ts 한 벌 — 전 패키지 집계(/connections)와 같은 답이다. credential 은
        // **형태 선언**이라 그대로 나가고 값은 실리지 않는다(hasCred 뿐)
        return void json(res, 200, { channels: await channelStatuses(pkg, loadManifest(rec.path), (k) => authority.credential(k)) });
      }

      // connect(자격 저장) · verify(실왕복 판정) · restart(채널 하나 갈아타기) — relayos connections 3동사의 OSS 축소
      const cop = p.match(/^\/pkg\/([^/]+)\/channel\/([^/]+)\/(connect|verify|restart)$/);
      if (cop && req.method === "POST") {
        const l = getLedger();
        const pkg = decodeURIComponent(cop[1]);
        const channel = decodeURIComponent(cop[2]);
        const rec = l.packages[pkg];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        const m = loadManifest(rec.path);
        const c = (m.surfaces?.channels ?? []).find((x) => x.name === channel);
        if (!c) return void json(res, 404, { error: `없는 채널: ${channel}` });
        if (cop[3] === "connect") {
          const b = await readBody(req);
          const cred = String(b.cred ?? "").trim();
          if (!cred) return void json(res, 400, { error: "빈 자격" });
          await authority.setCredential(credKey(pkg, channel), cred); // 저장만 — 유효 판정은 verify 소관("저장됨 ≠ 유효")
          return void json(res, 200, { ok: true });
        }
        if (cop[3] === "verify") {
          return void json(res, 200, await verifyChannel(rec.path, c, await authority.credential(credKey(pkg, channel))));
        }
        // restart — 옛 상주를 죽이고 다시 스폰한다(새 자격 반영). 정체 가드가 겹침 레이스를 막는다
        stopChannel(pkg, channel);
        const note = startOneChannel(pkg, rec.path, c, runnerIO(l));
        return void json(res, 200, { ok: true, running: channelPid(pkg, channel) != null, note });
      }


      // ── 서비스 자격면 — 채널 3동사의 자매. 밖으로 나가는 두 형(url·api)의 auth(token·oauth)를 화면에서 잇는다.
      // 종전에는 이 축만 CLI 전용이었다(relay connect · relay oauth) — 화면에는 문 자체가 없었다.
      const svcs = p.match(/^\/pkg\/([^/]+)\/services$/);
      if (svcs && req.method === "GET") {
        const l = getLedger();
        const pkg = decodeURIComponent(svcs[1]);
        const rec = l.packages[pkg];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        // 판정은 connections.ts 한 벌 — 자격 축이 있는 두 형(url·api)만 서고, 칸 선언(fields)·필수 여부
        // (required)·안내(help)는 선언 그대로 나간다. 값은 실리지 않는다(hasCred 뿐)
        return void json(res, 200, {
          services: await serviceStatuses(pkg, loadManifest(rec.path), (k) => authority.credential(k)),
          canDisconnect: typeof authority.deleteCredential === "function",
          // 두 연결 표면(이 다이얼로그와 콘솔 /connections)이 같은 문 상태를 본다 — 한쪽만
          // 알면 같은 서비스가 두 화면에서 다른 처방을 낸다
          tls: tlsDoor(),
        });
      }

      const sop = p.match(/^\/pkg\/([^/]+)\/service\/([^/]+)\/(connect|verify|disconnect|oauth)$/);
      const sst = p.match(/^\/pkg\/([^/]+)\/service\/([^/]+)\/oauth\/status$/);
      if (sop || sst) {
        const mm = (sop ?? sst)!;
        const pkg = decodeURIComponent(mm[1]);
        const name = decodeURIComponent(mm[2]);
        const rec = getLedger().packages[pkg];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        const man = loadManifest(rec.path);
        const sv = (man.services ?? []).find((x) => x.name === name);
        const out = sv ? outwardService(sv) : null;
        if (!out) return void json(res, 404, { error: `자격 축이 없는 서비스: ${name}` });
        const auth = out.auth;
        const b = sop && req.method === "POST" ? await readBody(req) : {};
        // 계정 축 — 선언된 서비스는 계정이 있어야 좌표가 서고, 없는 서비스에 계정을 실으면 없는 좌표를 짓는 셈이다.
        // 조회(oauth/status)는 ?account= 로, 나머지는 본문의 account 로 온다
        const rawAccount = sst ? url.searchParams.get("account") : b.account;
        let account: string | null = null;
        if (auth?.accounts) {
          if (rawAccount == null || String(rawAccount).trim() === "") return void json(res, 400, { error: `계정 축이 선언된 서비스입니다: ${name} — account 를 실으세요` });
          try {
            account = judgeAccount(rawAccount);
          } catch (e) {
            return void json(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
        } else if (rawAccount != null && String(rawAccount) !== "") {
          return void json(res, 400, { error: `계정 축이 없는 서비스입니다: ${name} — services[].auth.accounts: true 를 선언해야 계정을 둘 수 있습니다` });
        }
        const key = credKey(pkg, name, account);

        if (sst && req.method === "GET") return void json(res, 200, serviceOAuthStatus(pkg, name, account));
        if (!sop || req.method !== "POST") return void json(res, 405, { error: "POST 만" });

        if (sop[3] === "connect") {
          if (auth?.kind !== "token") return void json(res, 400, { error: `token 자격형이 아닙니다(${auth?.kind ?? "none"}) — oauth 는 인가 흐름으로` });
          // 칸 선언(auth.fields)이 있으면 칸별 값(fields)을, 없으면 토큰 문자열(token)을 받는다 — 조립은
          // CLI(relay connect)와 같은 한 벌(credential.ts). 필수 칸이 비면 저장하지 않는다:
          // 반쪽 자격이 앉으면 "연결됨" 인데 401 이 나는 상태가 된다
          const values: Record<string, string> = {};
          for (const [k, v] of Object.entries((b.fields ?? {}) as Record<string, unknown>)) values[k] = String(v ?? "");
          if (b.token != null) values.token = String(b.token);
          const r = assembleCredential(auth.fields, values);
          if (!r.ok) return void json(res, 400, { error: `빈 칸: ${r.missing.join(", ")}`, missing: r.missing });
          await authority.setCredential(key, r.value); // 저장만 — 유효 판정은 verify 소관
          if (account) await rememberAccount(authority, pkg, name, account);
          return void json(res, 200, { ok: true });
        }
        if (sop[3] === "verify") {
          return void json(res, 200, await verifyService(authority, pkg, name, auth, account));
        }
        if (sop[3] === "disconnect") {
          if (typeof authority.deleteCredential !== "function") {
            return void json(res, 501, { error: "이 기판의 권위는 자격 폐기를 구현하지 않습니다" });
          }
          await authority.deleteCredential(key);
          if (account) await forgetAccount(authority, pkg, name, account);
          return void json(res, 200, { ok: true });
        }
        // oauth — 흐름을 열고 즉시 돌아온다. 브라우저는 데몬이 연다(사람과 같은 기기). 콜백은 데몬의 고정 문(/oauth/cb)으로
        // 온다 — 등록된 앱의 redirect_uri 가 그 주소다. 부속 칸(auth.fields)은 흐름 전에 조립해 번들에 앉힌다
        if (auth?.kind !== "oauth") return void json(res, 400, { error: `oauth 자격형이 아닙니다(${auth?.kind ?? "none"}) — token 은 connect 로` });
        // 콜백 주소는 **이 서비스의 선언**이 정한다(oauth_client.https). 요구하는데 문이 없으면 흐름을
        // 열지 않는다 — 제공자가 돌려주는 "redirect_uri 불일치"에는 사유가 없어 원인이 안 읽힌다
        const callback = callbackUrlFor(auth.oauth_client?.https === true);
        if (!callback) return void json(res, 409, { error: `이 제공자는 HTTPS 콜백을 요구하는데 기판의 TLS 문이 없습니다 — ${tlsDoor().error ?? "사유 미상"}` });
        let fields: Record<string, string | string[]> | undefined;
        if (auth.fields?.length) {
          const values: Record<string, string> = {};
          for (const [k, v] of Object.entries((b.fields ?? {}) as Record<string, unknown>)) values[k] = String(v ?? "");
          const r = assembleFields(auth.fields, values);
          if (!r.ok) return void json(res, 400, { error: `빈 칸: ${r.missing.join(", ")}`, missing: r.missing });
          fields = r.value;
        }
        try {
          const run = startServiceOAuth(authority, pkg, name, out.base, auth, {
            clientId: b.client_id ? String(b.client_id) : undefined,
            clientSecret: b.client_secret ? String(b.client_secret) : undefined,
            account,
            fields,
            redirect: fixedRedirect(callback),
          });
          return void json(res, 200, { ...run, running: !run.done });
        } catch (e) {
          return void json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // ── 풀 어댑터의 자산(아이콘) ──────────────────────────────────────────
      // 풀은 패키지가 아니라 /pkg/<n>/asset 을 쓸 수 없다. 어댑터 폴더 안 파일만 낸다
      const pa = p.match(/^\/harness\/([^/]+)\/asset\/([^/]+)$/);
      if (pa && req.method === "GET") {
        const name = decodeURIComponent(pa[1]);
        const file = decodeURIComponent(pa[2]);
        // 이름·파일 모두 한 칸짜리 이름이어야 한다 — 상위 이동은 위 정규식이 이미 막지만,
        // 자산 문은 밖에서 오는 경로라 판정을 문 안에서 한 번 더 한다
        if (!poolNames().includes(name) || file.includes("..")) return void json(res, 404, { error: "없는 자산" });
        return void serveWorkspaceFile(path.join(POOL_DIR, name), file, req, res);
      }

      // 제공사의 실제 준비 상태 — 어댑터에게 묻는다(프로세스를 띄운다). 목록과 나눠 둔 이유는
      // 비용이다: /connections 는 공짜로 서고 화면이 그린 뒤 이 문으로 행을 채운다.
      // oauth 형은 자격이 도구 소유라 금고를 봐선 영영 알 수 없다 — 이 문이 유일한 답이다
      if (p === "/providers/probe" && req.method === "GET") {
        return void json(res, 200, await probeProviders(getLedger(), (pkg) => probeHarness(getLedger(), pkg)));
      }

      // ── AI 제공사 연결 — **패키지가 아니라 provider 로 주소를 잡는다** ──────
      // 자격 좌표가 llm/<provider> 라 실제로 앱과 무관하게 앉는다. 종전 문(/pkg/<n>/harness/connect)
      // 은 같은 자리에 쓰면서 주소만 패키지였다 — 주소를 값에 맞춘다
      const pc = p.match(/^\/provider\/([^/]+)\/connect$/);
      if (pc && req.method === "POST") {
        const provider = decodeURIComponent(pc[1]);
        const b = await readBody(req);
        const token = String(b.token ?? "").trim();
        if (!token) return void json(res, 400, { error: "빈 토큰" });
        await authority.setCredential(`llm/${provider}`, token);
        return void json(res, 200, { ok: true, provider });
      }
      if (pc && req.method === "DELETE") {
        await authority.setCredential(`llm/${decodeURIComponent(pc[1])}`, "");
        return void json(res, 200, { ok: true });
      }

      // ── 사용자 전역 선호 — "나는 claude 로 일한다" 를 한 번만 말하는 자리.
      // 앱별 선택(PkgRecord.harness)이 이것을 이긴다 (harness-entry.ts chooseHarness)
      if (p === "/preferences" && req.method === "POST") {
        const b = await readBody(req);
        const l = getLedger();
        const want = b.harness == null ? null : String(b.harness);
        if (want && !poolNames().includes(want)) {
          // 풀에 없는 이름은 앱마다 있고 없고가 갈린다 — 전역 선호로 받으면 조용히 무시되는
          // 설정이 된다. 선호는 어디서나 뜻이 같은 이름만 받는다
          return void json(res, 400, { error: `전역 선호는 기판 풀의 하네스만 받습니다: ${poolNames().join(", ") || "(풀 비어 있음)"}` });
        }
        l.preferences = { ...(l.preferences ?? {}), ...(want ? { harness: want } : { harness: undefined }) };
        if (!want) delete l.preferences.harness;
        saveLedger(l);
        return void json(res, 200, { ok: true, preferences: l.preferences });
      }

      // ── 도구 설치 — "도구 없음" 상태의 처방. ensureBinary 는 이미 있고 문만 없었다 ──
      const hi = p.match(/^\/pkg\/([^/]+)\/harness\/install$/);
      if (hi && req.method === "POST") {
        const pkg = decodeURIComponent(hi[1]);
        const b = await readBody(req);
        return void json(res, 200, await provisionHarness(getLedger(), pkg, b.variant ? String(b.variant) : undefined));
      }

      // 대화형 로그인 발화. 인증 자체는 터미널(TTY)이 소유하고 기판은 그 창을 열어 줄 뿐이다
      // 로그인 두 갈래: headless(pty 중계 — 브라우저 안에서 끝난다)와 terminal(창을 여는 폴백)
      const hl = p.match(/^\/pkg\/([^/]+)\/harness\/login$/);
      if (hl && req.method === "POST") {
        const b = await readBody(req);
        const pkg = decodeURIComponent(hl[1]);
        if (b.mode === "terminal") {
          return void json(res, 200, { mode: "terminal", ...(await launchHarnessLogin(getLedger(), pkg, { switch: !!b.switch, variant: b.variant ? String(b.variant) : undefined })) });
        }
        return void json(res, 200, { mode: "headless", ...(await loginStart(getLedger(), pkg, authority, { switch: !!b.switch, variant: b.variant ? String(b.variant) : undefined })) });
      }
      const hlr = p.match(/^\/pkg\/([^/]+)\/harness\/login\/(read|input|stop)$/);
      if (hlr) {
        const pkg = decodeURIComponent(hlr[1]);
        if (hlr[2] === "read" && req.method === "GET") {
          return void json(res, 200, loginRead(pkg, Number(url.searchParams.get("from") ?? 0)));
        }
        if (hlr[2] === "input" && req.method === "POST") {
          const b = await readBody(req);
          return void json(res, 200, loginInput(pkg, String(b.text ?? "")));
        }
        if (hlr[2] === "stop" && req.method === "POST") return void json(res, 200, loginStop(pkg));
      }

      // setup 만 남는다 — 하네스 조회 3동사(info·models·commands)와 model/effort 설정은
      // 클라이언트 계약이 가져갔다(§5.5-29·30). setup 은 준비 상태를 여는 관리 동사라 계약 밖(§5.5-31)
      const hv = p.match(/^\/pkg\/([^/]+)\/harness\/setup$/);
      if (hv && req.method === "GET") {
        return void json(res, 200, await harnessVerb(getLedger(), decodeURIComponent(hv[1]), "setup"));
      }

      // 데이터 폴더 열기 — 패키지의 workspace 를 OS 파일 탐색기로 연다.
      // 데이터의 거처가 폴더라는 약속을 화면에서 한 클릭으로 증명하는 문이다
      const wsOpen = p.match(/^\/pkg\/([^/]+)\/workspace\/open$/);
      if (wsOpen && req.method === "POST") {
        const name = decodeURIComponent(wsOpen[1]);
        if (!getLedger().packages[name]) return void json(res, 404, { error: `미설치 패키지: ${name}` });
        const dir = workspacePath(getLedger(), name);
        fs.mkdirSync(dir, { recursive: true });
        openInFinder(dir);
        return void json(res, 200, { ok: true, dir });
      }
      // 작업 폴더의 파일 — 패키지 자기 view 가 자기 산출물을 그리는 읽기전용 문(runtime/view.ts
      // serveWorkspaceFile). 결재 축이 아니라 선언이 없다: 화면도 폴더도 같은 패키지 것이다
      const wsFile = p.match(/^\/pkg\/([^/]+)\/workspace\/(.+)$/);
      if (wsFile && req.method === "GET") {
        const name = decodeURIComponent(wsFile[1]);
        if (!getLedger().packages[name]) return void json(res, 404, { error: `미설치 패키지: ${name}` });
        return void serveWorkspaceFile(workspacePath(getLedger(), name), decodeURIComponent(wsFile[2]), req, res);
      }

      // 폴더 들여다보기 — 그 안에 무엇이 있나. 감금·목록은 dirCall 이 이미 하는 일이고(세션이
      // dir__*__list 로 부르는 그 연산 그대로), 이 문은 같은 것을 화면에 낸다. 새 규칙을 만들지
      // 않는 것이 요점이다 — 화면이 세션보다 더 볼 수 있으면 캡이 두 벌이 된다
      const dirList = p.match(/^\/pkg\/([^/]+)\/dir\/([^/]+)\/list$/);
      if (dirList && req.method === "GET") {
        const name = decodeURIComponent(dirList[1]);
        const svc = decodeURIComponent(dirList[2]);
        const rec = getLedger().packages[name];
        if (!rec) return void json(res, 404, { error: `미설치 패키지: ${name}` });
        try {
          const root = resolveDirService(getLedger(), name, loadManifest(rec.path), svc);
          return void json(res, 200, { root, ...(await dirCall(root, "list", { depth: 1 }) as object) });
        } catch (e) {
          return void json(res, 404, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // 폴더 열기 — services[].dir 한 칸을 OS 파일 탐색기로. 경로는 **장부가 답한다**
      // (resolveDirService → dirBindings): 화면이 보낸 문자열로 열면 그 순간 아무 폴더나 여는
      // 문이 된다. 세션이 그 폴더를 dir__* 도구로만 만지는 것과 같은 결재를 이 문도 지난다.
      const dirOpen = p.match(/^\/pkg\/([^/]+)\/dir\/([^/]+)\/open$/);
      if (dirOpen && req.method === "POST") {
        const name = decodeURIComponent(dirOpen[1]);
        const svc = decodeURIComponent(dirOpen[2]);
        const rec = getLedger().packages[name];
        if (!rec) return void json(res, 404, { error: `미설치 패키지: ${name}` });
        let dir: string;
        try {
          dir = resolveDirService(getLedger(), name, loadManifest(rec.path), svc);
        } catch (e) {
          return void json(res, 404, { error: e instanceof Error ? e.message : String(e) });
        }
        fs.mkdirSync(dir, { recursive: true });
        openInFinder(dir);
        return void json(res, 200, { ok: true, dir });
      }

      // 폴더 고르기 — 패키지에 매이지 않는다(아직 선언에 앉지 않은 값을 고르는 자리다).
      // 고른 값이 실제로 허용되는지는 여기서 판정하지 않는다: 적용할 때 install 이 판정한다
      if (p === "/pick/dir" && req.method === "POST") {
        const b = await readBody(req).catch(() => ({}));
        return void json(res, 200, await pickFolder(typeof b.prompt === "string" ? b.prompt : "이 에이전트가 쓸 폴더를 고르세요"));
      }

      const script = p.match(/^\/pkg\/([^/]+)\/script\/([a-z0-9-]+)$/);
      if (script && req.method === "POST") {
        const b = await readBody(req);
        const result = await runScript(getLedger(), decodeURIComponent(script[1]), script[2], b.input ?? b, { principal: authority.principal() }, host, authority, opts.service ?? localServiceIO);
        return void json(res, 200, { result });
      }
      // GET 문 — scripts.get 에 선언한 동사만. 브라우저 주소·리다이렉트·웹훅 검증처럼 GET 으로 오는 호출의 자리다.
      // 입력은 질의 문자열(같은 키가 여럿이면 배열), 답은 문자열이면 text/plain(검증 챌린지처럼 본문 그대로를 요구하는
      // 상대), 아니면 JSON. 이 문에는 Origin 판정이 없다(브라우저는 GET 에 Origin 을 싣지 않는다) — 그래서 선언으로만
      // 열리고 고지서에 선다. 동사의 권능은 POST 문과 같다: 같은 동사가 문에 따라 다르게 도는 일이 없어야 한다
      if (script && req.method === "GET") {
        const pkg = decodeURIComponent(script[1]);
        const rec = getLedger().packages[pkg];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        if (!(loadManifest(rec.path).scripts?.get ?? []).includes(script[2])) {
          return void json(res, 405, { error: `GET 문이 없는 동사: ${script[2]} — scripts.get 에 선언한 동사만 GET 으로 열립니다` });
        }
        const input: Record<string, string | string[]> = {};
        for (const k of new Set(url.searchParams.keys())) {
          const all = url.searchParams.getAll(k);
          input[k] = all.length > 1 ? all : all[0];
        }
        const result = await runScript(getLedger(), pkg, script[2], input, { principal: authority.principal() }, host, authority, opts.service ?? localServiceIO);
        if (typeof result === "string") {
          res.writeHead(200, { "content-type": MIME[".txt"], "cache-control": "no-store" });
          return void res.end(result);
        }
        return void json(res, 200, { result });
      }

      const comps = p.match(/^\/pkg\/([^/]+)\/components(\/.*)?$/);
      if (comps && req.method === "GET") return void serveComponents(getLedger(), decodeURIComponent(comps[1]), (comps[2] ?? "/").slice(1), res);
      const view = p.match(/^\/pkg\/([^/]+)\/view(\/.*)?$/);
      if (view && req.method === "GET") return void serveView(getLedger(), decodeURIComponent(view[1]), (view[2] ?? "/").slice(1), res);

      // ── 작업 사본의 문 — 발행 전에 눈으로 보는 판 ────────────────────────
      // /pkg/ 와 같은 세 갈래(view · components · asset)를 작업 사본 뿌리에 대고 낸다.
      // 장부를 지나지 않는 것이 요점이다: 여기서 무엇을 봐도 도는 판은 그대로다.
      const dview = p.match(/^\/draft\/([^/]+)\/view(\/.*)?$/);
      if (dview && req.method === "GET") {
        const name = decodeURIComponent(dview[1]);
        return void serveDraftView(getLedger(), name, draftPath(name), (dview[2] ?? "/").slice(1), res);
      }
      const dcomps = p.match(/^\/draft\/([^/]+)\/components(\/.*)?$/);
      if (dcomps && req.method === "GET") {
        const name = decodeURIComponent(dcomps[1]);
        return void serveDraftComponents(name, draftPath(name), (dcomps[2] ?? "/").slice(1), res);
      }
      const dasset = p.match(/^\/draft\/([^/]+)\/asset\/(.+)$/);
      if (dasset && req.method === "GET") {
        if (!/\.(svg|png|jpe?g|webp|ico|gif|avif)$/i.test(dasset[2])) return void json(res, 404, { error: "이미지 자산만 서빙합니다" });
        const root = path.normalize(draftPath(decodeURIComponent(dasset[1])));
        const target = path.normalize(path.join(root, decodeURIComponent(dasset[2])));
        if (target !== root && !target.startsWith(root + path.sep)) return void json(res, 403, { error: "경로 탈출" });
        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return void json(res, 404, { error: "없는 자산" });
        return void streamFile(target, res);
      }

      json(res, 404, { error: `없는 경로: ${p}` });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  };
  const server = http.createServer(handle);
  // listen 좌표. false 면 소켓의 주인은 임베더다 — 반환된 서버를 자기가 연다(자기 문 뒤에서).
  // 여기서 열지 않는 것이 요점이다: 우리가 loopback 을 먼저 열어 두면 임베더가 원치 않는
  // 리스너가 하나 더 서고, 그 문에는 인증이 없다
  if (opts.door?.listen !== false) {
    server.listen(opts.door?.listen?.port ?? API_PORT, opts.door?.listen?.host ?? "127.0.0.1");
    // TLS 문 — 인가 콜백에 HTTPS 를 요구하는 제공자를 위한, 같은 라우트의 두 번째 문. **조건 없이**
    // 연다(runner/tls.ts 머리 주석의 왜 — 선언으로 여닫으면 설치·제거가 남의 등록 주소를 갈아친다).
    // 못 열어도 데몬은 그대로 선다: 사유는 /connections 의 tls 축으로 나가 화면이 그 자리에서 말한다
    void openTlsDoor(handle).then((d) => {
      adoptTlsOrigins(d.port);
      console.log(d.open ? `TLS 문: ${callbackUrlFor(true)} (인가 콜백)` : `TLS 문 없음 - ${d.error}`);
    });
    // 두 번째 문의 수명을 첫 번째에 묶는다. 부르는 쪽이 쥐는 것은 이 server 하나뿐이라
    // (테스트도, 임베더도) 닫을 손이 여기밖에 없다 — 안 묶으면 http 문을 닫아도 https 문이
    // 남아 프로세스가 안 죽는다. 실측: 기동이 몇 ms 느려지는 것만으로 문이 여는 데 성공해,
    // 그때부터 그 테스트 파일이 통째로 매달렸다(문이 열리기 전에 끝나면 안 보이던 잠복 결함)
    server.once("close", () => closeTlsDoor());
  }
  return server;
}


/**
 * 위젯 번들 부재 판정 — 없으면 **부트 로그에** 처방을 남긴다.
 *
 * 404 핸들러에도 같은 처방이 있지만(위 /assets 분기) 그것은 읽는 사람이 없는 채널이다:
 * 소비자가 `<script src>` 태그라 브라우저가 404 본문을 버린다. 사용자가 보는 것은 "채팅이
 * 안 뜬다" 하나뿐이고, 원인은 devtools 네트워크 탭까지 내려가야 나온다. 그래서 판정을 **사람이
 * 지금 보고 있는 터미널**로 옮긴다 — 바로 다음 줄이 그 페이지의 주소이므로, 열기 전에 읽는다.
 *
 * 죽이지 않는 이유: 번들은 채팅 표면의 전제일 뿐 데몬의 전제가 아니다. CLI·도구·트리거만 쓰는
 * 기동에서 이것으로 문을 닫으면 없어도 되는 의존을 강제하는 것이다. 릴리스 번들에는 항상
 * 들어 있으므로(release.yml build:widget) 이 줄이 뜨는 것은 개발 트리뿐이다.
 */
/**
 * 옛 데몬을 내리고 그 자리가 비기를 기다린다. 정중한 신호(SIGTERM)로 시작하는 것이 계약이다 —
 * 그쪽에도 정리할 것이 있다(상주·채널·트리거·기록). 끝내 안 내려가면 fail-loud: 여기서 그냥
 * 진행하면 포트를 못 잡아 이유 없는 EADDRINUSE 로 죽는다.
 *
 * 동기 대기인 이유: startDaemon 은 이 뒤로 문·서비스·복구가 순서대로 서는 자리라, 옛 데몬이 아직
 * 살아 있는 동안 그 일들이 시작되면 두 판이 같은 세션·같은 폴더를 동시에 만진다.
 */
function retireDaemon(pid: number, waitMs = 10_000): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // 이미 없다
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // 내려갔다
    }
    // 이 자리에는 이벤트 루프가 없다(기동 전) — 동기 대기가 유일한 길이다.
    // 프로세스를 띄우지 않는다: 스폰의 자리는 spawn.ts 하나이고, 잠깐 자는 데 자식이 필요하지 않다
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  throw new Error(`옛 데몬이 내려가지 않습니다: pid ${pid} — 직접 내린 뒤 다시 시작하세요 (kill ${pid})`);
}

function widgetBundleNote(): string {
  if (fs.existsSync(path.join(ASSETS_DIR, "chat-app.js"))) return "";
  return "⚠ 채팅 위젯 번들이 없습니다(chat/dist — 빌드 산출물이라 갓 클론한 트리에는 없다).\n"
    + "  콘솔의 채팅이 뜨지 않습니다: `npm run build:widget` 을 실행하세요.";
}

// ── 데몬 기동·종료 ───────────────────────────────────────────────────────────
// 순서가 계약이다. 끊긴 턴 복구는 서비스 기동보다 **먼저** 와야 한다 — 도는 턴이 하나도
// 없는 이 순간만이 죽은 턴과 살아 있는 턴을 구별할 수 있는 자리다.
// CLI(cli.ts)는 이 함수를 부르기만 한다(CLAUDE.md: CLI 는 얇은 디스패처).
export function startDaemon(): void {
  // 데몬의 cwd 는 사라지지 않는 곳이어야 한다 — Tauri 앱이 임시 스테이징 디렉토리에서 띄운 데몬의 cwd 가
  // 뒤에 지워져, 그 cwd 를 물려받는 자식(하네스 verb)이 전부 침묵한 실사고(2026-08-28). 홈은 남는다.
  try { process.chdir(os.homedir()); } catch { /* 홈조차 없으면 있던 자리 — 진입 디렉토리 기본 cwd(spawn.ts)가 받친다 */ }
  // 같은 홈에 데몬은 하나다 — 홈이 곧 인스턴스라서. 다만 "하나"의 뜻은 "같은 판 하나"다:
  // 옛 러너로 뜬 데몬이 남아 있으면 물려받는다. 앱을 업데이트해도 도는 프로세스는 옛 코드를 든 채
  // 남고(Node 는 적재한 모듈을 다시 읽지 않는다), 감독자는 "포트가 답하니 살아 있다"로 넘어간다.
  // 그 매듭을 여기서 푼다 — 새 판으로 뜬 기동이 옛 데몬을 갈아 끼우면 업데이트가 그것으로 완성된다.
  const old = runningDaemonPid();
  if (old != null) {
    const why = takeoverReason(runningDaemonRunner(), RUNNER_ID);
    if (!why) throw new Error(`데몬이 이미 실행 중입니다: pid ${old} (${API_URL}) — 이 홈(${RELAY_HOME})의 CLI 는 그 데몬을 따라갑니다`);
    console.log(`옛 데몬을 물려받습니다: pid ${old} — ${why}`);
    retireDaemon(old);
  }
  markDaemonStarting();
  // 상주 하네스는 데몬만 허용한다 — CLI 1회 실행이 상주를 남기면 고아가 된다
  enableResidents();
  // 어댑터 풀 펴기. 콘솔 패키지가 동봉한 넷을 홈 하위로 펴서 **모든 앱**이 후보로 본다.
  // 출처 지문이 같으면 아무것도 하지 않으므로 매 기동 비용은 stat 몇 번이다.
  // 앱이 새 판으로 갈리면 지문이 달라져 다음 기동에 다시 편다 — 이것이 어댑터 갱신 경로다
  try {
    const boot = loadLedger();
    const seed = seedPool(boot, consoleInstall(boot));
    if (seed) console.log(`하네스 풀: ${seed.seeded.join(", ")} (출처 ${seed.from})`);
  } catch (e) {
    console.error(`하네스 풀을 펴지 못했습니다 — 동봉 어댑터로만 돕니다: ${e instanceof Error ? e.message : e}`);
  }
  let ticker: Ticker | null = null;
  // 데몬의 권위는 항상 신선한 장부를 본다 — CLI 1회분(위 authority)과 달리 요청마다 재적재
  const daemonAuthority = localAuthority(() => loadLedger());
  const host = makeHostBridge(() => loadLedger(), () => ticker, daemonAuthority);
  ticker = new Ticker(() => loadLedger(), host, daemonAuthority);
  const server = createApi(() => loadLedger(), host, ticker, daemonAuthority);
  // 포트 기록은 문이 실제로 열린 뒤 — 같은 홈의 CLI 가 이 기록을 따라온다(ledger.ts discoverApiPort).
  // 값은 선언(API_PORT)이 아니라 **실제 바인딩된 주소**에서 읽는다: 기록은 "여기로 오라"는 약속이라
  // 문이 선 자리와 한 글자도 달라서는 안 된다(임베더가 listen 좌표를 바꿔도 기록은 진실을 말한다)
  server.once("listening", () => {
    const addr = server.address();
    if (addr && typeof addr === "object") markDaemonListening(addr.port, RUNNER_ID);
  });
  // 문을 못 열면 조용히 죽지 않는다. 포트가 막힌 것은 십중팔구 **다른 홈**의 기판이다(같은 홈이면 위에서
  // 기동을 거부했다) — 그 사실과 처방을 말하고, 반쯤 적힌 기록을 지운 채 내려간다
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`포트 ${API_PORT} 를 다른 프로세스가 듣고 있습니다 — 이 홈(${RELAY_HOME})의 데몬은 아닙니다. 다른 홈의 기판이면 RELAY_PORT 로 다른 포트를 주거나 그쪽을 내리세요`);
    } else {
      console.error(`문을 열지 못했습니다: ${e.message}`);
    }
    ticker?.stop();
    clearDaemonMark();
    process.exit(1);
  });
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
  // 지난 기동이 배달하지 못한 위임 결과 — 복구 **뒤에** 줍는다(중단된 위임의 마지막 줄은 위
  // 복구가 앉힌다). 문을 막지 않는다: 배달은 세션을 여는 일이라 오래 걸릴 수 있다
  void sweepPendingDeliveries(daemonAuthority)
    .then((n) => { if (n) console.log(`미결 위임 배달: ${n}건`); })
    .catch((e) => console.error(`미결 위임 배달 실패 - ${e}`));
  // 서비스·채널 기동은 문을 막지 않는다 — 컨테이너 몸의 docker build 가 수 분 걸려도 데몬은 이미 듣는다
  void (async () => {
    for (const [name, rec] of Object.entries(l.packages)) {
      try {
        const m = loadManifest(rec.path);
        const notes = [...(await startServices(l, name, rec.path, m)), ...startChannels(l, name, rec.path, m)];
        for (const n of notes) console.log(n);
      } catch (e) {
        console.error(`${name}: 서비스 기동 실패 - ${e}`);
      }
    }
  })();
  // 원격 제어 상주 — 장부에 켜짐이 남은 패키지를 잇는다(서비스와 같은 자리, 문을 막지 않는다)
  void resumeRemotes(daemonAuthority, localSessionIO(() => loadLedger()))
    .then((notes) => { for (const n of notes) console.log(n); })
    .catch((e) => console.error(`원격 제어 상주 재개 실패 - ${e}`));
  // 기동 첫 줄에 홈을 적는다 — 한 기계에 인스턴스가 둘일 수 있고(데스크톱과 체크아웃), 주소만으로는
  // 어느 쪽이 떴는지 알 수 없다. 사람이 로그에서 가장 먼저 확인하는 것이 이 짝이다
  console.log(`relay daemon: ${API_URL} (home: ${RELAY_HOME}, principal: ${daemonAuthority.principal()})`);
  const widget = widgetBundleNote();
  if (widget) console.log(widget);
  console.log(`콘솔: ${API_URL}/pkg/system/view/`);
  // 종료 신호는 둘이다 — 사람이 내리는 Ctrl-C(SIGINT)와 기계가 내리는 종료(SIGTERM: kill·
  // pkill·시스템 종료·프로세스 관리자). 정리가 한쪽에만 걸려 있으면 다른 쪽으로 죽을 때
  // 자식이 고아로 남는다: POSIX 는 부모가 죽어도 자식을 죽이지 않으므로 채널 어댑터와 서비스가
  // 계속 살아 있고, 다음 기동이 같은 것을 또 띄운다(디스코드 봇 하나에 두 프로세스가 물려
  // 답이 두 번 나가는 자리다).
  const shutdown = (): void => {
    ticker?.stop();
    closeTlsDoor();
    retireAllResidents();
    retireAllScriptWorkers();
    stopAllRemotes();
    stopAll();
    clearDaemonMark();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
}

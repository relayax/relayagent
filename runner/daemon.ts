import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MIME, json, esc, readBody, streamFile } from "./http.ts";
import { spawn } from "node:child_process";
import { API_PORT, API_URL, RELAY_HOME, STORE_INDEX_URL, loadLedger, stageDir, sessionDir, workspacePath, artifactsDir, type Grant, type Ledger } from "./supply/ledger.ts";
import { credKey } from "./vault.ts";
import { loadManifest, landingAgentName, listScripts, agentScriptScope, shortName, outwardService, type Manifest, type ServiceDecl } from "./supply/manifest.ts";
import { runSession, retireResident, retireResidents, retireAllResidents, setEnvelopeTap, setTurnTap, isSessionBusy, recoverDanglingTurns, listSessionSlots, enableResidents, resumeRemotes, stopAllRemotes, localSessionIO } from "./runtime/harness.ts";
import { handleClientWire, tapSessionEvent, adoptSessionTurn, releaseSessionTurn, type ClientWireIO } from "./runtime/wire.ts";
import { runScript, runScriptFrom, scriptMeta, mcpCall, type HostBridge } from "./runtime/scripts.ts";
import { handleMcp, sweepPendingDeliveries } from "./runtime/tools.ts";
import { handleStore } from "./supply/store.ts";
import { packDir, deliverToStage, updateMarketIndex } from "./supply/pack.ts";
import type { McpIO } from "./runtime/mcp.ts";
import { installPkg, buildPkg, removePkg, resolveProvider, registryData, validateDir, harnessVerb, probeHarness, connectHarnessToken, launchHarnessLogin } from "./supply/install.ts";
import { openDraft, readDraft, writeDraft, diffDraft, commitDraft, validateDraft, publishDraft, discardDraft, listDrafts, buildDraft, draftPath } from "./supply/draft.ts";
import { listReleases, rollbackRelease } from "./supply/release.ts";
import { saveLedger } from "./supply/ledger.ts";
import { serveView, serveComponents, serveDraftView, serveDraftComponents } from "./runtime/view.ts";
import { shellNav, storeLatest, HOME_DOC, SHELL_JS } from "./runtime/shell.ts";
import { logLine } from "./supply/ledger.ts";
import { startServices, startChannels, startOneChannel, stopChannel, channelPid, runningServices, stopServices, stopAll, localIO, type RunnerIO } from "./runtime/services.ts";
import { verifyChannel } from "./supply/conform.ts";
import { Ticker } from "./runtime/triggers.ts";
import { loginStart, loginRead, loginInput, loginStop } from "./runtime/login.ts";
import { localAuthority, type Authority } from "./authority.ts";
import { serviceAuthHeader, startServiceOAuth, serviceOAuthStatus, verifyService } from "./runtime/oauth.ts";
import { a2aMissionMarker, a2aMissionSlot, a2aToolName, edgeToolName, parseA2aToolName, parseEdgeToolName, sanitizeToolSegment, SLOT_RE, PARAM_SLUGS_RE } from "./protocol.ts";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(RUNNER_DIR, "..", "relay.manifest.yaml");
// 서빙 정본은 번들 산출물이다 — 소스가 아니라 컷이 구운 dist 를 낸다(계획 §4-a)
const ASSETS_DIR = path.join(RUNNER_DIR, "..", "chat", "dist");

// 채널 로그에서 밖으로 나갈 문자열의 비밀을 지운다 — 토큰과 사용자 절대경로. fail-loud 하되
// 자격은 외부에 노출하지 않는다는 계약(schema surfaces.channels '실패' 절)의 집행이다
function scrubSecrets(s: string): string {
  return s
    .replace(/xox[a-z]-[A-Za-z0-9-]+/gi, "xox•-…")
    .replace(/xapp-[A-Za-z0-9-]+/gi, "xapp-…")
    .replace(/xoxe[.-][A-Za-z0-9.-]+/gi, "xoxe-…")
    .replace(/\/(Users|home)\/[^\s"']+/g, "…");
}

// 채널 상태의 '최근 오류' — channels.jsonl 을 뒤에서부터 훑어 이 채널의 가장 최근 사건을 본다.
// err(경고 제외) 또는 비정상 exit 이 최근이면 그 사연을, out/정상 exit 이 최근이면 건강(null)
function channelLastError(pkg: string, channel: string): string | null {
  const file = path.join(RELAY_HOME, "logs", "channels.jsonl");
  if (!fs.existsSync(file)) return null;
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    let j: { pkg?: string; channel?: string; err?: string; out?: string; exit?: number | null };
    try { j = JSON.parse(lines[i]); } catch { continue; }
    if (j.pkg !== pkg || j.channel !== channel) continue;
    if (j.err && !/ExperimentalWarning|trace-warnings/.test(j.err)) return scrubSecrets(j.err);
    if (j.exit != null && j.exit !== 0) return `프로세스 종료 (exit ${j.exit})`;
    if (j.out || j.exit === 0) return null; // 최근 사건이 건강하면 오류 없음
  }
  return null;
}


/** 데몬 자신의 오리진 — 상태를 바꾸는 요청의 Origin 화이트리스트(CSRF 판정). 데몬이 굽는
 *  화면(설치 동의·패키지 view·직결 채팅)은 전부 여기서 서빙되므로 이 집합이 곧 전부다 */
const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${API_PORT}`,
  `http://localhost:${API_PORT}`,
  `http://[::1]:${API_PORT}`,
]);

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
  door?: ApiDoor;
}

// 브리지를 그대로 두고 권위 구현만 갈아 끼운다 (조립 지점: relay.ts daemon · createApi)
export function makeHostBridge(getLedger: () => Ledger, getTicker: () => Ticker | null, authority: Authority): HostBridge {
  return {
    registry: () => registryData(getLedger()),
    install: (dir, opts) => {
      const r = installPkg(getLedger(), dir, { ring0: opts?.ring0, workspace: opts?.workspace, bindings: opts?.bindings });
      retireResidents(r.name); // 재설치라면 상주가 옛 코드·옛 번들로 떠 있다
      startServices(getLedger(), r.name, getLedger().packages[r.name].path, r.manifest);
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
    draftPublish: (name, opts) => {
      const l = getLedger();
      const r = publishDraft(l, name, opts);
      if (r.published && r.path && r.manifest) {
        // 서비스·상주는 옛 릴리스 코드로 떠 있다 — 새 스냅샷으로 갈아탄다. 실패해도 발행 자체는 유효
        retireResidents(name);
        stopServices(name);
        const notes = [...startServices(l, name, r.path, r.manifest), ...startChannels(l, name, r.path, r.manifest)];
        getTicker()?.emit(r.fresh ? "relay.package.installed" : "relay.package.published", { pkg: name, version: r.version });
        return { ...r, manifest: undefined, services: notes };
      }
      return { ...r, manifest: undefined };
    },
    draftDiscard: (name) => discardDraft(name),
    draftList: () => listDrafts(getLedger()),
    // 미리보기 굽기 — 작업 사본을 /draft/<이름>/ 좌표로 굽는다. 장부도 도는 판도 건드리지
    // 않는다: 산출은 작업 사본 안의 out/ 이고 그것은 스냅샷에서 빠지는 임시물이다
    draftBuild: (name) => buildDraft(name),
    // 작업 사본의 동사 한 번 — 발행 전에 돌려보는 자리. 짓자마자 확인할 길이 없으면
    // 저작자는 발행을 확인 수단으로 쓰게 된다(그 순간 발행이 결정이 아니게 된다)
    draftRun: (name, verb, input) =>
      // host 를 넘기지 않는다(null) — 시험 삼아 도는 코드에 ring-0 권능까지 주면
      // 미리보기가 설치·발행을 할 수 있는 자리가 된다. 맥락은 주되 권능은 주지 않는다
      runScriptFrom(getLedger(), name, draftPath(name), verb, input, { principal: authority.principal() }, null, authority),
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
    releaseRollback: (name, version) => {
      const l = getLedger();
      const r = rollbackRelease(l, name, version);
      retireResidents(name);
      stopServices(name);
      const notes = [...startServices(l, name, r.path, r.manifest), ...startChannels(l, name, r.path, r.manifest)];
      return { name: r.name, version: r.version, path: r.path, services: notes };
    },
    dispatch: async (providerRef, mission, payload, consumer) => {
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
  const server = http.createServer(async (req, res) => {
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
      // 기판이 낸다(runtime/shell.ts HOME_DOC). 종전에는 여기서 콘솔 패키지로 302 했다
      if (p === "/" || p === "") {
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        return void res.end(HOME_DOC);
      }
      if (p === "/registry" && req.method === "GET") return void json(res, 200, registryData(getLedger()));

      // 상주 한 방 — 셸 사이드바 상태점의 원천. 패키지마다 /pkg/<이름>/channels 를 물으면
      // 항목 수만큼 왕복이 나고, 그 응답의 대부분(자격 형태·최근 오류 로그 꼬리)은 점 하나에
      // 필요 없다. 자식 프로세스 맵의 키(<패키지>/<이름>)를 그대로 낸다 — 판정 없는 사실이라
      // 화면이 "이 패키지에 속한 키가 하나라도 있는가" 로 점을 켠다
      if (p === "/residency" && req.method === "GET") return void json(res, 200, { running: runningServices() });

      // 전역 셸 크롬(runtime/shell.ts) — 모든 view 문서에 주입되는 사이드바의 본체와 그 데이터.
      // 스크립트는 기판과 원자적으로 움직여야 한다(위젯 번들과 같은 사유): 캐시된 옛 크롬이
      // 새 nav 계약을 읽으면 조용히 갈라진다
      if (p === "/shell.js" && req.method === "GET") {
        res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
        return void res.end(SHELL_JS);
      }
      if (p === "/shell/nav" && req.method === "GET") return void json(res, 200, shellNav(getLedger(), runningServices(), await storeLatest()));

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
      // 번들은 릴리스 컷이 굽는다(chat/ chat-build.mjs → dist) — js 와 css 두 갈래다
      const asset = p.match(/^\/assets\/([a-z0-9-]+\.(?:js|css))$/);
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
        const r = host.install(String(b.path), { ring0: !!b.ring0, workspace: b.workspace ? String(b.workspace) : undefined, bindings: b.bindings && typeof b.bindings === "object" ? b.bindings : undefined });
        return void json(res, 200, r);
      }
      const buildRoute = p.match(/^\/pkg\/([^/]+)\/build$/);
      if (buildRoute && req.method === "POST") {
        return void json(res, 200, host.build(decodeURIComponent(buildRoute[1])));
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
          ? new Map(probeHarness(l, pkg).map((x) => [x.name, x]))
          : null;
        const variants = (m.harness?.variants ?? []).map((v) => ({
          name: v.name,
          provider: v.llm?.provider ?? null,
          icon: v.icon ?? null,
          llm_icon: v.llm?.icon ?? null,
          ...(probes?.get(v.name) ?? {}),
        }));
        return void json(res, 200, { active: rec.harness ?? variants[0]?.name ?? null, variants });
      }
      if (hs && req.method === "POST") {
        const b = await readBody(req);
        const { setHarness } = await import("./supply/install.ts");
        const pkg = decodeURIComponent(hs[1]);
        retireResidents(pkg); // 상주는 이전 하네스로 떠 있다
        return void json(res, 200, setHarness(getLedger(), pkg, String(b.name ?? "")));
      }

      // token 자격형의 웹 연결 경로 — vault 에 provider 소속으로 앉는다
      const hc = p.match(/^\/pkg\/([^/]+)\/harness\/connect$/);
      if (hc && req.method === "POST") {
        const b = await readBody(req);
        const setup = connectHarnessToken(getLedger(), decodeURIComponent(hc[1]), String(b.token ?? ""));
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
        const m = loadManifest(rec.path);
        const channels = [];
        for (const c of m.surfaces?.channels ?? []) {
          const pid = channelPid(pkg, c.name);
          // credential 은 **형태 선언**이라 그대로 나간다 — 값은 vault 에 있고 여기 실리지 않는다.
          // 화면이 이 선언으로 입력 칸을 그린다(없으면 원시 붙여넣기로 물러난다).
          channels.push({ name: c.name, icon: c.icon ?? null, running: pid != null, pid, hasCred: (await authority.credential(credKey(pkg, c.name))) != null, lastError: channelLastError(pkg, c.name), credential: c.credential ?? null });
        }
        return void json(res, 200, { channels });
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
          return void json(res, 200, verifyChannel(rec.path, c, await authority.credential(credKey(pkg, channel))));
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
        const m = loadManifest(rec.path);
        const services = [];
        for (const sv of m.services ?? []) {
          // 자격 축이 있는 것은 밖으로 나가는 두 형뿐이다 — source(몸)·dir(폴더)에는 auth 자리가 없다
          const out = outwardService(sv);
          if (!out) continue;
          const a = out.auth;
          services.push({
            name: sv.name,
            url: out.base,
            // 문의 말 — MCP 문(url)이냐 REST 베이스(api)냐. 도구 열이 빈 이유를 화면이 말할 수 있어야 한다
            form: "url" in sv ? "url" : "api",
            kind: a?.kind ?? "none",
            // 선언 그대로 — 화면이 안내와 입력 칸을 그린다. 값은 실리지 않는다
            help: a?.help ?? null,
            client: a?.client ?? null,
            verifiable: a?.verify?.url != null,
            tools: "tools" in sv ? sv.tools ?? [] : [],
            hasCred: (await authority.credential(credKey(pkg, sv.name))) != null,
            oauth: a?.kind === "oauth" ? serviceOAuthStatus(pkg, sv.name) : null,
          });
        }
        return void json(res, 200, { services, canDisconnect: typeof authority.deleteCredential === "function" });
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

        if (sst && req.method === "GET") return void json(res, 200, serviceOAuthStatus(pkg, name));
        if (!sop || req.method !== "POST") return void json(res, 405, { error: "POST 만" });

        if (sop[3] === "connect") {
          if (auth?.kind !== "token") return void json(res, 400, { error: `token 자격형이 아닙니다(${auth?.kind ?? "none"}) — oauth 는 인가 흐름으로` });
          const b = await readBody(req);
          const token = String(b.token ?? "").trim();
          if (!token) return void json(res, 400, { error: "빈 자격" });
          await authority.setCredential(credKey(pkg, name), token); // 저장만 — 유효 판정은 verify 소관
          return void json(res, 200, { ok: true });
        }
        if (sop[3] === "verify") {
          return void json(res, 200, await verifyService(authority, pkg, name, auth));
        }
        if (sop[3] === "disconnect") {
          if (typeof authority.deleteCredential !== "function") {
            return void json(res, 501, { error: "이 기판의 권위는 자격 폐기를 구현하지 않습니다" });
          }
          await authority.deleteCredential(credKey(pkg, name));
          return void json(res, 200, { ok: true });
        }
        // oauth — 흐름을 열고 즉시 돌아온다. 브라우저는 데몬이 연다(사람과 같은 기기)
        if (auth?.kind !== "oauth") return void json(res, 400, { error: `oauth 자격형이 아닙니다(${auth?.kind ?? "none"}) — token 은 connect 로` });
        const b = await readBody(req);
        try {
          const run = startServiceOAuth(authority, pkg, name, out.base, auth, { clientId: b.client_id ? String(b.client_id) : undefined });
          return void json(res, 200, { ...run, running: !run.done });
        } catch (e) {
          return void json(res, 409, { error: e instanceof Error ? e.message : String(e) });
        }
      }

      // 대화형 로그인 발화. 인증 자체는 터미널(TTY)이 소유하고 기판은 그 창을 열어 줄 뿐이다
      // 로그인 두 갈래: headless(pty 중계 — 브라우저 안에서 끝난다)와 terminal(창을 여는 폴백)
      const hl = p.match(/^\/pkg\/([^/]+)\/harness\/login$/);
      if (hl && req.method === "POST") {
        const b = await readBody(req);
        const pkg = decodeURIComponent(hl[1]);
        if (b.mode === "terminal") {
          return void json(res, 200, { mode: "terminal", ...launchHarnessLogin(getLedger(), pkg, { switch: !!b.switch }) });
        }
        return void json(res, 200, { mode: "headless", ...loginStart(getLedger(), pkg, authority, { switch: !!b.switch }) });
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
        return void json(res, 200, harnessVerb(getLedger(), decodeURIComponent(hv[1]), "setup"));
      }

      // 데이터 폴더 열기 — 패키지의 workspace 를 OS 파일 탐색기로 연다.
      // 데이터의 거처가 폴더라는 약속을 화면에서 한 클릭으로 증명하는 문이다
      const wsOpen = p.match(/^\/pkg\/([^/]+)\/workspace\/open$/);
      if (wsOpen && req.method === "POST") {
        const name = decodeURIComponent(wsOpen[1]);
        if (!getLedger().packages[name]) return void json(res, 404, { error: `미설치 패키지: ${name}` });
        const dir = workspacePath(getLedger(), name);
        fs.mkdirSync(dir, { recursive: true });
        const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
        spawn(opener, [dir], { detached: true, stdio: "ignore" }).unref();
        return void json(res, 200, { ok: true, dir });
      }

      const script = p.match(/^\/pkg\/([^/]+)\/script\/([a-z0-9-]+)$/);
      if (script && req.method === "POST") {
        const b = await readBody(req);
        const result = await runScript(getLedger(), decodeURIComponent(script[1]), script[2], b.input ?? b, { principal: authority.principal() }, host, authority);
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
  });
  // listen 좌표. false 면 소켓의 주인은 임베더다 — 반환된 서버를 자기가 연다(자기 문 뒤에서).
  // 여기서 열지 않는 것이 요점이다: 우리가 loopback 을 먼저 열어 두면 임베더가 원치 않는
  // 리스너가 하나 더 서고, 그 문에는 인증이 없다
  if (opts.door?.listen !== false) {
    server.listen(opts.door?.listen?.port ?? API_PORT, opts.door?.listen?.host ?? "127.0.0.1");
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
  // 데몬의 권위는 항상 신선한 장부를 본다 — CLI 1회분(위 authority)과 달리 요청마다 재적재
  const daemonAuthority = localAuthority(() => loadLedger());
  const host = makeHostBridge(() => loadLedger(), () => ticker, daemonAuthority);
  ticker = new Ticker(() => loadLedger(), host, daemonAuthority);
  createApi(() => loadLedger(), host, ticker, daemonAuthority);
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
  for (const [name, rec] of Object.entries(l.packages)) {
    try {
      const m = loadManifest(rec.path);
      const notes = [...startServices(l, name, rec.path, m), ...startChannels(l, name, rec.path, m)];
      for (const n of notes) console.log(n);
    } catch (e) {
      console.error(`${name}: 서비스 기동 실패 - ${e}`);
    }
  }
  // 원격 제어 상주 — 장부에 켜짐이 남은 패키지를 잇는다(서비스와 같은 자리, 문을 막지 않는다)
  void resumeRemotes(daemonAuthority, localSessionIO(() => loadLedger()))
    .then((notes) => { for (const n of notes) console.log(n); })
    .catch((e) => console.error(`원격 제어 상주 재개 실패 - ${e}`));
  console.log(`relay daemon: ${API_URL} (principal: ${daemonAuthority.principal()})`);
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
    retireAllResidents();
    stopAllRemotes();
    stopAll();
    fs.rmSync(pidFile, { force: true });
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, shutdown);
}

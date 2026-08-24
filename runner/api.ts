import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { API_PORT, RELAY_HOME, STORE_INDEX_URL, loadLedger, stageDir, sessionDir, workspacePath, artifactsDir, type Grant, type Ledger } from "./state.ts";
import { fetchStoreIndex, downloadArtifact, redeemArtifact, redeemWithTicket, cacheHit, RedeemError } from "./registry.ts";
import { credKey } from "./vault.ts";
import { loadManifest, landingAgentName, listScripts, agentScriptScope, shortName, type Manifest, type ServiceDecl } from "./manifest.ts";
import { runSession, retireResident, retireResidents, setEnvelopeTap, isSessionBusy } from "./session.ts";
import { handleClientWire, tapSessionEvent } from "./client-wire.ts";
import { runScript, scriptMeta, mcpCall, type HostBridge } from "./scripts.ts";
import { mcpDispatch, type McpIO, type McpToolInfo } from "./mcp.ts";
import { installPkg, buildPkg, removePkg, resolveProvider, registryData, validateDir, harnessVerb, probeHarness, connectHarnessToken, launchHarnessLogin, prepareArtifact, activatePrepared, type Prepared } from "./installer.ts";
import { readMarketIndex, packDir, updateMarketIndex } from "./pack.ts";
import { openDraft, readDraft, writeDraft, diffDraft, commitDraft, validateDraft, publishDraft, discardDraft, listDrafts, listReleases, rollbackRelease } from "./draft.ts";
import { saveLedger } from "./state.ts";
import { assetsAtDaemonRoot } from "./build.ts";
import { logLine } from "./state.ts";
import { startServices, startChannels, startOneChannel, stopChannel, channelPid, stopServices, localIO } from "./run.ts";
import { verifyChannel } from "./conform.ts";
import { Ticker } from "./tick.ts";
import { loginStart, loginRead, loginInput, loginStop } from "./login.ts";
import { localAuthority, type Authority } from "./authority.ts";
import { serviceAuthHeader } from "./oauth.ts";
import { a2aMissionMarker, a2aToolName, edgeToolName, parseA2aToolName, parseEdgeToolName, sanitizeToolSegment, SLOT_RE, PARAM_SLUGS_RE } from "./protocol.ts";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(RUNNER_DIR, "..", "relay.manifest.yaml");
// 서빙 정본은 번들 산출물이다 — 소스가 아니라 컷이 구운 dist 를 낸다(계획 §4-a)
const ASSETS_DIR = path.join(RUNNER_DIR, "..", "lib", "relayjs", "dist");

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

// 준비된 설치의 대기석. 고지서를 본 화면만 activate 에 닿도록 짧은 토큰으로 잇는다.
// 릴리스 전개는 이미 디스크에 있으므로 만료되어도 잃는 것은 없다 — 다시 prepare 하면 재사용된다
const prepared = new Map<string, { p: Prepared; at: number }>();
const PREPARE_TTL = 10 * 60_000;
/** 손으로 가져오는 봉투의 상한 — 원격 다운로드와 같은 선 */
const MAX_IMPORT = 200 * 1024 * 1024;

/** 데몬 자신의 오리진 — 상태를 바꾸는 요청의 Origin 화이트리스트(CSRF 판정). 데몬이 굽는
 *  화면(설치 동의·패키지 view·직결 채팅)은 전부 여기서 서빙되므로 이 집합이 곧 전부다 */
const SELF_ORIGINS = new Set([
  `http://127.0.0.1:${API_PORT}`,
  `http://localhost:${API_PORT}`,
  `http://[::1]:${API_PORT}`,
]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
};

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

// ── 스토어에서 건너온 설치의 화면 ──────────────────────────────────────────────
// 콘솔(Next 앱)이 아니라 데몬이 직접 굽는다. 이유는 둘이다: 굽는 단계 없이 고칠 수 있고,
// 걷어낸 마켓 표면을 되살리지 않으면서 필요한 문 하나만 세울 수 있다.

function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SHELL = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Relay 설치</title><style>
:root{--bg:#f5f6f7;--card:#fff;--ink:#16181b;--soft:#5c6570;--faint:#98a1aa;--line:#e6e9ec;--accent:#0f766e;--accent-strong:#115e59;--accent-soft:rgba(13,148,136,.1)}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.65 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif;-webkit-font-smoothing:antialiased;word-break:keep-all}
.card{max-width:440px;margin:8vh auto;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:28px 30px 24px}
h1{margin:0 0 4px;font-size:19px;font-weight:800;letter-spacing:-.02em}
.sub{margin:0 0 18px;font:12px ui-monospace,Menlo,monospace;color:var(--faint)}
p{color:var(--soft);font-size:13px;margin:0 0 12px}
.seal{display:flex;gap:8px;align-items:center;background:var(--accent-soft);color:var(--accent-strong);border-radius:9px;padding:9px 12px;font-size:12px;margin-bottom:16px}
.seal code{font:10.5px ui-monospace,Menlo,monospace;overflow-wrap:anywhere}
h2{font-size:12.5px;font-weight:700;margin:0 0 8px}
dl{border:1px solid var(--line);border-radius:10px;padding:2px 14px;margin:0 0 14px}
dl>div{display:flex;gap:12px;padding:9px 0;border-bottom:1px solid var(--line);font-size:12.5px}
dl>div:last-child{border-bottom:0}
dt{flex:none;width:42px;color:var(--faint);font-weight:700;font-size:11px;padding-top:1px}
dd{margin:0;color:var(--soft);overflow-wrap:anywhere}
dd code{font:11.5px ui-monospace,Menlo,monospace}
.nots{font-size:12.5px;color:var(--soft);background:#eef0f2;border-radius:9px;padding:10px 12px;margin-bottom:18px}
.row{display:flex;gap:9px}
button,.btn{flex:1;text-align:center;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:10px;padding:11px;font:600 13.5px inherit;cursor:pointer;text-decoration:none;display:block}
button.go{background:var(--accent);border-color:var(--accent);color:#fff}
.note{font-size:11.5px;color:var(--faint);text-align:center;margin:12px 0 0}
.warn{background:#fdf3e7;color:#9a5b06;border-radius:9px;padding:10px 12px;font-size:12.5px;margin-bottom:12px}
.drop{border:1.5px dashed var(--line);border-radius:12px;padding:34px 20px;text-align:center;color:var(--soft);font-size:13px;cursor:pointer}
.drop.on{border-color:var(--accent);background:var(--accent-soft)}
.drop b{display:block;font-size:14px;color:var(--ink);margin-bottom:4px}
</style></head><body>`;

/** 가져오기 — 손에 든 봉투를 여는 문 */
function importPage(res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`${SHELL}<div class="card">
<h1>불러오기</h1>
<p>받은 에이전트 파일(<code>.relay</code>)을 놓으면 무엇을 요구하는지 먼저 보여 드립니다. 설치는 동의한 뒤에 시작합니다.</p>
<div class="drop" id="d"><b>여기에 파일을 놓거나 클릭</b>.relay 파일</div>
<input type="file" id="f" accept=".relay" style="display:none">
<p class="note" id="st"></p>
<script>
var d=document.getElementById("d"),f=document.getElementById("f"),st=document.getElementById("st");
function send(file){
  if(!file){return}
  st.textContent="여는 중… "+file.name;
  fetch("/store/import",{method:"POST",body:file}).then(function(r){return r.json()}).then(function(j){
    if(j.id){location.href="/store/install/consent?id="+encodeURIComponent(j.id)}
    else{st.textContent=j.error||"열지 못했습니다"}
  }).catch(function(e){st.textContent=String(e)});
}
d.onclick=function(){f.click()};
f.onchange=function(){send(f.files[0])};
d.ondragover=function(e){e.preventDefault();d.className="drop on"};
d.ondragleave=function(){d.className="drop"};
d.ondrop=function(e){e.preventDefault();d.className="drop";send(e.dataTransfer.files[0])};
</script>
</div></body></html>`);
}

/** 한 줄짜리 결과·오류 화면 */
function installPage(res: http.ServerResponse, code: number, title: string, detail: string, ok = false): void {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `${SHELL}<div class="card"><h1>${esc(title)}</h1><p>${esc(detail)}</p>` +
      (ok ? `<a class="btn" href="/pkg/system/view/">콘솔 열기</a>` : "") +
      `</div></body></html>`,
  );
}

/**
 * 동의 관문 — 여기까지는 아무것도 실행되지 않았다.
 * sideloaded: 스토어를 거치지 않고 손으로 받은 봉투. 봉인은 계산했지만 대조할 정본이 없어
 * "이 값이 맞는가"를 확인해 줄 곳이 없다. 그 차이를 화면이 숨기지 않는다.
 */
function consentPage(res: http.ServerResponse, prep: Prepared, sideloaded = false): void {
  const d = prep.disclosure;
  const rows: string[] = [];
  for (const f of d.folders) rows.push(`<div><dt>폴더</dt><dd><code>${esc(f.path)}</code> 를 만들고 읽고 씁니다</dd></div>`);
  for (const l of d.llm) rows.push(`<div><dt>LLM</dt><dd>${esc(l.provider)} 계정으로 돕니다 (${esc(l.auth)})</dd></div>`);
  for (const n of d.network) rows.push(`<div><dt>외부</dt><dd><code>${esc(n.url)}</code> 로 나갑니다</dd></div>`);
  for (const w of d.wakeups) rows.push(`<div><dt>자동</dt><dd>${esc(w.when)} 에 스스로 깨어납니다</dd></div>`);
  if (d.host.length) rows.push(`<div><dt>호스트</dt><dd>${esc(d.host.join(" · "))}</dd></div>`);
  if (d.borrows.length) rows.push(`<div><dt>빌림</dt><dd>${esc(d.borrows.join(" · "))}</dd></div>`);
  if (d.spawns.length) rows.push(`<div><dt>프로세스</dt><dd>${esc(d.spawns.join(" · "))}</dd></div>`);
  if (d.connector) rows.push(`<div><dt>자격</dt><dd>커넥터 계약 (${esc(d.connector)}) — 값은 vault, 연결은 설치 후</dd></div>`);
  if (d.hostMethods.length) rows.push(`<div><dt>기판</dt><dd>host 브리지 <code>${esc(d.hostMethods.join(", "))}</code></dd></div>`);
  if (d.denied.length) rows.push(`<div><dt>담장</dt><dd>${esc(d.denied.join(", "))} 에는 닿지 않습니다</dd></div>`);

  const nots: string[] = [];
  if (!d.network.length) nots.push("인터넷으로 나가지 않고");
  if (!d.wakeups.length) nots.push("스스로 깨어나지 않고");
  if (!d.borrows.length) nots.push("다른 패키지의 능력을 빌리지 않습니다");

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `${SHELL}<div class="card">
<h1>${esc(prep.manifest.display_name ?? prep.name)} 설치</h1>
<p class="sub">${esc(prep.ref)} · ${esc(prep.version)} · ${(prep.size / 1024).toFixed(0)}KB</p>
${sideloaded && !prep.signed
      ? `<div class="warn">스토어를 거치지 않은 무서명 봉투입니다 — 보낸 사람을 믿을 수 있을 때만 설치하세요</div>
<div class="seal">봉인값 · <code>${esc(prep.digest)}</code></div>`
      : `<div class="seal">${prep.signed ? "서명·봉인 확인됨" : "봉인 확인됨"} · <code>${esc(prep.digest)}</code></div>`}
<h2>이 에이전트가 요구하는 것</h2>
<dl>${rows.join("") || `<div><dt>—</dt><dd>따로 요구하는 것이 없습니다</dd></div>`}</dl>
${nots.length ? `<div class="nots">이 패키지는 ${esc(nots.join(", "))}.</div>` : ""}
<form method="post" action="/store/install/confirm" class="row">
  <input type="hidden" name="id" value="${esc(prep.id)}">
  <a class="btn" href="/pkg/system/view/">취소</a>
  <button class="go" type="submit">동의하고 설치</button>
</form>
<p class="note">동의하기 전까지 이 패키지의 코드는 한 줄도 실행되지 않았습니다</p>
</div></body></html>`,
  );
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  // 설치 동의는 자바스크립트 없는 폼에서 온다 — 그 몸통은 JSON 이 아니다
  if (/^application\/x-www-form-urlencoded/.test(String(req.headers["content-type"] ?? ""))) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
}

// 권위 이음새를 인자로 받는다 — 결재(grant)·장부 조회가 이 문을 지나야 조직 임베드가
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
    // 굽기 — 설치본을 봉투 하나로 만들어 선반에 앉힌다.
    // 파일을 사람 손에 쥐여 주지 않는 것이 요점이다: 봉인(sha256)과 요구 범위가 함께
    // 계산된 상태로 선반에 남고, 등재 화면이 그 선반을 읽는다. 손으로 옮기는 순간
    // "빌더가 준 것"과 "스토어가 받은 것"이 어긋날 자리가 생긴다.
    pack: (name) => {
      const rec = getLedger().packages[name];
      if (!rec) throw new Error(`설치되지 않은 패키지입니다: ${name}`);
      const r = packDir(rec.path);
      const shelf = updateMarketIndex(rec.path, r);
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
      const slot = `mission-${mission}`;
      // 위임 대화도 세션 목록의 시민이다 — 이름이 없으면 마커 원문이 라벨 행세를 해서 흉하다
      const labelFile = path.join(sessionDir(provider, slot), "label");
      if (!fs.existsSync(labelFile)) fs.writeFileSync(labelFile, `⇄ ${consumer ?? "외부"} → ${mission}`);
      const r = await runSession({ ledger, pkg: provider, authority, prompt, slot });
      return r.reply;
    },
  };
}

// 세션이 부를 수 있는 동사의 유일한 진리 — 목록(tools/list)과 집행(tools/call)이 같은 집합을
// 봐야 한다. 목록에만 스코프를 걸면 이름을 아는 세션이 아무 동사나 부른다 (선언 = 캡 원칙 위반)
function sessionScriptSet(ledger: Ledger, pkg: string, agent: string): Set<string> {
  const rec = ledger.packages[pkg];
  const m = loadManifest(rec.path);
  const agentsInPlay = [agent, ...((m.agents ?? []).find((a) => a.name === agent)?.dispatch ?? [])];
  const allScripts = listScripts(rec.path, m);
  const inScope = new Set<string>();
  for (const a of agentsInPlay) {
    const scope = agentScriptScope(m, a);
    if (!scope) continue;
    for (const s of allScripts) if (scope(s)) inScope.add(s);
  }
  return inScope;
}

// 서술·입력 형의 정본은 동사 자신이다 — 기판이 이름으로 문장을 지어내면 tools/list 가 세션에게
// 아무것도 알려주지 못한다(이름을 두 번 읽는 셈). meta 를 수출한 동사는 그 서술과 JSON Schema 를
// 싣고, 수출하지 않은 동사는 현행 그대로 자동 서술 + 개방 스키마(mcp.ts 폴백)로 선다.
async function sessionTools(ledger: Ledger, authority: Authority, pkg: string, agent: string): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  for (const s of sessionScriptSet(ledger, pkg, agent)) {
    const meta = await scriptMeta(ledger, pkg, s);
    tools.push({ name: s, description: meta?.description ?? `${pkg} 패키지의 ${s} 동사`, inputSchema: meta?.input });
  }

  // 서브에이전트 위임 — 기판 소유다(2026-08-20 단일화). 종전에는 어댑터가 하네스 네이티브
  // (claude --agents)로 번역해 하네스마다 의미가 갈렸다: claude 는 부모 세션 안 Task, 나머지는
  // 문서 절 강등(실행 자체가 안 됨). 이제 전 하네스가 같은 문으로 위임하고, 서브에이전트 턴은
  // 별도 세션(목록 시민)으로 돈다 — org 기판(turn.service dispatch)과 같은 의미론.
  {
    const m = loadManifest(ledger.packages[pkg].path);
    const subs = (m.agents ?? []).find((a) => a.name === agent)?.dispatch ?? [];
    if (subs.length) {
      // 소개는 페르소나 첫 줄 — 매니페스트에 별도 description 축이 없고, 첫 줄이 그 관례다
      const rows = subs.map((n) => {
        const d = (m.agents ?? []).find((a) => a.name === n);
        let first = "";
        try {
          if (d) first = fs.readFileSync(path.join(ledger.packages[pkg].path, d.persona), "utf8").split("\n").find((l) => l.trim()) ?? "";
        } catch { /* 페르소나 불달 — 이름만 */ }
        return `${n}${first ? ` — ${first.trim().slice(0, 80)}` : ""}`;
      });
      tools.push({
        name: "agent_dispatch",
        description: `서브에이전트에게 위임한다. 별도 세션에서 돌고, 오래 걸리면 도구가 먼저 돌아오며 완료는 이 대화로 📬 배달된다. 같은 (agent, target) 재위임은 이전 위임 대화에 이어서 돈다 — 중단된 작업의 계속·후속 수정은 같은 target 으로 보내라. 위임 가능: ${rows.join(" · ")}. arguments: { agent: string, prompt: string, target?: string, fresh?: boolean }`,
        inputSchema: {
          type: "object",
          required: ["agent", "prompt"],
          properties: {
            agent: { type: "string", enum: subs },
            prompt: { type: "string", description: "서브에이전트에게 전달할 지시 — 맥락은 공유되지 않으므로 필요한 배경을 담아라" },
            target: { type: "string", description: "작업 대상 slug(다루는 패키지·draft 이름 등, 쉼표로 여럿 — [a-z0-9-]. 그 밖의 임의 키도 통짜 대상 하나로 보존된다). 알면 반드시 실어라 — 세션 목록과 대화 칩에 떠서 사용자가 무슨 작업인지 구별하고, 같은 (agent, target) 재위임이 이전 위임 대화에 이어지는 열쇠다" },
            fresh: { type: "boolean", description: "true 면 그 target 의 이전 위임 대화를 버리고 새로 시작한다 — 이전 세션이 오염됐거나 이어받으면 안 되는 새 작업일 때만" },
          },
        },
      });
    }
  }

  // 인가 장부 조회도 권위 이음새를 지난다 — 목록(tools/list)과 집행(grantForTool)이 같은 문을 본다
  for (const g of (await authority.grants()).filter((g) => g.consumer === pkg)) {
    if (g.mission) {
      tools.push({
        name: a2aToolName(g.provider, g.mission),
        description: `a2a 위임: ${g.provider} 의 ${g.mission} 미션. arguments: { payload: string }`,
      });
    }
    for (const t of g.tools ?? []) {
      tools.push({ name: edgeToolName(g.provider, t), description: `edge 소비: ${g.provider} 의 ${t}` });
    }
  }
  return tools;
}

async function callEdgeTool(ledger: Ledger, authority: Authority, consumer: string, provider: string, tool: string, args: unknown, host: HostBridge, agent?: string): Promise<unknown> {
  // 인가 판정은 권위 이음새를 지난다 — "누구로서(consumer), 무엇을(provider/tool), 어떤 자격으로"
  const grant = await authority.grantForTool(consumer, provider, tool);
  if (!grant) throw new Error(`E_NO_GRANT: ${consumer} -> ${provider}/${tool}`);
  const rec = ledger.packages[provider];
  const m = loadManifest(rec.path);
  const urlSvc = (m.services ?? []).find((s): s is Extract<ServiceDecl, { url: string }> => "url" in s && s.url != null && (s.tools ?? []).includes(tool));
  // 소비의 두 축은 여기서 갈라진다 — 자격은 provider, 신원은 원 호출자.
  // 자격: provider 의 것으로 나간다(몸과의 연결은 provider 가 소유한다 — ctx.service 와 같은
  //   해석: token·oauth 회전). 무자격 호출이던 구멍의 답.
  // 신원: 소비를 발화한 쪽의 것으로 나간다(principal = 그 사람, agent = 그 세션의 얼굴).
  //   신원까지 provider 로 바꾸면 principal 로 RLS 를 거는 몸이 소비자 사용자를 못 보고
  //   provider 하나로 뭉뚱그린다 — 인가가 consumer→provider 로 기록되는 것과 같은 결이다.
  //   agent 이름은 consumer 패키지의 어휘다: provider 는 이것을 자기 에이전트로 읽으면 안 된다.
  //   ctx.service 와 같은 규칙을 쓴다 — 같은 질문에 두 경로가 다른 답을 내면 안 된다.
  const identity = { principal: authority.principal(), agent };
  if (urlSvc) return await mcpCall(urlSvc.url, tool, args, await serviceAuthHeader(authority, provider, urlSvc.name, urlSvc.auth), identity);
  if (listScripts(rec.path, m).includes(tool)) return await runScript(ledger, provider, tool, args, identity, host, authority);
  throw new Error(`provider 에 해당 동사 없음: ${provider}/${tool}`);
}

// 1인 기판의 문 이음새 구현(mcp.ts McpIO) — 프로토콜 합성은 mcpDispatch 한 벌이고, 여기는
// "무엇이 도구이고 누가 실행하는가"(세션 스코프 게이트·a2a 위임·edge 소비·runScript)만 답한다.
// handleMcp 의 io 기본값이 이 구현이라 1인 기판은 무변이고, 임베더는 같은 형의 자기 구현
// (자기 도구 레지스트리·자기 권위 판정)을 꽂는다 — run.ts RunnerIO 와 같은 결.
function localMcpIO(ledger: Ledger, authority: Authority, host: HostBridge, pkg: string, agent: string, callerSlot?: string | null): McpIO {
  return {
    tools: () => sessionTools(ledger, authority, pkg, agent),
    call: async (name, args) => {
      const a2a = parseA2aToolName(name);
      const edge = parseEdgeToolName(name);
      if (a2a) {
        const m = loadManifest(ledger.packages[a2a.provider].path);
        const mission = (m.missions ?? []).find((x) => sanitizeToolSegment(x.name) === a2a.rest)?.name ?? a2a.rest;
        const grant = await authority.grantForMission(pkg, a2a.provider, mission);
        if (!grant) throw new Error(`E_NO_GRANT: ${pkg} -> ${a2a.provider}/${mission}`);
        return await host.dispatch(a2a.provider, mission, String(args.payload ?? JSON.stringify(args)), pkg);
      }
      if (edge) return await callEdgeTool(ledger, authority, pkg, edge.provider, edge.tool, args, host, agent);
      if (name === "agent_dispatch") {
        const m = loadManifest(ledger.packages[pkg].path);
        const subs = (m.agents ?? []).find((a) => a.name === agent)?.dispatch ?? [];
        const sub = String(args.agent ?? "");
        // 게이트는 선언이다 — dispatch 목록 밖 이름은 도구를 아는 세션이라도 못 부른다(선언 = 캡)
        if (!subs.includes(sub)) throw new Error(`E_SCOPE: ${agent} 의 dispatch 선언 밖 서브에이전트: ${sub} (선언: ${subs.join(", ") || "없음"})`);
        const instruction = String(args.prompt ?? "").trim();
        if (!instruction) throw new Error("빈 지시 — prompt 를 담아라");
        // 작업 대상(org 의 param 축) — "agent-builder 인데 무엇의 빌더인가" 를 목록·칩이 답하게
        // 한다. slug 목록(PARAM_SLUGS_RE — routematch SLUG_LIST 쌍둥이)만 소문자 정규화·목록
        // 해석하고, 그 밖의 임의 스레드 키는 원문 그대로 통짜 대상 하나다(§5.3-21 — org
        // "param = 임의 스레드 키" 계약 보존. 구 구현의 "" 무음 강등은 연속성 키를 조용히
        // 버리는 silent degradation 이라 은퇴, 2026-08-21).
        const target = String(args.target ?? "").trim();
        const param = PARAM_SLUGS_RE.test(target) ? target.toLowerCase() : target;
        // 슬롯 키 = (서브에이전트, 작업 대상). 같은 대상 재위임은 같은 슬롯에 앉아 이전 위임
        // 대화를 잇는다 — 봉투가 슬롯의 네이티브 포인터로 스스로 resume 하고, 포인터가 만료면
        // 새 대화로 강등하는 복구 사다리도 봉투 소유다. 위임마다 새 슬롯을 팠던 종전 구현은
        // "이어서" 위임조차 맥락 재파생을 처음부터 다시 지불했다(실측 2026-08-20: 같은 저작
        // 위임 3회 = 501 콜, 위임 지출의 절반이 중복). 같은 슬롯의 턴 직렬화(한 슬롯에 턴
        // 하나)는 이제 막이 아니라 담장이다 — 같은 draft 에 병렬 위임이 붙어 두 설계가 섞여
        // 발행된 실사고(2026-08-20)를 입구에서 끊는다. 대상이 다르면 병렬은 종전 그대로다.
        // 대상 미상이면 이을 열쇠가 없다 — 1회용 난수 슬롯으로 강등한다.
        // slug 목록의 쉼표는 SLOT_RE 밖이라 . 로 접는다 — `.` 는 slug 축([a-z0-9-])에 없으므로
        // 목록 "a,b" 와 임의 키 "a.b" 는 충돌하지 않는다(임의 키는 아래 해시 슬롯). 임의 키는
        // SLOT_RE 에 실을 수 없어 지문(sha256 8자리)으로 슬롯을 파고 원문은 param 메타에 든다.
        // 대화의 에이전트 정체성은 슬롯 이름이 아니라 기판 메타(agent 파일)다 — 위젯 스레드
        // 문법(`:` `~`)을 이름에 실으려다 새니타이즈로 뭉개진 첫 구현의 계보(실사용 보고
        // 2026-08-20) 그대로.
        const slot = param
          ? (PARAM_SLUGS_RE.test(param)
              ? `sub-${sub}-${param.replace(/,/g, ".")}`
              : `sub-${sub}-k${crypto.createHash("sha256").update(param).digest("hex").slice(0, 8)}`
            ).slice(0, 64)
          : `sub-${sub}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 64);
        // 진행 중인 같은 대상 위임 위에 얹지 않는다 — runSession 의 직렬화가 튕기기 전에
        // 위임 어휘로 정직하게 알린다 (재시도 루프 방지: 완료는 어차피 📬 로 온다)
        if (isSessionBusy(pkg, slot)) {
          throw new Error(`이미 진행 중인 위임: ↳ ${sub}${param ? " · " + param : ""} — 완료가 이 대화로 📬 배달된다. 기다렸다가 필요하면 그때 재위임하라.`);
        }
        const sdir = sessionDir(pkg, slot);
        // fresh — 이어받을 대화가 오염됐을 때의 탈출구. 대화 reset(§5.3-23)과 같은 회전이다:
        // 이력은 두고 번들만 비워 네이티브 포인터를 끊고, 낡은 대화를 메모리에 문 상주도
        // 함께 은퇴시킨다. 다음 턴의 조립이 빈 자리를 다시 채운다
        if ((args.fresh === true || args.fresh === "true") && param) {
          retireResident(pkg, slot);
          fs.rmSync(path.join(sdir, "bundle"), { recursive: true, force: true });
        }
        if (!fs.existsSync(path.join(sdir, "label"))) {
          fs.writeFileSync(path.join(sdir, "label"), `↳ ${sub}${param ? " · " + param : ""}`);
        }
        // 이 대화의 정체성 — runSession 의 agent 폴백과 세션 목록 행(§5.3-21 additive)이 읽는다
        fs.writeFileSync(path.join(sdir, "agent"), sub);
        if (param) fs.writeFileSync(path.join(sdir, "param"), param);
        // 마커는 화면 계약이다 — 위젯 SubAgentDispatchCard(SUBAGENT_RE)가 이 머리를 위임
        // 카드로 렌더한다(org turn.service dispatch 와 같은 형식)
        const prompt = `[서브에이전트 · ${pkg} · ${sub}]\n${instruction}`;
        const run = runSession({ ledger, pkg, agent: sub, authority, prompt, slot });
        // 시한은 도구 자신이 갖는다 — MCP 층(MCP_TOOL_TIMEOUT 240s)이 먼저 자르면 "timed out"
        // 원문만 남고 완료가 영영 배달되지 않는다(실사고 2026-08-20: 240s 초과 위임). org 와
        // 같은 골격: 도구는 180s 에 정직하게 물러나고, 위임은 계속 돌며, 완료는 발신 대화에
        // 📬 프리픽스 턴으로 배달된다(위젯 SYSTEM_PROMPT_PREFIXES · watchServerTurns 계약).
        const timeoutS = Number(process.env.RELAY_DISPATCH_TIMEOUT_S) > 0 ? Number(process.env.RELAY_DISPATCH_TIMEOUT_S) : 180;
        const winner = await Promise.race([
          run.then((r) => ({ reply: r.reply })),
          new Promise<null>((resolve) => { const t = setTimeout(() => resolve(null), timeoutS * 1000); (t as { unref?: () => void }).unref?.(); }),
        ]);
        if (winner) return winner.reply;
        const deliver = async (head: string, bodyText: string) => {
          if (!callerSlot) return; // 발신 슬롯 미상(구 번들) — 배달할 곳이 없다. 세션 목록이 답
          const msg = `📬 위임 완료 — ${sub}(${head})\n\n${String(bodyText).slice(0, 4000)}`;
          // 부모가 다른 턴을 처리 중이면 기다린다(한 슬롯에 턴은 하나) — 10초 간격, 최대 1시간
          for (let i = 0; i < 360; i++) {
            try {
              await runSession({ ledger: loadLedger(), pkg, agent, authority, prompt: msg, slot: callerSlot });
              return;
            } catch (e) {
              if (!String(e).includes("이전 요청을 처리")) break;
              await new Promise((r2) => setTimeout(r2, 10_000));
            }
          }
          logLine("dispatch", { pkg, sub, slot, delivered: false });
        };
        void run.then((r) => deliver("완료", r.reply), (e) => deliver("실패", e instanceof Error ? e.message : String(e)));
        return `위임이 ${timeoutS}초 안에 끝나지 않았습니다 — 서브에이전트는 세션 "↳ ${sub}" 에서 계속 돌고 있고, 완료되면 이 대화로 📬 배달됩니다. 결과를 기다리거나 재시도하지 말고, 사용자에게 진행 중임을 알리세요.`;
      }
      // 집행도 목록과 같은 스코프를 본다 — 이름을 아는 세션이 선언 밖 동사를 부르는 구멍의 답
      if (!sessionScriptSet(ledger, pkg, agent).has(name)) throw new Error(`E_SCOPE: ${agent} 세션 스코프 밖 동사: ${name}`);
      return await runScript(ledger, pkg, name, args, { principal: authority.principal(), agent }, host, authority);
    },
  };
}

async function handleMcp(
  ledger: Ledger,
  authority: Authority,
  host: HostBridge,
  pkg: string,
  agent: string,
  body: any,
  res: http.ServerResponse,
  callerSlot?: string | null,
  io: McpIO = localMcpIO(ledger, authority, host, pkg, agent, callerSlot),
): Promise<void> {
  const r = await mcpDispatch(io, body ?? {});
  if (r === null) {
    res.writeHead(202).end();
    return;
  }
  json(res, 200, r);
}

function serveView(ledger: Ledger, pkg: string, rest: string, res: http.ServerResponse): void {
  const rec = ledger.packages[pkg];
  if (!rec) return void json(res, 404, { error: `미설치 패키지: ${pkg}` });
  let m: Manifest;
  try {
    m = loadManifest(rec.path);
  } catch (e) {
    return void json(res, 500, { error: String(e) });
  }
  const view = m.surfaces?.view;
  if (!view) {
    // 화면 없는 대화형 패키지 — 위젯만 얹은 기본 대화 페이지를 서빙한다.
    // GUI 에서 카드를 눌러도 쓸 길이 없는 막다른 골목을 없애는 폴백이다
    if (m.surfaces?.chat?.mode === "direct") {
      const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
      const fav = pkgIconHref(pkg, m);
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${esc(fav)}">
<title>${esc(m.display_name ?? pkg)}</title>
<link rel="stylesheet" href="/assets/chat-app.css">
<style>html,body{height:100%;margin:0;background:#f5f6f7}#chat{height:100%;max-width:760px;margin:0 auto;padding:14px;box-sizing:border-box}</style>
</head><body><div id="chat"></div>
<script>window.__RELAY_CONTEXT={base:${JSON.stringify("/pkg/" + encodeURIComponent(pkg))},root:"",instanceId:${JSON.stringify(pkg)}};window.RELAY_CHAT_MANUAL=1;</script>
<script type="module">import { mount } from "/assets/chat-app.js"; mount(document.getElementById("chat"), { instanceId: ${JSON.stringify(pkg)} });</script>
</body></html>`);
    }
    return void json(res, 404, { error: `view 표면 없는 패키지: ${pkg}` });
  }
  const root = path.normalize(path.join(rec.path, view.source, view.out ?? ""));
  // out 선언은 서빙 뿌리 선언이다. 없으면 미빌드 — 소스로 물러나면 선언과 실체의 불일치가
  // "없음: /" 404 나 날 소스로 위장한다(규칙 2: 조용한 강등 금지). 처방이 판정의 본체다.
  if (view.out && !fs.existsSync(root)) {
    return void json(res, 503, {
      error: `view 미빌드: ${pkg} — 선언된 ${view.source}/${view.out} 이 없습니다: npm run relay -- build ${pkg}`,
    });
  }
  const fav = pkgIconHref(pkg, m);
  const target = path.normalize(path.join(root, rest === "" || rest === "/" ? "index.html" : rest));
  if (target !== root && !target.startsWith(root + path.sep)) return void json(res, 403, { error: "경로 탈출" });
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // 정적 발행물의 라우트 관례: <경로>/index.html (trailingSlash) 또는 <경로>.html
    const idx = path.join(target, "index.html");
    if (fs.existsSync(idx)) return void serveViewFile(idx, pkg, root, res, fav);
    const html = target + ".html";
    if (fs.existsSync(html)) return void serveViewFile(html, pkg, root, res, fav);
    return void json(res, 404, { error: `없음: ${rest}` });
  }
  serveViewFile(target, pkg, root, res, fav);
}

function streamFile(file: string, res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// 패키지 view 문서에 마운트 좌표를 심는다(client-protocol §2-6: 마운트를 아는 쪽이 주입한다).
// 이게 없으면 /assets 번들은 base 미주입으로 자동 마운트를 포기하고(main.tsx autoFloat 의
// fail-loud) mount() 도 뿌리 없는 상대 호출이 된다 — README §2 의 "스크립트 한 줄" 이 죽는다.
// 정적 발행물을 손대지 않고 서빙 시점에만 얹으므로 패키지 트리는 기판 마운트를 모른 채 남는다.
function viewContextTag(pkg: string): string {
  const base = JSON.stringify("/pkg/" + encodeURIComponent(pkg));
  return `<script>window.__RELAY_CONTEXT={base:${base},root:"",instanceId:${JSON.stringify(pkg)}};</script>`;
}

// 패키지 대표 아이콘의 서빙 주소 — 카드 아바타와 탭 favicon 이 같은 그림(manifest icon)을 본다
function pkgIconHref(pkg: string, m: Manifest): string {
  return m.icon ? `/pkg/${encodeURIComponent(pkg)}/asset/${m.icon}` : "/pkg/system/view/icon.svg";
}

/**
 * 발행물 접두사 판정의 캐시. 키는 (뿌리, index.html mtime) — 빌드 한 번에 한 번만 stat 한다.
 *
 * 왜 서빙에도 판정이 있는가: 여기가 **사용자를 덮는 유일한 자리**다. validate 는 이 레포의
 * packages/* 만 걷지만 설치본은 rec.path 가 가리키는 아무 곳(마켓 산출·사용자 트리)에 산다.
 * 그 트리를 손으로 구운 사람에게는 판정해 줄 게 아무것도 없었고, 그래서 접두사 없는 발행물이
 * 200 으로 나가고 운영자는 /_next/... 404 벽만 보았다(실사고 2건, 진단은 어디에도 없었다).
 */
const prefixVerdicts = new Map<string, string[]>();
function assetsAtRootCached(root: string): string[] {
  let key = root;
  try {
    key = `${root}\u0000${fs.statSync(path.join(root, "index.html")).mtimeMs}`;
  } catch { /* 문서 없는 뿌리 — 뿌리만으로 캐시 */ }
  const hit = prefixVerdicts.get(key);
  if (hit) return hit;
  const bad = assetsAtDaemonRoot(root);
  prefixVerdicts.clear(); // 재빌드마다 키가 바뀐다 — 옛 키를 쌓아두지 않는다
  prefixVerdicts.set(key, bad);
  return bad;
}

function serveViewFile(file: string, pkg: string, root: string, res: http.ServerResponse, fav: string): void {
  if (path.extname(file) !== ".html") return void streamFile(file, res);
  const atRoot = assetsAtRootCached(root);
  if (atRoot.length) {
    const base = "/pkg/" + pkg + "/view";
    logLine("view", { pkg, ok: false, base, at_root: atRoot.slice(0, 5) });
    const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    res.writeHead(500, { "content-type": MIME[".html"], "cache-control": "no-store" });
    return void res.end(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>view 판정 실패: ${esc(pkg)}</title>
<style>body{font:14px/1.7 ui-monospace,monospace;margin:40px auto;max-width:760px;color:#111}code{background:#f2f3f5;padding:1px 4px;border-radius:3px}li{margin:2px 0}</style>
</head><body>
<h1>이 화면은 자기 자산을 데몬 루트로 가리킵니다</h1>
<p>발행물이 <code>${esc(base)}</code> 접두사 없이 구워져, 아래 자산이 서빙되지 않습니다:</p>
<ul>${atRoot.slice(0, 8).map((r) => `<li><code>${esc(r)}</code></li>`).join("")}</ul>
<p><code>RELAY_BASE_PATH</code> 없이 <code>npx next build</code> 를 돌린 흔적입니다. 정본 경로로 다시 구우세요:</p>
<p><code>npm run relay -- build ${esc(pkg)}</code></p>
<p>깨진 화면을 200 으로 내보내는 대신 여기서 멈춥니다 — 그 편이 <code>/_next</code> 404 벽보다 짧습니다.</p>
</body></html>`);
  }
  const html = fs.readFileSync(file, "utf8");
  const head = html.match(/<head\b[^>]*>/i);
  // <head> 열림 직후 — 번들 로드보다 앞서야 한다(위젯이 로드 시점에 좌표를 읽는다)
  const at = head ? (head.index ?? 0) + head[0].length : 0;
  // favicon 도 좌표처럼 서빙 시점에 얹는다 — 발행물이 자기 favicon 을 선언했다면 그쪽을 존중
  const iconTag = /rel=["']?(?:shortcut\s+)?icon\b/i.test(html)
    ? ""
    : `<link rel="icon" href="${fav.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">`;
  res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
  res.end(html.slice(0, at) + viewContextTag(pkg) + iconTag + html.slice(at));
}

// ── 세션 장부 조회 ─────────────────────────────────────────────────────────

// 권위 이음새 — 1인 기판은 로컬 권위(기본값). 조직 임베드는 여기 다른 구현을 꽂는다(api 는 모른다)
export function createApi(getLedger: () => Ledger, host: HostBridge, ticker: Ticker, authority: Authority = localAuthority(getLedger)): http.Server {
  // 신 wire 의 턴 장부는 세션이 흘리는 봉투를 방청해 쌓인다 — 이 배선이 없으면 stream/attach 가
  // reply 만 보고 delta·tool 이 통째로 사라진다(왕복은 성공하는데 스트리밍만 죽는 형태)
  setEnvelopeTap(tapSessionEvent);
  const wire = { getLedger, authority };
  const server = http.createServer(async (req, res) => {
    try {
      // URL 파싱은 try 안에서 — "//" 같은 기형 경로의 파싱 예외가 밖으로 새면
      // 요청 하나가 데몬 프로세스 전체를 죽인다 (2026-08-06 실사고)
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const p = url.pathname;
      // DNS rebinding 방어: 외부 도메인을 127.0.0.1 로 재바인딩한 브라우저 요청은
      // Host 가 그 도메인으로 오므로 여기서 끊긴다. loopback 이름만 통과
      const hostHdr = String(req.headers.host ?? "");
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHdr)) {
        return void json(res, 403, { error: `허용되지 않은 Host: ${hostHdr}` });
      }
      // CSRF 방어: Host 검사는 DNS rebinding 만 막는다. 아무 웹페이지나 이 데몬으로 상태를
      // 바꾸는 요청을 보낼 수 있고(응답은 못 읽어도 부수효과는 난다 — 턴 개설은 곧 호스트
      // 권한 에이전트에 임의 프롬프트를 넣는 축이다), 문에는 인증이 없다. 브라우저는 비
      // GET/HEAD 요청에 Origin 을 반드시 싣는다는 성질이 유일한 판별점이다: 실려 있으면
      // 데몬 자신의 오리진이어야 하고, 없으면 브라우저 밖(어댑터·CLI·컨테이너)이라 통과다
      if (req.method !== "GET" && req.method !== "HEAD") {
        const reqOrigin = String(req.headers.origin ?? "");
        if (reqOrigin && !SELF_ORIGINS.has(reqOrigin.toLowerCase())) {
          return void json(res, 403, { error: `허용되지 않은 Origin: ${reqOrigin}` });
        }
      }
      if (p === "/" || p === "") {
        res.writeHead(302, { location: "/pkg/system/view/" });
        return void res.end();
      }
      if (p === "/registry" && req.method === "GET") return void json(res, 200, registryData(getLedger()));

      // 클라이언트 전송 계약 v1(docs/client-protocol.md) — 턴·세션·이력·파일·하네스 조회·열거.
      // 마운트 문법(/pkg/<pkg>·/)은 여기서만 해석되고 클라이언트는 base 주입으로 받는다(§2-6).
      // 매치되면 응답까지 책임지므로 아래 기판 라우트는 계약 밖 표면(설치·스토어·관리)만 남는다
      if (await handleClientWire(wire, req, res, url)) return;

      // ── 마켓 스튜디오(스토어 웹 /admin)의 선반 조회 — 스토어 오리진에만 CORS 를 연다.
      // 선반 엔트리(disclosure 포함)가 등재 폼의 정본이고, 운영자 브라우저가 그 다리다.
      // 다른 사이트는 Origin 이 달라 여기서 걸린다 (로컬 패키지 목록의 노출 방지)
      const origin = String(req.headers.origin ?? "");
      const storeOrigins = new Set(["http://localhost:3000", "http://127.0.0.1:3000"]);
      if (STORE_INDEX_URL) {
        try { storeOrigins.add(new URL(STORE_INDEX_URL).origin); } catch { /* URL 형식 아님 — dev 파일 경로 등 */ }
      }
      const corsPath = p === "/market/index" || /^\/market\/asset\/[A-Za-z0-9._-]+$/.test(p);
      if (corsPath && storeOrigins.has(origin)) {
        res.setHeader("access-control-allow-origin", origin);
        res.setHeader("vary", "origin");
        if (req.method === "OPTIONS") {
          // Chrome Private Network Access: 공개 https 페이지 → 로컬 데몬은 이 프리플라이트를 지나야 한다
          res.writeHead(204, {
            "access-control-allow-methods": "GET",
            "access-control-allow-private-network": "true",
          });
          return void res.end();
        }
      }

      // ── 스토어에서 건너오는 설치 ───────────────────────────────
      // 웹에는 로그인이 있고 여기에는 없다. 그 사이를 5분짜리 1회용 티켓이 건넌다:
      // 스토어가 자격을 확인해 티켓을 끊고, 브라우저가 주소창 이동으로 그것을 이리 넘긴다.
      // (https 페이지에서 로컬로 fetch 하는 길은 막혀 있지만 이동은 열려 있다)
      //
      // 이 GET 은 화면만 띄운다. 봉투를 받아 봉인을 대조하고 전개하는 데까지가 전부 정적이고,
      // 실행은 사람이 동의 버튼을 누른 뒤 /store/install/confirm 에서 시작한다.
      if (p === "/store/install" && req.method === "GET") {
        const ref = url.searchParams.get("ref") ?? "";
        const want = url.searchParams.get("v");
        const ticket = url.searchParams.get("ticket") ?? "";
        if (!STORE_INDEX_URL) return void installPage(res, 503, "스토어가 설정되지 않았습니다", "RELAY_STORE_INDEX 를 설정한 뒤 다시 시도하세요.");
        if (!ref || !ticket) return void installPage(res, 400, "설치 링크가 올바르지 않습니다", "스토어의 내 서재에서 다시 눌러 주세요.");
        try {
          const idx = await fetchStoreIndex(STORE_INDEX_URL);
          const entry = idx.entries.find((e) => e.ref === ref);
          if (!entry) return void installPage(res, 404, "스토어에 없는 패키지입니다", ref);
          // 링크가 가리키는 판과 인덱스의 판이 어긋나면 멈춘다 — 낡은 링크로 엉뚱한 봉인을
          // 대조하다 실패하느니, 무엇이 어긋났는지 말해 주는 편이 낫다
          if (want && want !== entry.version) {
            return void installPage(res, 409, "새 판이 나왔습니다", `링크는 ${want}, 스토어는 ${entry.version} 입니다. 내 서재에서 다시 눌러 주세요.`);
          }
          const abs = await redeemWithTicket(STORE_INDEX_URL, entry, ticket);
          const prep = prepareArtifact(getLedger(), abs, { digest: entry.digest, registry: STORE_INDEX_URL });
          prepared.set(prep.id, { p: prep, at: Date.now() });
          for (const [id, v] of prepared) if (Date.now() - v.at > PREPARE_TTL) prepared.delete(id);
          return void consentPage(res, prep);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const code = e instanceof RedeemError ? 410 : 500;
          return void installPage(res, code, "설치를 시작하지 못했습니다", msg);
        }
      }
      if (p === "/store/install/confirm" && req.method === "POST") {
        const b = await readBody(req);
        const held = prepared.get(String(b.id ?? ""));
        if (!held || Date.now() - held.at > PREPARE_TTL) {
          return void installPage(res, 410, "준비가 만료되었습니다", "스토어의 내 서재에서 다시 눌러 주세요.");
        }
        prepared.delete(held.p.id);
        try {
          const r = activatePrepared(getLedger(), held.p);
          return void installPage(res, 200, `${held.p.manifest.display_name ?? held.p.name} 설치 완료`, `${r.name} 로 설치되었습니다. 콘솔에서 바로 쓸 수 있습니다.`, true);
        } catch (e) {
          return void installPage(res, 500, "설치에 실패했습니다", e instanceof Error ? e.message : String(e));
        }
      }

      // ── 마켓: 로컬 선반 + 원격 스토어 병합 ─────────────────────
      // 같은 ref 가 양쪽에 있으면 로컬이 이긴다 — 선반은 "발행 직전의 내 사본"이라
      // 개발 중 오버라이드가 자연스럽다. 설치 여부는 origin.ref 로 대조.
      // 원격 실패는 마켓을 죽이지 않는다: 로컬만 주고 사유를 remote_error 로 싣는다
      if (p === "/market/index" && req.method === "GET") {
        const l = getLedger();
        const installedBy = (ref: string): string | null => {
          for (const [name, rec] of Object.entries(l.packages)) {
            if (rec.origin?.ref === ref) return name;
            try {
              if (loadManifest(rec.path).name === ref) return name;
            } catch { /* 판정 실패 설치본 — 대조 불가로 넘어간다 */ }
          }
          return null;
        };
        const local = readMarketIndex().map((e) => ({ ...e, source: "local" as const }));
        let remoteError: string | null = null;
        let buy: string | null = null;
        let remote: { source: string; [k: string]: unknown }[] = [];
        if (STORE_INDEX_URL) {
          try {
            const idx = await fetchStoreIndex(STORE_INDEX_URL);
            buy = idx.buy;
            const seen = new Set(local.map((e) => e.ref));
            remote = idx.entries
              .filter((e) => !seen.has(e.ref))
              .map((e) => ({ ...e, source: STORE_INDEX_URL }));
          } catch (e) {
            remoteError = e instanceof Error ? e.message : String(e);
          }
        }
        const entries = [...remote, ...local]
          .sort((a, b) => String(a.ref).localeCompare(String(b.ref)))
          .map((e) => ({ ...e, installed: installedBy(String(e.ref)) }));
        return void json(res, 200, { entries, remote: STORE_INDEX_URL || null, remote_error: remoteError, buy });
      }
      // 마켓 선반의 이미지 자산(아이콘 사본)만. 아티팩트 자체는 서빙하지 않는다 — 설치는 서버 로컬 경로로
      const marketAsset = p.match(/^\/market\/asset\/([A-Za-z0-9._-]+)$/);
      if (marketAsset && req.method === "GET") {
        if (!/\.(svg|png|jpe?g|webp|gif|avif)$/i.test(marketAsset[1])) return void json(res, 404, { error: "이미지 자산만 서빙합니다" });
        const file = path.join(artifactsDir(), marketAsset[1]);
        if (!fs.existsSync(file)) return void json(res, 404, { error: "없는 자산" });
        return void streamFile(file, res);
      }

      // ── 손으로 주고받기: 내보내기와 가져오기 ───────────────────
      // 스토어를 거치지 않는 경로다. 폐쇄망 납품이나 "친구에게 하나 줄게"가 여기 산다.
      // 내보낸 봉투에는 봉인이 함께 들어 있지만, 대조할 정본이 없다 — 그래서 가져오기
      // 화면은 "스토어를 거치지 않았다"고 분명히 말한다. 믿음의 근거가 다르기 때문이다.
      // .sig 사이드카도 내보낸다 — 손으로 옮기는 봉투가 서명을 잃지 않게(받는 쪽이 .relay 옆에
      // 두면 prepareArtifact 가 읽는다). 봉투와 사이드카는 같은 선반 봉인 아래 있다
      const exportFile = p.match(/^\/store\/export\/([A-Za-z0-9._-]+\.relay(?:\.sig)?)$/);
      if (exportFile && req.method === "GET") {
        const file = path.join(artifactsDir(), exportFile[1]);
        if (!fs.existsSync(file)) return void json(res, 404, { error: "선반에 없는 봉투 — 먼저 구우세요" });
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(fs.statSync(file).size),
          "content-disposition": `attachment; filename="${exportFile[1]}"`,
        });
        return void fs.createReadStream(file).pipe(res);
      }
      if (p === "/store/import" && req.method === "GET") return void importPage(res);
      if (p === "/store/import" && req.method === "POST") {
        // 몸통이 곧 봉투 바이트다 — multipart 를 파싱하지 않으려고 raw 로 받는다
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > MAX_IMPORT) return void json(res, 413, { error: "봉투가 너무 큽니다 (200MB 상한)" });
          chunks.push(c as Buffer);
        }
        if (!size) return void json(res, 400, { error: "빈 파일입니다" });
        const tmp = path.join(stageDir("import"), `${Date.now()}.relay`);
        fs.writeFileSync(tmp, Buffer.concat(chunks));
        try {
          const prep = prepareArtifact(getLedger(), tmp);
          prepared.set(prep.id, { p: prep, at: Date.now() });
          return void json(res, 200, { id: prep.id });
        } catch (e) {
          return void json(res, 400, { error: e instanceof Error ? e.message : String(e) });
        } finally {
          fs.rmSync(tmp, { force: true }); // 전개는 릴리스 자리에 끝났다 — 임시 봉투는 남길 이유가 없다
        }
      }
      // 준비된 설치의 동의 관문을 id 로 다시 연다 (가져오기가 쓴다 — 스토어 경로는 곧장 그린다)
      if (p === "/store/install/consent" && req.method === "GET") {
        const held = prepared.get(url.searchParams.get("id") ?? "");
        if (!held || Date.now() - held.at > PREPARE_TTL) {
          return void installPage(res, 410, "준비가 만료되었습니다", "봉투를 다시 열어 주세요.");
        }
        return void consentPage(res, held.p, true);
      }

      // ── 설치 2단 관문: 준비(정적) -> 동의 -> 활성(실행) ────────
      // prepare 는 패키지 코드를 실행하지 않고 고지서까지만 만든다. 화면이 고지서를 보여주고
      // 동의를 받은 뒤에야 activate 가 conform·setup·빌드·장부를 지난다. prepareId 는 고지서를
      // 안 본 activate 를 막는 짧은 왕복 토큰이다
      if (p === "/install/prepare" && req.method === "POST") {
        const b = await readBody(req);
        let abs: string;
        let digest: string | undefined = b.digest ? String(b.digest) : undefined;
        let registry: string | null = null;
        if (b.ref) {
          // ref 설치 — 로컬 선반 우선, 없으면 원격 스토어에서 받아 봉인 검증 후 같은 길로
          const ref = String(b.ref);
          const localHit = readMarketIndex().find((e) => e.ref === ref);
          if (localHit) {
            abs = path.join(artifactsDir(), localHit.file);
            digest = localHit.digest;
          } else if (STORE_INDEX_URL) {
            const idx = await fetchStoreIndex(STORE_INDEX_URL);
            const entry = idx.entries.find((e) => e.ref === ref);
            if (!entry) return void json(res, 404, { error: `스토어에 없는 패키지: ${ref}` });
            const paidCache = entry.price != null && !entry.url ? cacheHit(entry.digest) : null;
            const ticket = b.ticket ? String(b.ticket) : null;
            if (ticket) {
              // 티켓 설치 — 웹에서 로그인한 사람이 끊어 준 1회용 통행증.
              // 무료·유료를 가리지 않는다: 자격 판단은 스토어에서 이미 끝났고,
              // 여기서는 봉인 대조만 남는다 (키를 대신하는 새 경로)
              try {
                abs = await redeemWithTicket(STORE_INDEX_URL, entry, ticket);
              } catch (e) {
                if (e instanceof RedeemError) return void json(res, 410, { error: e.message, ref: entry.ref });
                throw e;
              }
            } else if (paidCache) {
              // 이미 받은 봉투는 내 것 — 키를 묻지 않는다. 키를 묻는 순간부터는 반드시 검증한다
              abs = paidCache;
            } else if (entry.price != null && !entry.url) {
              // 유료 — 키가 다운로드의 문을 연다. 키는 vault 에 앉아 재설치 때 다시 묻지 않는다
              const key = (b.key ? String(b.key) : null) ?? await authority.credential(`store-key/${entry.ref}`);
              if (!key) {
                return void json(res, 402, { error: `유료 패키지입니다 (₩${entry.price.toLocaleString()})`, need_key: true, ref: entry.ref, price: entry.price });
              }
              try {
                abs = await redeemArtifact(STORE_INDEX_URL, idx.redeem, entry, key);
              } catch (e) {
                if (e instanceof RedeemError) {
                  return void json(res, 402, { error: e.message, need_key: true, ref: entry.ref, price: entry.price });
                }
                throw e;
              }
              await authority.setCredential(`store-key/${entry.ref}`, key.trim()); // redeem 을 통과한 키만 보관한다
            } else {
              abs = await downloadArtifact(STORE_INDEX_URL, entry);
            }
            digest = entry.digest;
            registry = STORE_INDEX_URL;
          } else {
            return void json(res, 404, { error: `선반에 없는 패키지: ${ref} (스토어 미설정)` });
          }
        } else {
          const file = String(b.file ?? "");
          // 화면은 선반의 파일 이름만 안다 — 절대경로가 아니면 선반 아래로 봉인해 해석한다
          abs = file.startsWith("/") ? file : path.join(artifactsDir(), path.basename(file));
        }
        const prep = prepareArtifact(getLedger(), abs, { name: b.name ? String(b.name) : undefined, digest, registry });
        prepared.set(prep.id, { p: prep, at: Date.now() });
        for (const [id, v] of prepared) if (Date.now() - v.at > PREPARE_TTL) prepared.delete(id);
        const { manifest: _m, ...rest } = prep;
        return void json(res, 200, { ...rest, display_name: prep.manifest.display_name });
      }
      if (p === "/install/activate" && req.method === "POST") {
        const b = await readBody(req);
        const held = prepared.get(String(b.id ?? ""));
        if (!held || Date.now() - held.at > PREPARE_TTL) {
          return void json(res, 410, { error: "만료된 준비입니다 — 설치를 처음부터 다시 시작하세요" });
        }
        prepared.delete(held.p.id);
        const l = getLedger();
        const r = activatePrepared(l, held.p, { workspace: b.workspace ? String(b.workspace) : undefined });
        stopServices(held.p.name); // 업데이트라면 옛 릴리스 코드로 떠 있다 — 새 스냅샷으로 갈아탄다
        const notes = [...startServices(l, held.p.name, held.p.dir, held.p.manifest), ...startChannels(l, held.p.name, held.p.dir, held.p.manifest)];
        ticker.emit(held.p.fresh ? "relay.package.installed" : "relay.package.published", { pkg: held.p.name, version: held.p.version });
        return void json(res, 200, { name: r.name, fresh: held.p.fresh, version: held.p.version, setup: r.setup ?? null, build: r.build ?? null, services: notes });
      }

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
      // 번들은 릴리스 컷이 굽는다(lib/relayjs chat-build.mjs → dist) — js 와 css 두 갈래다
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
        return void (await handleMcp(getLedger(), authority, host, pkg, agent, await readBody(req), res, url.searchParams.get("session")));
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
        const { setHarness } = await import("./installer.ts");
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
        const note = startOneChannel(pkg, rec.path, c, localIO(l));
        return void json(res, 200, { ok: true, running: channelPid(pkg, channel) != null, note });
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

      const view = p.match(/^\/pkg\/([^/]+)\/view(\/.*)?$/);
      if (view && req.method === "GET") return void serveView(getLedger(), decodeURIComponent(view[1]), (view[2] ?? "/").slice(1), res);

      json(res, 404, { error: `없는 경로: ${p}` });
    } catch (e) {
      json(res, 500, { error: String(e) });
    }
  });
  server.listen(API_PORT, "127.0.0.1");
  return server;
}

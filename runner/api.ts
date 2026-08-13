import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { API_PORT, PRINCIPAL, RELAY_HOME, STORE_INDEX_URL, loadLedger, tokenToPkg, stageDir, sessionDir, workspacePath, artifactsDir, type Grant, type Ledger } from "./state.ts";
import { fetchStoreIndex, downloadArtifact, redeemArtifact, redeemWithTicket, cacheHit, RedeemError } from "./registry.ts";
import { vaultGet, vaultSet } from "./vault.ts";
import { loadManifest, landingAgentName, listScripts, agentScriptScope, shortName, type Manifest, type ServiceDecl } from "./manifest.ts";
import { runSession, cancelSession, retireResident, retireResidents, autoTitleSession, deliverAnswer, isSessionBusy } from "./session.ts";
import { runScript, mcpCall, type HostBridge } from "./scripts.ts";
import { installPkg, buildPkg, removePkg, addGrant, removeGrant, resolveProvider, registryData, validateDir, harnessVerb, probeHarness, connectHarnessToken, launchHarnessLogin, prepareArtifact, activatePrepared, type Prepared } from "./installer.ts";
import { readMarketIndex, packDir, updateMarketIndex } from "./pack.ts";
import { openDraft, readDraft, writeDraft, diffDraft, commitDraft, validateDraft, publishDraft, discardDraft, listDrafts, listReleases, rollbackRelease } from "./draft.ts";
import { saveLedger } from "./state.ts";
import { startServices, stopServices } from "./run.ts";
import { Ticker } from "./tick.ts";
import { loginStart, loginRead, loginInput, loginStop } from "./login.ts";

const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_FILE = path.join(RUNNER_DIR, "..", "relay.manifest.yaml");
const ASSETS_DIR = path.join(RUNNER_DIR, "..", "lib", "relayjs", "src");

// 준비된 설치의 대기석. 고지서를 본 화면만 activate 에 닿도록 짧은 토큰으로 잇는다.
// 릴리스 전개는 이미 디스크에 있으므로 만료되어도 잃는 것은 없다 — 다시 prepare 하면 재사용된다
const prepared = new Map<string, { p: Prepared; at: number }>();
const PREPARE_TTL = 10 * 60_000;
/** 손으로 가져오는 봉투의 상한 — 원격 다운로드와 같은 선 */
const MAX_IMPORT = 200 * 1024 * 1024;

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
${sideloaded
      ? `<div class="warn">스토어를 거치지 않은 봉투입니다 — 보낸 사람을 믿을 수 있을 때만 설치하세요</div>
<div class="seal">봉인값 · <code>${esc(prep.digest)}</code></div>`
      : `<div class="seal">봉인 확인됨 · <code>${esc(prep.digest)}</code></div>`}
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

export function makeHostBridge(getLedger: () => Ledger, getTicker: () => Ticker | null): HostBridge {
  return {
    registry: () => registryData(getLedger()),
    install: (dir, opts) => {
      const r = installPkg(getLedger(), dir, { ring0: opts?.ring0, workspace: opts?.workspace });
      retireResidents(r.name); // 재설치라면 상주가 옛 코드·옛 번들로 떠 있다
      startServices(getLedger(), r.name, getLedger().packages[r.name].path, r.manifest);
      getTicker()?.emit("relay.package.installed", { pkg: r.name });
      // setup 과 build 결과를 여기서 버리면 "설치 성공" 이 검증 없이 참이 된다
      return { name: r.name, setup: r.setup ?? null, build: r.build ?? null };
    },
    build: (name) => buildPkg(getLedger(), name),
    remove: (name) => {
      removePkg(getLedger(), name);
      return { removed: name };
    },
    grants: () => getLedger().grants,
    grant: (g) => {
      addGrant(getLedger(), g);
      return { ok: true };
    },
    validate: (dir) => validateDir(dir),
    draftOpen: (name, opts) => openDraft(getLedger(), name, opts),
    draftRead: (name, file) => (file ? readDraft(getLedger(), name, file) : readDraft(getLedger(), name)),
    draftWrite: (name, files, deletes) => writeDraft(name, files ?? {}, deletes ?? []),
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
        const notes = startServices(l, name, r.path, r.manifest);
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
      const notes = startServices(l, name, r.path, r.manifest);
      return { name: r.name, version: r.version, path: r.path, services: notes };
    },
    dispatch: async (providerRef, mission, payload, consumer) => {
      const ledger = getLedger();
      const provider = resolveProvider(ledger, providerRef);
      if (!provider) throw new Error(`provider 미설치: ${providerRef}`);
      const m = loadManifest(ledger.packages[provider].path);
      if (!(m.missions ?? []).some((x) => x.name === mission)) throw new Error(`미선언 미션: ${mission}`);
      // 첫 줄은 위임 마커다 — 수신 대화의 화면이 이 마커를 발신자 아이콘 카드로 렌더한다
      const prompt = `[미션 수신: ${mission}${consumer ? ` ← ${consumer}` : ""}]\n${payload}`;
      const slot = `mission-${mission}`;
      // 위임 대화도 세션 목록의 시민이다 — 이름이 없으면 마커 원문이 라벨 행세를 해서 흉하다
      const labelFile = path.join(sessionDir(provider, slot), "label");
      if (!fs.existsSync(labelFile)) fs.writeFileSync(labelFile, `⇄ ${consumer ?? "외부"} → ${mission}`);
      const r = await runSession({ ledger, pkg: provider, prompt, slot });
      return r.reply;
    },
  };
}

function sessionTools(ledger: Ledger, pkg: string, agent: string): { name: string; description: string }[] {
  const rec = ledger.packages[pkg];
  const m = loadManifest(rec.path);
  const tools: { name: string; description: string }[] = [];

  const agentsInPlay = [agent, ...((m.agents ?? []).find((a) => a.name === agent)?.dispatch ?? [])];
  const allScripts = listScripts(rec.path, m);
  const inScope = new Set<string>();
  for (const a of agentsInPlay) {
    const scope = agentScriptScope(m, a);
    if (!scope) continue;
    for (const s of allScripts) if (scope(s)) inScope.add(s);
  }
  for (const s of inScope) tools.push({ name: s, description: `${pkg} 패키지의 ${s} 동사` });

  for (const g of ledger.grants.filter((g) => g.consumer === pkg)) {
    if (g.mission) {
      tools.push({
        name: `a2a__${g.provider}__${g.mission.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
        description: `a2a 위임: ${g.provider} 의 ${g.mission} 미션. arguments: { payload: string }`,
      });
    }
    for (const t of g.tools ?? []) {
      tools.push({ name: `edge__${g.provider}__${t}`, description: `edge 소비: ${g.provider} 의 ${t}` });
    }
  }
  return tools;
}

async function callEdgeTool(ledger: Ledger, consumer: string, provider: string, tool: string, args: unknown, host: HostBridge): Promise<unknown> {
  const grant = ledger.grants.find((g) => g.consumer === consumer && g.provider === provider && (g.tools ?? []).includes(tool));
  if (!grant) throw new Error(`E_NO_GRANT: ${consumer} -> ${provider}/${tool}`);
  const rec = ledger.packages[provider];
  const m = loadManifest(rec.path);
  const urlSvc = (m.services ?? []).find((s): s is Extract<ServiceDecl, { url: string }> => "url" in s && s.url != null && (s.tools ?? []).includes(tool));
  if (urlSvc) return await mcpCall(urlSvc.url, tool, args);
  if (listScripts(rec.path, m).includes(tool)) return await runScript(ledger, provider, tool, args, { principal: PRINCIPAL }, host);
  throw new Error(`provider 에 해당 동사 없음: ${provider}/${tool}`);
}

async function handleMcp(ledger: Ledger, host: HostBridge, pkg: string, agent: string, body: any, res: http.ServerResponse): Promise<void> {
  const { id, method, params } = body;
  const reply = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id, result });
  const fail = (message: string) => json(res, 200, { jsonrpc: "2.0", id, error: { code: -32000, message } });

  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "relay", version: "0.1.0" },
    });
  }
  if (String(method ?? "").startsWith("notifications/")) {
    res.writeHead(202).end();
    return;
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    return reply({
      tools: sessionTools(ledger, pkg, agent).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: { type: "object", additionalProperties: true },
      })),
    });
  }
  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const args = params?.arguments ?? {};
    try {
      let result: unknown;
      const a2a = name.match(/^a2a__([a-z0-9-]+)__(.+)$/);
      const edge = name.match(/^edge__([a-z0-9-]+)__(.+)$/);
      if (a2a) {
        const m = loadManifest(ledger.packages[a2a[1]].path);
        const mission = (m.missions ?? []).find((x) => x.name.replace(/[^a-zA-Z0-9_-]/g, "_") === a2a[2])?.name ?? a2a[2];
        const grant = ledger.grants.find((g) => g.consumer === pkg && g.provider === a2a[1] && g.mission === mission);
        if (!grant) throw new Error(`E_NO_GRANT: ${pkg} -> ${a2a[1]}/${mission}`);
        result = await host.dispatch(a2a[1], mission, String((args as any).payload ?? JSON.stringify(args)), pkg);
      } else if (edge) {
        result = await callEdgeTool(ledger, pkg, edge[1], edge[2], args, host);
      } else {
        result = await runScript(ledger, pkg, name, args, { principal: PRINCIPAL, agent }, host);
      }
      const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return reply({ content: [{ type: "text", text }], isError: false });
    } catch (e) {
      return reply({ content: [{ type: "text", text: String(e) }], isError: true });
    }
  }
  return fail(`지원하지 않는 메서드: ${method}`);
}

function pkgCommands(ledger: Ledger, pkg: string): { name: string; description: string; tty: boolean }[] {
  const rec = ledger.packages[pkg];
  if (!rec) return [];
  const m = loadManifest(rec.path);
  const landing = landingAgentName(m);
  const decl = (m.agents ?? []).find((a) => a.name === landing);
  if (!decl?.commands) return [];
  const dir = path.join(rec.path, decl.commands);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
    const body = fs.readFileSync(path.join(dir, f), "utf8");
    const desc = body.match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    return { name: f.replace(/\.md$/, ""), description: desc, tty: false };
  });
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
      const fav = m.icon ? `/pkg/${encodeURIComponent(pkg)}/asset/${m.icon}` : "/pkg/system/view/icon.svg";
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return void res.end(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="${esc(fav)}">
<title>${esc(m.display_name ?? pkg)}</title>
<style>html,body{height:100%;margin:0;background:#f5f6f7}#chat{height:100%;max-width:760px;margin:0 auto;padding:14px;box-sizing:border-box}</style>
</head><body><div id="chat"></div>
<script type="module">import { mount } from "/assets/chat-widget.js"; mount({ pkg: ${JSON.stringify(pkg)}, mode: "inline", target: document.getElementById("chat") });</script>
</body></html>`);
    }
    return void json(res, 404, { error: `view 표면 없는 패키지: ${pkg}` });
  }
  let root = path.join(rec.path, view.source, view.out ?? "");
  if (view.out && !fs.existsSync(root)) root = path.join(rec.path, view.source);
  root = path.normalize(root);
  const target = path.normalize(path.join(root, rest === "" || rest === "/" ? "index.html" : rest));
  if (target !== root && !target.startsWith(root + path.sep)) return void json(res, 403, { error: "경로 탈출" });
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // 정적 발행물의 라우트 관례: <경로>/index.html (trailingSlash) 또는 <경로>.html
    const idx = path.join(target, "index.html");
    if (fs.existsSync(idx)) return void streamFile(idx, res);
    const html = target + ".html";
    if (fs.existsSync(html)) return void streamFile(html, res);
    return void json(res, 404, { error: `없음: ${rest}` });
  }
  streamFile(target, res);
}

function streamFile(file: string, res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

// ── 세션 장부 조회 ─────────────────────────────────────────────────────────
// 이력의 정본은 세션 디렉토리의 history.jsonl (session.ts 가 쌓는다).
// 목록·전환·복원은 기판이 답한다 — 하네스의 자체 세션 저장과는 별개의 축이다
const SLOT_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function sessionsRoot(pkg: string): string {
  return path.join(RELAY_HOME, "sessions", pkg);
}

function readHistory(pkg: string, slot: string, limit: number): { t: string; role: string; text: string }[] {
  const file = path.join(sessionsRoot(pkg), slot, "history.jsonl");
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  return lines
    .slice(-limit)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

type SessionRow = { slot: string; label: string; updated: number; archived: boolean; pinned: boolean };

function listSessions(pkg: string): { sessions: SessionRow[] } {
  const root = sessionsRoot(pkg);
  if (!fs.existsSync(root)) return { sessions: [] };
  const sessions: SessionRow[] = [];
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    // "_" 접두 슬롯은 기판 내부용(자동 제목 생성 등의 임시 세션) — 목록에 내지 않는다
    if (!e.isDirectory() || !SLOT_RE.test(e.name) || e.name.startsWith("_")) continue;
    const dir = path.join(root, e.name);
    const hist = path.join(dir, "history.jsonl");
    // 이름 우선순위: 사용자가 지은 label > 하네스가 지은 auto-label > 첫 사용자 발화
    let label = "";
    for (const f of ["label", "auto-label"]) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) label = fs.readFileSync(p, "utf8").trim();
      if (label) break;
    }
    if (!label && fs.existsSync(hist)) {
      // 이름이 없으면 첫 사용자 발화가 이름이다 (relayos-claude 세션 목록 관례)
      try {
        label = String(JSON.parse(fs.readFileSync(hist, "utf8").split("\n", 1)[0]).text ?? "").slice(0, 40);
      } catch {
        label = "";
      }
    }
    const updated = fs.statSync(fs.existsSync(hist) ? hist : dir).mtimeMs;
    // 보관·고정 = 세션 디렉토리의 marker 파일. 이력은 그대로 두고 목록의 자리만 옮긴다
    sessions.push({
      slot: e.name,
      label: label || e.name,
      updated,
      archived: fs.existsSync(path.join(dir, "archived")),
      pinned: fs.existsSync(path.join(dir, "pinned")),
    });
  }
  // 고정이 먼저, 그 안에서는 최근 순
  sessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
  return { sessions };
}

export function createApi(getLedger: () => Ledger, host: HostBridge, ticker: Ticker): http.Server {
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
      if (p === "/" || p === "") {
        res.writeHead(302, { location: "/pkg/system/view/" });
        return void res.end();
      }
      if (p === "/registry" && req.method === "GET") return void json(res, 200, registryData(getLedger()));

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
      const exportFile = p.match(/^\/store\/export\/([A-Za-z0-9._-]+\.relay)$/);
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
              const key = (b.key ? String(b.key) : null) ?? vaultGet(`store-key/${entry.ref}`);
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
              vaultSet(`store-key/${entry.ref}`, key.trim()); // redeem 을 통과한 키만 보관한다
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
        const notes = startServices(l, held.p.name, held.p.dir, held.p.manifest);
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

      // 기판 소유 클라이언트 자산(채팅 코어·위젯). 패키지 view 가 아니라 기판이 서빙한다 —
      // 위젯은 하네스와의 연결지점이라 구현이 기판과 함께 움직여야 하기 때문
      const asset = p.match(/^\/assets\/([a-z0-9-]+\.js)$/);
      if (asset && req.method === "GET") {
        const file = path.join(ASSETS_DIR, asset[1] === "chat-core.js" ? "core.js" : asset[1] === "chat-widget.js" ? "widget.js" : asset[1]);
        if (!fs.existsSync(file)) return void json(res, 404, { error: `없는 자산: ${asset[1]}` });
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
      if (p === "/grants" && req.method === "POST") {
        const g = (await readBody(req)) as Grant;
        addGrant(getLedger(), g);
        return void json(res, 200, { ok: true });
      }
      if (p === "/grants/remove" && req.method === "POST") {
        removeGrant(getLedger(), (await readBody(req)) as Grant);
        return void json(res, 200, { ok: true });
      }
      if (p === "/install" && req.method === "POST") {
        const b = await readBody(req);
        const r = host.install(String(b.path), { ring0: !!b.ring0, workspace: b.workspace ? String(b.workspace) : undefined });
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
        const owner = tokenToPkg(getLedger(), token);
        if (owner !== pkg) return void json(res, 401, { error: "토큰 불일치" });
        const agent = url.searchParams.get("agent") ?? landingAgentName(loadManifest(getLedger().packages[pkg].path)) ?? "";
        return void (await handleMcp(getLedger(), host, pkg, agent, await readBody(req), res));
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

      // 대화형 로그인 발화. 인증 자체는 터미널(TTY)이 소유하고 기판은 그 창을 열어 줄 뿐이다
      // 로그인 두 갈래: headless(pty 중계 — 브라우저 안에서 끝난다)와 terminal(창을 여는 폴백)
      const hl = p.match(/^\/pkg\/([^/]+)\/harness\/login$/);
      if (hl && req.method === "POST") {
        const b = await readBody(req);
        const pkg = decodeURIComponent(hl[1]);
        if (b.mode === "terminal") {
          return void json(res, 200, { mode: "terminal", ...launchHarnessLogin(getLedger(), pkg, { switch: !!b.switch }) });
        }
        return void json(res, 200, { mode: "headless", ...loginStart(getLedger(), pkg, { switch: !!b.switch }) });
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

      const hv = p.match(/^\/pkg\/([^/]+)\/harness\/(models|info|setup|commands)$/);
      if (hv && req.method === "GET") {
        const pkg = decodeURIComponent(hv[1]);
        const r = harnessVerb(getLedger(), pkg, hv[2] as never);
        if (hv[2] === "setup") return void json(res, 200, r);
        let value: unknown;
        try {
          value = JSON.parse(r.out);
        } catch {
          value = r.out;
        }
        if (hv[2] === "commands") {
          const fromHarness = Array.isArray(value) ? value : [];
          return void json(res, 200, { ok: r.ok, value: [...pkgCommands(getLedger(), pkg), ...fromHarness] });
        }
        return void json(res, 200, { ok: r.ok, value });
      }
      const setModel = p.match(/^\/pkg\/([^/]+)\/model$/);
      if (setModel && req.method === "POST") {
        const b = await readBody(req);
        const l = getLedger();
        const pkg = decodeURIComponent(setModel[1]);
        const rec = l.packages[pkg];
        if (!rec) return void json(res, 404, { error: "미설치 패키지" });
        if ("model" in b) rec.model = b.model ? String(b.model) : undefined;
        if ("effort" in b) rec.effort = b.effort ? String(b.effort) : undefined;
        saveLedger(l);
        // 저장 시점 재검증 — 장부에 없는 모델이 박혀 조용히 썩는 사고의 답. 직접 입력의 자유는
        // 지키므로 막지 않고 known 으로 알린다 (어댑터가 세션에서 거부하면 exit != 0 으로 드러난다)
        let known: boolean | null = null;
        if (rec.model) {
          try {
            const r = harnessVerb(l, pkg, "models");
            const arr = JSON.parse(r.out);
            if (Array.isArray(arr)) known = arr.includes(rec.model);
          } catch { /* models 불달 — 판정 불가 */ }
        }
        return void json(res, 200, { ok: true, model: rec.model ?? null, effort: rec.effort ?? null, known });
      }

      const sessList = p.match(/^\/pkg\/([^/]+)\/sessions$/);
      if (sessList && req.method === "GET") {
        return void json(res, 200, listSessions(decodeURIComponent(sessList[1])));
      }

      const sessOp = p.match(/^\/pkg\/([^/]+)\/session\/([^/]+)\/(history|label|delete|cancel|events|answer|archive|pin)$/);
      if (sessOp) {
        const pkg = decodeURIComponent(sessOp[1]);
        const slot = sessOp[2];
        if (!SLOT_RE.test(slot)) return void json(res, 400, { error: `slot 형식 위반: ${slot}` });
        if (sessOp[3] === "history" && req.method === "GET") {
          // busy = 이 슬롯에 진행 중 턴이 있다 — 새로고침한 화면이 진행 표시와 중지를 되찾는 근거
          return void json(res, 200, { messages: readHistory(pkg, slot, 200), busy: isSessionBusy(pkg, slot) });
        }
        // 진행 중 턴의 봉투 이벤트 — 위젯이 폴링해 delta·tool 진행과 파일 칩을 그린다.
        // from = 이미 받은 줄 수: 도구 결과 본문이 실리는 protocol 3 에서 매 폴링이
        // 전체 장부를 다시 나르지 않게 한다 (미지정 = 전체, 구 위젯 호환)
        if (sessOp[3] === "events" && req.method === "GET") {
          const file = path.join(sessionsRoot(pkg), slot, "events.jsonl");
          if (!fs.existsSync(file)) return void json(res, 200, { events: [], from: 0 });
          const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
          const from = Math.min(lines.length, Math.max(0, Number(url.searchParams.get("from") ?? 0) || 0));
          const events = lines.slice(from).map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return null;
            }
          }).filter(Boolean);
          return void json(res, 200, { events, from: lines.length });
        }
        // ask(질문) 회송 — 위젯 답변을 진행 중 봉투의 제어 채널로 전달한다
        if (sessOp[3] === "answer" && req.method === "POST") {
          const b = await readBody(req);
          return void json(res, 200, { ok: deliverAnswer(pkg, slot, String(b.id ?? ""), Array.isArray(b.answers) ? b.answers : []) });
        }
        // 취소: 봉투 stdin 제어가 1순위, 신호가 그물 (session.cancelSession)
        if (sessOp[3] === "cancel" && req.method === "POST") {
          return void json(res, 200, { ok: cancelSession(pkg, slot) });
        }
        const dir = path.join(sessionsRoot(pkg), slot);
        if (sessOp[3] === "label" && req.method === "POST") {
          const b = await readBody(req);
          if (!fs.existsSync(dir)) return void json(res, 404, { error: `없는 세션: ${slot}` });
          fs.writeFileSync(path.join(dir, "label"), String(b.label ?? "").trim().slice(0, 80));
          return void json(res, 200, { ok: true, slot });
        }
        if (sessOp[3] === "delete" && req.method === "POST") {
          retireResident(pkg, slot); // 상주가 지워진 번들 경로를 물고 있으면 안 된다
          fs.rmSync(dir, { recursive: true, force: true });
          return void json(res, 200, { ok: true, removed: slot });
        }
        // 보관/복원 — 삭제와 달리 이력을 지우지 않는다. marker 파일 하나가 상태의 전부다
        if (sessOp[3] === "archive" && req.method === "POST") {
          const b = await readBody(req);
          if (!fs.existsSync(dir)) return void json(res, 404, { error: `없는 세션: ${slot}` });
          const marker = path.join(dir, "archived");
          if (b.archived) fs.writeFileSync(marker, "");
          else fs.rmSync(marker, { force: true });
          return void json(res, 200, { ok: true, slot, archived: !!b.archived });
        }
        // 고정/해제 — 목록 정렬에서 맨 위로 올리는 marker. archive 와 같은 축이다
        if (sessOp[3] === "pin" && req.method === "POST") {
          const b = await readBody(req);
          if (!fs.existsSync(dir)) return void json(res, 404, { error: `없는 세션: ${slot}` });
          const marker = path.join(dir, "pinned");
          if (b.pinned) fs.writeFileSync(marker, "");
          else fs.rmSync(marker, { force: true });
          return void json(res, 200, { ok: true, slot, pinned: !!b.pinned });
        }
      }

      const reset = p.match(/^\/pkg\/([^/]+)\/session\/reset$/);
      if (reset && req.method === "POST") {
        const b = await readBody(req);
        const slot = String(b.slot ?? "console");
        const { sessionDir } = await import("./state.ts");
        // 상주가 낡은 대화를 메모리에 물고 있으면 포인터를 지워도 대화가 이어진다 — 먼저 은퇴
        retireResident(decodeURIComponent(reset[1]), slot);
        const marker = path.join(sessionDir(decodeURIComponent(reset[1]), slot), "bundle", "claude-session");
        if (fs.existsSync(marker)) fs.unlinkSync(marker);
        return void json(res, 200, { ok: true, slot });
      }

      const chat = p.match(/^\/pkg\/([^/]+)\/chat$/);
      if (chat && req.method === "POST") {
        const b = await readBody(req);
        const pkg = decodeURIComponent(chat[1]);
        const r = await runSession({
          ledger: getLedger(),
          pkg,
          prompt: String(b.message ?? ""),
          slot: b.slot ? String(b.slot) : undefined,
          agent: b.agent ? String(b.agent) : undefined,
          attachments: Array.isArray(b.attachments) ? b.attachments : undefined,
          scene: b.scene ? String(b.scene) : undefined,
        });
        // 첫 교환이 완결된 무명 세션이면 하네스에 제목을 시킨다 — 응답을 붙들지 않는다(fire-and-forget)
        if (b.slot && SLOT_RE.test(String(b.slot))) {
          void autoTitleSession(getLedger(), pkg, String(b.slot)).catch(() => { /* 제목 실패는 무시 */ });
        }
        return void json(res, 200, { reply: r.reply, model: r.model ?? null, usage: r.usage ?? null, context: r.context ?? null, files: r.files ?? [] });
      }

      // ── 파일 주고받기 — stage 가 유일한 무대다 ─────────────────────────
      // 업로드: 바이트를 사이드밴드로 스트리밍해 stage/uploads 에 앉힌다 (JSON body 비경유).
      // 반환된 상대경로가 첨부 참조가 되고, 세션이 프롬프트 앞에 절대경로로 붙인다.
      // workspace 가 아니라 stage 인 이유: workspace 는 ~ 처럼 넓게 결재될 수 있고,
      // HTTP 로 드나드는 파일의 범위는 그와 무관하게 좁아야 한다
      const up = p.match(/^\/pkg\/([^/]+)\/upload$/);
      if (up && req.method === "POST") {
        const pkg = decodeURIComponent(up[1]);
        if (!getLedger().packages[pkg]) return void json(res, 404, { error: `미설치 패키지: ${pkg}` });
        const rawName = String(url.searchParams.get("name") ?? "file");
        const name = (rawName.split(/[\\/]/).pop() ?? "file").replace(/^\.+/, "_").slice(0, 128) || "file";
        const dir = path.join(stageDir(pkg), "uploads");
        fs.mkdirSync(dir, { recursive: true });
        let target = path.join(dir, name);
        if (fs.existsSync(target)) {
          const ext = path.extname(name);
          target = path.join(dir, path.basename(name, ext) + "-" + Date.now().toString(36) + ext);
        }
        const MAX_UPLOAD = 100 * 1024 * 1024;
        let size = 0;
        let failed = false;
        const ws = fs.createWriteStream(target);
        req.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_UPLOAD && !failed) {
            failed = true;
            ws.destroy();
            fs.rmSync(target, { force: true });
            json(res, 413, { error: `첨부 상한 초과: ${MAX_UPLOAD} bytes` });
            req.destroy();
          }
        });
        req.pipe(ws);
        ws.on("finish", () => {
          if (!failed) json(res, 200, { path: "uploads/" + path.basename(target), size, name: path.basename(target) });
        });
        ws.on("error", (e) => {
          if (!failed) json(res, 500, { error: String(e) });
        });
        return;
      }

      // 다운로드: stage 봉인 아래에서만. HEAD 는 위젯의 파일 링크 실재 프로브용.
      // 에이전트가 채팅으로 파일을 보내려면 stage 에 놓는다 — 번들 meta 가 그 경로를 알려준다
      const fileR = p.match(/^\/pkg\/([^/]+)\/file\/(.+)$/);
      if (fileR && (req.method === "GET" || req.method === "HEAD")) {
        const pkg = decodeURIComponent(fileR[1]);
        if (!getLedger().packages[pkg]) return void json(res, 404, { error: `미설치 패키지: ${pkg}` });
        const root = path.normalize(stageDir(pkg));
        const target = path.normalize(path.join(root, decodeURIComponent(fileR[2])));
        if (target !== root && !target.startsWith(root + path.sep)) return void json(res, 403, { error: "경로 탈출" });
        if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) return void json(res, 404, { error: "없는 파일" });
        const head: Record<string, string> = {
          "content-type": MIME[path.extname(target)] ?? "application/octet-stream",
          "content-length": String(fs.statSync(target).size),
        };
        if (url.searchParams.get("dl") === "1") {
          head["content-disposition"] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
        }
        res.writeHead(200, head);
        if (req.method === "HEAD") return void res.end();
        fs.createReadStream(target).pipe(res);
        return;
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
        const result = await runScript(getLedger(), decodeURIComponent(script[1]), script[2], b.input ?? b, { principal: PRINCIPAL }, host);
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

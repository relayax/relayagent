// store.ts — 봉투가 오가는 HTTP 표면. 스토어에서 건너온 설치, 로컬 선반(마켓) 조회,
// 봉투 내보내기·가져오기, 그리고 사람이 보는 동의 화면.
//
// 문(daemon)에서 갈라 나온 이유: 이 라우트들의 수명은 "패키지가 오는 일"이지 "요청 하나"가
// 아니다. 화면을 콘솔(Next)이 아니라 데몬이 직접 굽는 것도 그대로 가져온다 — 굽는 단계 없이
// 고칠 수 있고, 걷어낸 마켓 표면을 되살리지 않으면서 필요한 문 하나만 세운다.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { artifactsDir, stageDir, STORE_INDEX_URL, type Ledger } from "./ledger.ts";
import { fetchStoreIndex, downloadArtifact, redeemArtifact, redeemWithTicket, cacheHit, RedeemError } from "./registry.ts";
import { readMarketIndex, packDir, updateMarketIndex } from "./pack.ts";
import { prepareArtifact, activatePrepared, resolveInstallName, type Prepared } from "./install.ts";
import { loadManifest } from "./manifest.ts";
import { startServices, startChannels, stopServices, type RunnerIO } from "../runtime/services.ts";
import { Ticker } from "../runtime/triggers.ts";
import { MIME, json, esc, readBody, streamFile } from "../http.ts";
import type { Authority } from "../authority-contract.ts";

/** 준비된(동의 전) 봉투의 대기소 — 데몬 하나당 하나. 만료분은 접근 때마다 걷힌다 */
const prepared = new Map<string, { p: Prepared; at: number }>();
const PREPARE_TTL = 10 * 60_000;
/** 손으로 가져오는 봉투의 상한 — 원격 다운로드와 같은 선 */
const MAX_IMPORT = 200 * 1024 * 1024;

// ── 스토어에서 건너온 설치의 화면 ──────────────────────────────────────────────
// 콘솔(Next 앱)이 아니라 데몬이 직접 굽는다. 이유는 둘이다: 굽는 단계 없이 고칠 수 있고,
// 걷어낸 마켓 표면을 되살리지 않으면서 필요한 문 하나만 세울 수 있다.

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
  for (const n of d.network) rows.push(`<div><dt>외부</dt><dd><code>${esc(n.url)}</code> 로 나갑니다${n.auth === "none" ? "" : ` (자격: ${esc(n.auth)} — 값은 vault, 연결은 설치 후)`}</dd></div>`);
  for (const w of d.wakeups) rows.push(`<div><dt>자동</dt><dd>${esc(w.when)} 에 스스로 깨어납니다</dd></div>`);
  if (d.host.length) rows.push(`<div><dt>호스트</dt><dd>${esc(d.host.join(" · "))}</dd></div>`);
  if (d.borrows.length) rows.push(`<div><dt>빌림</dt><dd>${esc(d.borrows.join(" · "))}</dd></div>`);
  if (d.spawns.length) rows.push(`<div><dt>프로세스</dt><dd>${esc(d.spawns.join(" · "))}</dd></div>`);
  if (d.hostMethods.length) rows.push(`<div><dt>기판</dt><dd>host 브리지 <code>${esc(d.hostMethods.join(", "))}</code></dd></div>`);

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


/** 스토어 축의 좌표 — 문이 조립해 넘긴다. 이 넷이 라우트가 붙잡는 전부다 */
export interface StoreCtx {
  getLedger: () => Ledger;
  authority: Authority;
  runnerIO: (l: Ledger) => RunnerIO;
  ticker: Ticker;
}

/** 매치되면 응답까지 책임지고 true. 아니면 false — 문이 다음 라우트로 넘어간다 */
export async function handleStore(ctx: StoreCtx, req: http.IncomingMessage, res: http.ServerResponse, url: URL, p: string): Promise<boolean> {
  const { getLedger, authority, runnerIO, ticker } = ctx;
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
    { res.end(); return true; }
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
  if (!STORE_INDEX_URL) { installPage(res, 503, "스토어가 설정되지 않았습니다", "RELAY_STORE_INDEX 를 설정한 뒤 다시 시도하세요."); return true; }
  if (!ref || !ticket) { installPage(res, 400, "설치 링크가 올바르지 않습니다", "스토어의 내 서재에서 다시 눌러 주세요."); return true; }
  try {
    const idx = await fetchStoreIndex(STORE_INDEX_URL);
    const entry = idx.entries.find((e) => e.ref === ref);
    if (!entry) { installPage(res, 404, "스토어에 없는 패키지입니다", ref); return true; }
    // 링크가 가리키는 판과 인덱스의 판이 어긋나면 멈춘다 — 낡은 링크로 엉뚱한 봉인을
    // 대조하다 실패하느니, 무엇이 어긋났는지 말해 주는 편이 낫다
    if (want && want !== entry.version) {
      { installPage(res, 409, "새 판이 나왔습니다", `링크는 ${want}, 스토어는 ${entry.version} 입니다. 내 서재에서 다시 눌러 주세요.`); return true; }
    }
    const abs = await redeemWithTicket(STORE_INDEX_URL, entry, ticket);
    const prep = prepareArtifact(getLedger(), abs, { digest: entry.digest, registry: STORE_INDEX_URL });
    prepared.set(prep.id, { p: prep, at: Date.now() });
    for (const [id, v] of prepared) if (Date.now() - v.at > PREPARE_TTL) prepared.delete(id);
    { consentPage(res, prep); return true; }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const code = e instanceof RedeemError ? 410 : 500;
    { installPage(res, code, "설치를 시작하지 못했습니다", msg); return true; }
  }
}
if (p === "/store/install/confirm" && req.method === "POST") {
  const b = await readBody(req);
  const held = prepared.get(String(b.id ?? ""));
  if (!held || Date.now() - held.at > PREPARE_TTL) {
    { installPage(res, 410, "준비가 만료되었습니다", "스토어의 내 서재에서 다시 눌러 주세요."); return true; }
  }
  prepared.delete(held.p.id);
  try {
    const r = activatePrepared(getLedger(), held.p);
    { installPage(res, 200, `${held.p.manifest.display_name ?? held.p.name} 설치 완료`, `${r.name} 로 설치되었습니다. 콘솔에서 바로 쓸 수 있습니다.`, true); return true; }
  } catch (e) {
    { installPage(res, 500, "설치에 실패했습니다", e instanceof Error ? e.message : String(e)); return true; }
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
  { json(res, 200, { entries, remote: STORE_INDEX_URL || null, remote_error: remoteError, buy }); return true; }
}
// 마켓 선반의 이미지 자산(아이콘 사본)만. 아티팩트 자체는 서빙하지 않는다 — 설치는 서버 로컬 경로로
const marketAsset = p.match(/^\/market\/asset\/([A-Za-z0-9._-]+)$/);
if (marketAsset && req.method === "GET") {
  if (!/\.(svg|png|jpe?g|webp|gif|avif)$/i.test(marketAsset[1])) { json(res, 404, { error: "이미지 자산만 서빙합니다" }); return true; }
  const file = path.join(artifactsDir(), marketAsset[1]);
  if (!fs.existsSync(file)) { json(res, 404, { error: "없는 자산" }); return true; }
  { streamFile(file, res); return true; }
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
  if (!fs.existsSync(file)) { json(res, 404, { error: "선반에 없는 봉투 — 먼저 구우세요" }); return true; }
  res.writeHead(200, {
    "content-type": "application/octet-stream",
    "content-length": String(fs.statSync(file).size),
    "content-disposition": `attachment; filename="${exportFile[1]}"`,
  });
  { fs.createReadStream(file).pipe(res); return true; }
}
if (p === "/store/import" && req.method === "GET") { importPage(res); return true; }
if (p === "/store/import" && req.method === "POST") {
  // 몸통이 곧 봉투 바이트다 — multipart 를 파싱하지 않으려고 raw 로 받는다
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_IMPORT) { json(res, 413, { error: "봉투가 너무 큽니다 (200MB 상한)" }); return true; }
    chunks.push(c as Buffer);
  }
  if (!size) { json(res, 400, { error: "빈 파일입니다" }); return true; }
  const tmp = path.join(stageDir("import"), `${Date.now()}.relay`);
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  try {
    const prep = prepareArtifact(getLedger(), tmp);
    prepared.set(prep.id, { p: prep, at: Date.now() });
    { json(res, 200, { id: prep.id }); return true; }
  } catch (e) {
    { json(res, 400, { error: e instanceof Error ? e.message : String(e) }); return true; }
  } finally {
    fs.rmSync(tmp, { force: true }); // 전개는 릴리스 자리에 끝났다 — 임시 봉투는 남길 이유가 없다
  }
}
// 준비된 설치의 동의 관문을 id 로 다시 연다 (가져오기가 쓴다 — 스토어 경로는 곧장 그린다)
if (p === "/store/install/consent" && req.method === "GET") {
  const held = prepared.get(url.searchParams.get("id") ?? "");
  if (!held || Date.now() - held.at > PREPARE_TTL) {
    { installPage(res, 410, "준비가 만료되었습니다", "봉투를 다시 열어 주세요."); return true; }
  }
  { consentPage(res, held.p, true); return true; }
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
      if (!entry) { json(res, 404, { error: `스토어에 없는 패키지: ${ref}` }); return true; }
      const paidCache = entry.price != null && !entry.url ? cacheHit(entry.digest) : null;
      const ticket = b.ticket ? String(b.ticket) : null;
      if (ticket) {
        // 티켓 설치 — 웹에서 로그인한 사람이 끊어 준 1회용 통행증.
        // 무료·유료를 가리지 않는다: 자격 판단은 스토어에서 이미 끝났고,
        // 여기서는 봉인 대조만 남는다 (키를 대신하는 새 경로)
        try {
          abs = await redeemWithTicket(STORE_INDEX_URL, entry, ticket);
        } catch (e) {
          if (e instanceof RedeemError) { json(res, 410, { error: e.message, ref: entry.ref }); return true; }
          throw e;
        }
      } else if (paidCache) {
        // 이미 받은 봉투는 내 것 — 키를 묻지 않는다. 키를 묻는 순간부터는 반드시 검증한다
        abs = paidCache;
      } else if (entry.price != null && !entry.url) {
        // 유료 — 키가 다운로드의 문을 연다. 키는 vault 에 앉아 재설치 때 다시 묻지 않는다
        const key = (b.key ? String(b.key) : null) ?? await authority.credential(`store-key/${entry.ref}`);
        if (!key) {
          { json(res, 402, { error: `유료 패키지입니다 (₩${entry.price.toLocaleString()})`, need_key: true, ref: entry.ref, price: entry.price }); return true; }
        }
        try {
          abs = await redeemArtifact(STORE_INDEX_URL, idx.redeem, entry, key);
        } catch (e) {
          if (e instanceof RedeemError) {
            { json(res, 402, { error: e.message, need_key: true, ref: entry.ref, price: entry.price }); return true; }
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
      { json(res, 404, { error: `선반에 없는 패키지: ${ref} (스토어 미설정)` }); return true; }
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
  { json(res, 200, { ...rest, display_name: prep.manifest.display_name }); return true; }
}
if (p === "/install/activate" && req.method === "POST") {
  const b = await readBody(req);
  const held = prepared.get(String(b.id ?? ""));
  if (!held || Date.now() - held.at > PREPARE_TTL) {
    { json(res, 410, { error: "만료된 준비입니다 — 설치를 처음부터 다시 시작하세요" }); return true; }
  }
  prepared.delete(held.p.id);
  const l = getLedger();
  const r = activatePrepared(l, held.p, { workspace: b.workspace ? String(b.workspace) : undefined });
  stopServices(held.p.name); // 업데이트라면 옛 릴리스 코드로 떠 있다 — 새 스냅샷으로 갈아탄다
  const rio = runnerIO(l);
  const notes = [...startServices(l, held.p.name, held.p.dir, held.p.manifest, rio), ...startChannels(l, held.p.name, held.p.dir, held.p.manifest, rio)];
  ticker.emit(held.p.fresh ? "relay.package.installed" : "relay.package.published", { pkg: held.p.name, version: held.p.version });
  { json(res, 200, { name: r.name, fresh: held.p.fresh, version: held.p.version, setup: r.setup ?? null, build: r.build ?? null, services: notes }); return true; }
}
  return false;
}

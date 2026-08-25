// shell.ts — 전역 셸. 사이드바(크롬)와 홈(앱 런처) 둘 다 **기판의 것**이다: 어느 패키지의
// 소유물도 아니므로 콘솔 패키지(system)도 이 셸 안에 앉는 여러 앱 중 하나로 선다.
//
//   · 사이드바 — 기판이 서빙하는 모든 view 문서에 스크립트 한 줄로 심긴다(view.ts serveViewFile·
//     대화 폴백·판정 실패 화면). 패키지 트리는 크롬을 모른 채 남는다.
//   · 홈 — "/" 가 내는 빈 문서(#relay-home)에 같은 스크립트가 런처를 그린다. 설치된 앱을
//     늘어놓는 화면은 앱 하나의 화면이 아니므로 패키지에 두지 않는다.
//
// 구조는 relayos deployd 의 글로벌 바(portalbar.go)와 같은 결이다. 거기서 실증된 규약 셋을 딛는다:
//   ① 주입은 서빙층 1점 — 패키지 협조 불요, 재발행 불요.
//   ② top 문서 전용 — iframe(프리뷰·임베드) 안에서는 스스로 그리지 않는다. 임베더가 view 를
//      끼워 넣은 화면에 남의 사이드바가 끼어들면 안 된다.
//   ③ 치수 계약 — 크롬이 자기 폭을 :root --relay-side 로 선언하고 body 를 그만큼 민다
//      (바는 높이였고 사이드바는 폭이다). 접히면 선언값이 줄 뿐이라 문서는 변수 하나만 본다.
//
// 판정(무슨 얼굴인가·어디로 가는가)은 **여기 서버 쪽**에 있다. 스크립트는 /shell/nav 가 준
// 항목을 그리기만 한다 — 마운트 문법(/pkg/…)도 얼굴 규칙도 클라가 조립하지 않는다
// (client-protocol §2-6 과 같은 규율). 콘솔 화면도 같은 응답을 읽어 판정이 갈라지지 않는다.
import { STORE_INDEX_URL, type Ledger } from "../supply/ledger.ts";
import { loadManifest, landingAgentName, type Manifest } from "../supply/manifest.ts";

/** 콘솔 패키지 — 사용자가 아니라 기판이 아는 이름이다. 화면 없는 얼굴(상주·부품)과 저작은
 *  이 패키지의 페이지로 간다: 기판은 문이고, 관리 화면은 패키지다. */
const CONSOLE = "system";
const consoleHref = (rest = ""): string => `/pkg/${CONSOLE}/view/${rest}`;

export type Face = "view" | "chat" | "live" | "parts";

export interface ShellItem {
  pkg: string;
  label: string;
  /** 런처 카드의 한 줄 소개 — 매니페스트 description */
  description: string;
  version: string;
  /** 대표 아이콘 주소 — 미선언이면 null(스크립트가 글자 아바타로 문다) */
  icon: string | null;
  /** 지배 얼굴 — 글리프와 클릭 행동을 정하는 하나 */
  face: Face;
  /** 이 패키지가 실제로 가진 얼굴 전부 — 콘솔의 얼굴 탭이 이걸 읽는다.
   *  판정이 화면 쪽에 복제되지 않도록, 얼굴에 관한 답은 전부 이 응답이 싣는다 */
  faces: Face[];
  /** 클릭 목적지 — 마운트 문법을 아는 쪽이 조립한다 */
  href: string;
  /** 기판이 서빙하는 화면·대화 문서. 그 얼굴이 없으면 null */
  view: string | null;
  /** 권한 화면 — 항목의 보조 진입(호버 ⋯). 지배 얼굴이 무엇이든 여기로는 갈 수 있다 */
  detail: string;
  /** 지금 떠 있는 자식이 하나라도 있는가 — 상주 상태점 */
  resident: boolean;
  ring0: boolean;
  /** 판정 실패한 설치 — 런처가 사유를 배지로 낸다 */
  error: string | null;
}

export interface ShellNav {
  items: ShellItem[];
  /** 고정 목적지 — 스크립트가 주소를 조립하지 않도록 기판이 다 싣는다 */
  home: string;
  create: string;
  importer: string;
  /** 스토어 웹 주소 — 이 기판에 스토어 연결이 켜져 있을 때만. OSS 기본(연결 없음)은 null 이라
   *  항목 자체가 그려지지 않는다 — "마켓의 문은 여는 쪽이 연다"는 중립 설계가 사이드바에도 그대로 선다 */
  store: string | null;
}

/**
 * 얼굴 판정 — 항목의 글리프와 클릭 행동을 정한다. 우선순위는 "사람이 이 패키지를 열면 무엇을
 * 기대하는가" 순이다: 화면 > 대화 > 상주 > 부품.
 *
 * 대화 얼굴이 화면과 같은 주소로 가는 이유: 화면 없는 패키지에 전체 화면 대화를 세우는 것은
 * 이미 serveView 의 판정이다. 얼굴이 둘이어도 문은 하나다.
 *
 * 서비스 중 상주로 세는 것은 **source 선언**뿐이다 — 실제로 스폰되는 형이 그것뿐이기 때문이다
 * (services.ts startServices: dir 은 폴더를 만들고 끝, url·api 는 밖으로 나가는 문이라 띄울 것이
 * 없다). 이 술어가 어긋나면 폴더 하나 선언한 패키지가 "상주"로 서고, 그 화면에는 도는 것이
 * 하나도 없다.
 */
export function facesOf(m: Manifest): Face[] {
  const all: Face[] = [];
  if (m.surfaces?.view) all.push("view");
  if (landingAgentName(m)) all.push("chat");
  const spawned = (m.services ?? []).filter((s) => "source" in s && s.source != null);
  if ((m.surfaces?.channels ?? []).length || (m.triggers ?? []).length || spawned.length) all.push("live");
  return all.length ? all : ["parts"];
}

function hrefFor(pkg: string, face: Face): string {
  // 화면·대화는 기판이 직접 서빙하는 문서다. 상주·부품은 서빙할 문서가 없으므로 콘솔 패키지의
  // 페이지로 간다 — 기판이 UI 를 굽지 않는다는 규율(굽는 것은 대화 폴백과 이 셸 두 장뿐)
  if (face === "view" || face === "chat") return `/pkg/${encodeURIComponent(pkg)}/view/`;
  return consoleHref(`?p=${encodeURIComponent(pkg)}&face=${face === "live" ? "live" : "detail"}`);
}

/** 사이드바와 런처가 그릴 전부. running = 지금 떠 있는 자식 키(<패키지>/<이름>) */
export function shellNav(ledger: Ledger, running: string[]): ShellNav {
  const live = new Set(running.map((k) => k.split("/")[0]));
  const items: ShellItem[] = [];
  for (const [pkg, rec] of Object.entries(ledger.packages)) {
    const base = {
      pkg,
      href: hrefFor(pkg, "parts"),
      detail: hrefFor(pkg, "parts"),
      resident: live.has(pkg),
      ring0: rec.ring === 0,
    };
    let m: Manifest;
    try {
      m = loadManifest(rec.path);
    } catch (e) {
      // 판정 실패한 설치 — 목록에서 지우면 "왜 안 보이지" 가 되고 진단은 어디에도 없다.
      // 이름만으로 세우고 사유를 실어 상세로 보낸다(그 화면이 처방을 그린다)
      items.push({ ...base, label: pkg, description: "", version: "", icon: null, face: "parts", faces: ["parts"], view: null, error: String(e) });
      continue;
    }
    const faces = facesOf(m);
    const face = faces[0];
    items.push({
      ...base,
      label: m.display_name || pkg,
      description: m.description ?? "",
      version: m.version ?? "",
      icon: m.icon ? `/pkg/${encodeURIComponent(pkg)}/asset/${m.icon}` : null,
      face,
      faces,
      href: hrefFor(pkg, face),
      view: face === "view" || face === "chat" ? `/pkg/${encodeURIComponent(pkg)}/view/` : null,
      error: null,
    });
  }
  items.sort((a, b) => a.label.localeCompare(b.label, "ko"));
  // 인덱스 주소에서 웹 주소를 얻는 규칙은 데스크톱 앱(daemon.rs store_web)과 같다
  const store = STORE_INDEX_URL ? STORE_INDEX_URL.replace(/\/index\.json$/, "/") : null;
  return { items, home: "/", create: consoleHref("studio/?new=1"), importer: "/store/import", store };
}

/** 문서 말미에 스크립트 한 줄. </body> 부재(손저작 단일 HTML)면 append — injectPortalBar 와 같은 관례 */
const SHELL_TAG = `<script src="/shell.js" defer></script>`;
export function injectShell(html: string): string {
  const i = html.lastIndexOf("</body>");
  return i >= 0 ? html.slice(0, i) + SHELL_TAG + html.slice(i) : html + SHELL_TAG;
}

/**
 * 셸 홈 문서 — 빈 칸 하나. 런처는 사이드바와 **같은 스크립트**가 같은 nav 로 그린다(두 화면이
 * 같은 목록을 다르게 판정하는 일이 생기지 않는다). 기판이 굽는 유일한 UI 문서이고, 그래야 하는
 * 이유는 이 화면의 주어가 앱 하나가 아니라 **설치된 것 전부**이기 때문이다 — 어느 패키지의
 * 화면도 아니다.
 */
export const HOME_DOC = injectShell(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay</title><link rel="icon" href="/pkg/${CONSOLE}/view/icon.svg">
</head><body><div id="relay-home"></div></body></html>`);

// ── 사이드바·런처 본체(외부 자산 0) ────────────────────────────────────────
// 색은 패키지 문서의 팔레트를 빌리지 않는다 — 남의 토큰에 얹으면 패키지마다 다른 크롬이 된다.
// 자기 값을 들고, 폭만 --relay-side 로 밖에 공개한다(치수 계약).
export const SHELL_JS = String.raw`(function(){
if (window.__relayShell) return; window.__relayShell = 1;
try { if (window.self !== window.top) return; } catch (e) { return; }

var W = 248, RAIL = 56, KEY = "relay-shell-collapsed";
var collapsed = false;
try { collapsed = localStorage.getItem(KEY) === "1"; } catch (e) {}
if (window.matchMedia("(max-width: 900px)").matches) collapsed = true;

var GLYPH = {
  view: '<rect x="1.5" y="2.5" width="11" height="8" rx="1"/><path d="M5 12.5h4"/>',
  chat: '<path d="M2 3.5A1.5 1.5 0 0 1 3.5 2h7A1.5 1.5 0 0 1 12 3.5v4A1.5 1.5 0 0 1 10.5 9H6l-3 3V9h-.5A1.5 1.5 0 0 1 2 7.5z"/>',
  live: '<circle cx="7" cy="7" r="5.5"/><path d="M7 4v3l2 1.5"/>',
  parts: '<path d="M5 2v3M9 2v3M4 5h6v3a3 3 0 0 1-6 0zM7 11v2"/>'
};
var FACE_KO = { view: "화면", chat: "대화", live: "상주", parts: "부품" };
var ICONS = {
  home: '<path d="M2.5 7.5 8 2.5l5.5 5v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  store: '<path d="M3 5.5h10l-.7 7a1 1 0 0 1-1 .9H4.7a1 1 0 0 1-1-.9zM5.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  down: '<path d="M8 3v8M4.5 7.5 8 11l3.5-3.5"/>',
  fold: '<path d="M6 3.5 2.5 8 6 12.5M13 8H3"/>',
  unfold: '<path d="M10 3.5 13.5 8 10 12.5M3 8h10"/>'
};
function svg(d, cls){ return '<svg class="' + (cls||"") + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' + d + '</svg>'; }
function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

var home = document.getElementById("relay-home");

var css = [
':root{--relay-side:' + (collapsed ? RAIL : W) + 'px}',
'body{margin-left:var(--relay-side);transition:margin-left .16s ease}',
'#rlys{position:fixed;top:0;left:0;bottom:0;width:var(--relay-side);z-index:2147482990;display:flex;flex-direction:column;gap:2px;padding:10px 8px;box-sizing:border-box;background:#fff;border-right:1px solid #e6e9ec;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Segoe UI",sans-serif;color:#16181b;overflow:hidden;transition:width .16s ease}',
'#rlys *{box-sizing:border-box}',
'#rlys .hd{display:flex;align-items:center;gap:8px;padding:8px 8px 12px;font-weight:700;white-space:nowrap}',
'#rlys .hd .bd{width:7px;height:7px;border-radius:50%;background:#059669;flex:none}',
'#rlys .hd .fold{margin-left:auto;width:24px;height:24px;border:none;background:none;color:#98a1aa;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;flex:none}',
'#rlys .hd .fold:hover{background:#eef0f2;color:#5c6570}',
'#rlys .hd .fold svg{width:14px;height:14px}',
'#rlys .lb{font-size:11px;font-weight:700;color:#98a1aa;text-transform:uppercase;letter-spacing:.04em;padding:12px 10px 6px;white-space:nowrap}',
'#rlys .gp{display:flex;flex-direction:column;gap:1px}',
'#rlys .pk{overflow-y:auto;overflow-x:hidden;min-height:0;flex:0 1 auto}',
'#rlys .sp{flex:1 1 auto;min-height:8px}',
'#rlys .ft{border-top:1px solid #eef0f2;padding-top:6px}',
'#rlys a.it,#rlys button.it{display:flex;align-items:center;gap:9px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer;white-space:nowrap}',
'#rlys .rw{position:relative;display:flex;align-items:center}',
'#rlys .rw .mo{position:absolute;right:4px;width:22px;height:22px;display:none;align-items:center;justify-content:center;border-radius:6px;color:#98a1aa;text-decoration:none;font:600 13px/1 inherit;background:#fff}',
'#rlys .rw:hover .mo{display:inline-flex}',
'#rlys .rw .mo:hover{background:#eef0f2;color:#16181b}',
'#rlys .it:hover{background:#eef0f2}',
'#rlys .it.on{background:rgba(13,148,136,.1);color:#115e59;font-weight:600}',
'#rlys .it .ic{width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:#5c6570;border-radius:5px;overflow:hidden}',
'#rlys .it.on .ic{color:#0f766e}',
'#rlys .it .ic svg{width:15px;height:15px}',
'#rlys .it .ic img{width:18px;height:18px;border-radius:4px;object-fit:cover;display:block}',
'#rlys .it .ic.ltr{background:#eef0f2;font:700 11px inherit;color:#5c6570}',
'#rlys .it .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
'#rlys .it .fc{width:13px;height:13px;flex:none;color:#98a1aa;stroke-width:1.4}',
'#rlys .it .dt{width:7px;height:7px;border-radius:50%;background:#059669;flex:none}',
'#rlys .er{font-size:11.5px;color:#c0392b;padding:8px 10px;white-space:normal}',
'#rlys .em{font-size:12px;color:#98a1aa;padding:8px 10px}',
// 접힌 레일 — 글자를 지우고 아이콘만 남긴다. 폭 계약이 같이 줄어드니 문서는 따라온다
'#rlys.cl .nm,#rlys.cl .lb,#rlys.cl .fc,#rlys.cl .hd span,#rlys.cl .em,#rlys.cl .er{display:none}',
'#rlys.cl a.it,#rlys.cl button.it{justify-content:center;padding:7px 0;position:relative}',
'#rlys.cl .hd{padding:8px 0 12px;justify-content:center}',
'#rlys.cl .hd .fold{margin:0}',
'#rlys.cl .it .dt{position:absolute;right:6px;bottom:6px}',
// ── 홈(런처) ─────────────────────────────────────────────────────────────
'#relay-home{min-height:100vh;background:#f5f6f7;color:#16181b;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Segoe UI",sans-serif}',
'#relay-home *{box-sizing:border-box}',
'#relay-home .hh{display:flex;align-items:baseline;gap:10px;padding:14px 20px;background:#fff;border-bottom:1px solid #e6e9ec}',
'#relay-home .hh h1{margin:0;font-size:15px}',
'#relay-home .hh .mt{font-size:11.5px;color:#98a1aa}',
'#relay-home .hh .rt{margin-left:auto;display:flex;gap:8px}',
'#relay-home .bt{border:1px solid #e6e9ec;background:#fff;color:#16181b;border-radius:8px;padding:6px 12px;font:600 12.5px inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px}',
'#relay-home .bt:hover{background:#eef0f2}',
'#relay-home .bt.ac{background:#0f766e;border-color:#0f766e;color:#fff}',
'#relay-home .bt.ac:hover{background:#115e59}',
'#relay-home .gr{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:12px;padding:18px 20px}',
'#relay-home .cd{background:#fff;border:1px solid #e6e9ec;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
'#relay-home .cd:hover{border-color:#0f766e}',
'#relay-home .cd .go{display:flex;flex-direction:column;gap:8px;text-decoration:none;color:inherit}',
'#relay-home .cd .tp{display:flex;align-items:center;gap:10px}',
'#relay-home .cd .av{width:30px;height:30px;border-radius:8px;flex:none;display:inline-flex;align-items:center;justify-content:center;background:#eef0f2;font:700 13px inherit;color:#5c6570;overflow:hidden}',
'#relay-home .cd .av img{width:30px;height:30px;object-fit:cover;display:block}',
'#relay-home .cd .nm{flex:1 1 auto;min-width:0}',
'#relay-home .cd b{display:block;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'#relay-home .cd .ver{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#98a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'#relay-home .cd p{margin:0;font-size:12.5px;color:#5c6570;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}',
'#relay-home .cd .ft{display:flex;align-items:center;gap:6px}',
'#relay-home .cd .cp{font-size:11px;font-weight:600;color:#5c6570;background:#eef0f2;border-radius:6px;padding:1px 7px}',
'#relay-home .cd .cp.er{color:#c0392b;background:#fdf2f1}',
'#relay-home .cd .dt{width:7px;height:7px;border-radius:50%;background:#059669;flex:none}',
'#relay-home .cd .sp{flex:1}',
'#relay-home .cd .mo{border:1px solid #e6e9ec;background:#fff;color:#5c6570;border-radius:7px;padding:3px 9px;font:600 11.5px inherit;text-decoration:none}',
'#relay-home .cd .mo:hover{background:#eef0f2;color:#16181b}',
'#relay-home .ep{margin:18px 20px;background:#fff;border:1px solid #e6e9ec;border-radius:12px;padding:22px;text-align:center}',
'#relay-home .ep h2{margin:0 0 4px;font-size:14px}',
'#relay-home .ep p{margin:0 0 14px;font-size:12.5px;color:#98a1aa}',
'@media print{#rlys{display:none}body{margin-left:0}}'
].join("");
var style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

var el = document.createElement("nav");
el.id = "rlys";
el.setAttribute("aria-label", "설치된 에이전트");
if (collapsed) el.className = "cl";
document.body.appendChild(el);

function setCollapsed(v){
  collapsed = v;
  el.className = v ? "cl" : "";
  document.documentElement.style.setProperty("--relay-side", (v ? RAIL : W) + "px");
  try { localStorage.setItem(KEY, v ? "1" : "0"); } catch (e) {}
}

// 지금 어느 패키지에 서 있는가 — 좌표는 기판이 주입한다(§2-6). 콘솔 위에서는 그 페이지가
// 보고 있는 패키지(?p=)가 곧 현재 항목이다
function current(){
  try {
    var p = new URLSearchParams(location.search).get("p");
    if (p) return p;
  } catch (e) {}
  return (window.__RELAY_CONTEXT || {}).instanceId || "";
}
function onHome(){
  try { return location.pathname === "/" || location.pathname === ""; } catch (e) { return false; }
}

function item(href, iconHtml, label, opts){
  opts = opts || {};
  var a = document.createElement("a");
  a.className = "it" + (opts.on ? " on" : "");
  a.href = href;
  a.title = opts.title || label;
  a.innerHTML = '<span class="ic' + (opts.letter ? " ltr" : "") + '">' + iconHtml + '</span>' +
    '<span class="nm">' + esc(label) + '</span>' +
    (opts.face ? '<svg class="fc" viewBox="0 0 14 14" fill="none" stroke="currentColor" aria-label="' + FACE_KO[opts.face] + '">' + GLYPH[opts.face] + '</svg>' : "") +
    (opts.dot ? '<span class="dt" title="도는 중"></span>' : "");
  return a;
}

function renderSide(nav, err){
  var here = current();
  el.textContent = "";

  var hd = document.createElement("div");
  hd.className = "hd";
  hd.innerHTML = '<span class="bd"></span><span>Relay</span>';
  var fold = document.createElement("button");
  fold.type = "button";
  fold.className = "fold";
  fold.setAttribute("aria-label", collapsed ? "사이드바 펼치기" : "사이드바 접기");
  fold.innerHTML = svg(collapsed ? ICONS.unfold : ICONS.fold);
  fold.onclick = function(){ setCollapsed(!collapsed); renderSide(nav, err); };
  hd.appendChild(fold);
  el.appendChild(hd);

  var top = document.createElement("div");
  top.className = "gp";
  top.appendChild(item(nav ? nav.home : "/", svg(ICONS.home), "홈", { on: onHome(), title: "홈 — 설치된 앱" }));
  // 스토어 — 이 기판에 스토어 연결이 켜져 있을 때만 서버가 주소를 싣는다 (OSS 기본은 없음)
  if (nav && nav.store) {
    top.appendChild(item(nav.store, svg(ICONS.store), "스토어", { title: "스토어 — 에이전트 마켓플레이스" }));
  }
  el.appendChild(top);

  if (err) {
    var e = document.createElement("div");
    e.className = "er";
    e.textContent = err;
    el.appendChild(e);
  }

  if (nav) {
    var lb = document.createElement("div");
    lb.className = "lb";
    lb.textContent = "설치된 것";
    el.appendChild(lb);

    var pk = document.createElement("div");
    pk.className = "gp pk";
    if (!nav.items.length) {
      var em = document.createElement("div");
      em.className = "em";
      em.textContent = "설치된 패키지가 없습니다";
      pk.appendChild(em);
    }
    for (var i = 0; i < nav.items.length; i++) {
      var it = nav.items[i];
      var ic = it.icon ? '<img src="' + esc(it.icon) + '" alt="">' : esc((it.label.trim()[0] || "?").toUpperCase());
      var rw = document.createElement("div");
      rw.className = "rw";
      rw.appendChild(item(it.href, ic, it.label, {
        on: it.pkg === here,
        face: it.face,
        dot: it.resident,
        letter: !it.icon,
        title: it.pkg + (it.ring0 ? " · ring-0" : "") + " — " + FACE_KO[it.face]
      }));
      // 보조 진입 — 지배 얼굴이 화면이어도 권한 화면으로는 갈 수 있어야 한다
      if (!collapsed) {
        var mo = document.createElement("a");
        mo.className = "mo";
        mo.href = it.detail;
        mo.title = it.label + " 상세(권한 화면)";
        mo.setAttribute("aria-label", it.label + " 상세");
        mo.textContent = "⋯";
        rw.appendChild(mo);
      }
      pk.appendChild(rw);
    }
    el.appendChild(pk);
  }

  var sp = document.createElement("div");
  sp.className = "sp";
  el.appendChild(sp);

  var ft = document.createElement("div");
  ft.className = "gp ft";
  if (nav) {
    ft.appendChild(item(nav.create, svg(ICONS.plus), "패키지 만들기"));
    ft.appendChild(item(nav.importer, svg(ICONS.down), "불러오기", { title: "누군가에게 받은 에이전트 파일을 엽니다" }));
  }
  el.appendChild(ft);
}

// ── 홈(런처) — 사이드바와 같은 nav 를 그린다 ───────────────────────────────
function renderHome(nav, err){
  if (!home) return;
  home.textContent = "";
  var hh = document.createElement("div");
  hh.className = "hh";
  hh.innerHTML = '<h1>홈</h1><span class="mt">' + (nav ? "설치된 에이전트 패키지 " + nav.items.length + "개" : "불러오는 중…") + '</span>';
  if (nav) {
    var rt = document.createElement("div");
    rt.className = "rt";
    rt.innerHTML = '<a class="bt" href="' + esc(nav.importer) + '">불러오기</a>' +
      '<a class="bt ac" href="' + esc(nav.create) + '">패키지 만들기</a>';
    hh.appendChild(rt);
  }
  home.appendChild(hh);

  if (err) {
    var e = document.createElement("div");
    e.className = "ep";
    e.innerHTML = '<h2>설치 목록을 읽지 못했습니다</h2><p>' + esc(err) + '</p>';
    home.appendChild(e);
    return;
  }
  if (!nav) return;

  if (!nav.items.length) {
    var ep = document.createElement("div");
    ep.className = "ep";
    ep.innerHTML = '<h2>아직 설치된 패키지가 없습니다</h2>' +
      '<p>직접 만들거나, 누군가에게 받은 봉투를 열어 시작합니다.</p>' +
      '<a class="bt ac" href="' + esc(nav.create) + '">패키지 만들기</a> ' +
      '<a class="bt" href="' + esc(nav.importer) + '">불러오기</a>';
    home.appendChild(ep);
    return;
  }

  var gr = document.createElement("div");
  gr.className = "gr";
  for (var i = 0; i < nav.items.length; i++) {
    var it = nav.items[i];
    var av = it.icon ? '<img src="' + esc(it.icon) + '" alt="">' : esc((it.label.trim()[0] || "?").toUpperCase());
    var cd = document.createElement("div");
    cd.className = "cd";
    cd.innerHTML =
      '<a class="go" href="' + esc(it.href) + '">' +
        '<span class="tp">' +
          '<span class="av">' + av + '</span>' +
          '<span class="nm"><b>' + esc(it.label) + '</b>' +
            '<span class="ver">' + esc(it.pkg) + (it.version ? "@" + esc(it.version) : "") + '</span>' +
          '</span>' +
          (it.resident ? '<span class="dt" title="도는 중"></span>' : "") +
        '</span>' +
        '<p>' + esc(it.description) + '</p>' +
      '</a>' +
      '<div class="ft">' +
        '<span class="cp">' + FACE_KO[it.face] + '</span>' +
        (it.error ? '<span class="cp er">검사 실패</span>' : "") +
        '<span class="sp"></span>' +
        '<a class="mo" href="' + esc(it.detail) + '">상세</a>' +
      '</div>';
    gr.appendChild(cd);
  }
  home.appendChild(gr);
}

renderSide(null, null);
renderHome(null, null);
fetch("/shell/nav", { cache: "no-store" })
  .then(function(r){ return r.ok ? r.json() : r.json().then(function(d){ throw new Error(d && d.error || ("HTTP " + r.status)); }); })
  .then(function(nav){ renderSide(nav, null); renderHome(nav, null); })
  .catch(function(e){
    // 사이드바는 편의 크롬이라 문서를 죽이지 않는다. 다만 침묵하지도 않는다 —
    // 홈은 그 목록이 곧 내용이므로 실패가 화면의 본문이 된다
    var msg = "설치 목록을 읽지 못했습니다: " + (e && e.message || e);
    renderSide(null, msg);
    renderHome(null, msg);
  });
})();`;

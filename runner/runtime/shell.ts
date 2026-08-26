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
import { STORE_INDEX_URL, consoleInstall, type Ledger } from "../supply/ledger.ts";
import { loadManifest, landingAgentName, type Manifest } from "../supply/manifest.ts";
import { fetchStoreIndex } from "../supply/registry.ts";

/** 콘솔 패키지 — 사용자가 아니라 기판이 아는 이름이다. 화면 없는 얼굴(상주·부품)과 저작은
 *  이 패키지의 페이지로 간다: 기판은 문이고, 관리 화면은 패키지다. 설치 이름은 장부가 답한다
 *  (ledger.ts consoleInstall — 1인 기판 `system`, 임베더는 다를 수 있다) */
const consoleHref = (ledger: Ledger, rest = ""): string => `/pkg/${encodeURIComponent(consoleInstall(ledger))}/view/${rest}`;

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
  /** 스토어에 더 새 판이 있으면 그 버전 — 홈이 새 판 배지를 그린다. 스토어 미연결(OSS 기본)·
   *  최신·인덱스 미도착이면 null 이라 아무것도 그려지지 않는다 */
  update: string | null;
  /** 도는 판 위에 적용하지 않은 수정이 있다 — 작업 사본이 앞서 있다. 카드가 "수정 중" 으로 낸다 */
  editing: boolean;
}

/** 초안(작업 사본) 한 줄 — supply/draft.ts listDrafts 의 모양. 데몬이 읽어 넘긴다 */
export interface DraftEntry {
  name: string;
  version: string | null;
  changes: number;
  installed: boolean;
}

export interface ShellNav {
  items: ShellItem[];
  /** 고정 목적지 — 스크립트가 주소를 조립하지 않도록 기판이 다 싣는다 */
  home: string;
  importer: string;
  /** 스튜디오 시작 화면 — 만드는 중인 초안 목록이 여기 있다 */
  /** 발행 전 초안 — 장부에 없어 카드로는 서지 않지만, 어느 화면에도 없으면 만들다 만 것이 잃은
   *  것처럼 보인다. href 는 그 초안을 여는 스튜디오 주소(마운트 문법은 기판이 조립한다) */
  drafts: { name: string; version: string | null; changes: number; href: string }[];
  /** 스토어 웹 주소 — 이 기판에 스토어 연결이 켜져 있을 때만. OSS 기본(연결 없음)은 null 이라
   *  항목 자체가 그려지지 않는다 — "마켓의 문은 여는 쪽이 연다"는 중립 설계가 사이드바에도 그대로 선다 */
  store: string | null;
  /** 스토어 내 서재 주소 — 새 판 배지의 업데이트 버튼이 여기로 간다. 설치 티켓은 서재가
   *  발급하므로(로그인 세션) 기판이 관문을 새로 만들지 않는다. store 와 같은 조건으로 null */
  library: string | null;
  /** 크롬의 얼굴 — 이름·마크·강조색 셋만(additive, 2026-08-26). 미선언 = "Relay" 와 기본 색.
   *  임베더(조직 기판)가 자기 브랜딩을 싣는 자리다. 팔레트 전체는 열지 않는다 — 크롬은 남의
   *  토큰에 얹지 않는다는 규율(③)과 양립하는 최소 셋이다 */
  brand?: ShellBrand;
}

export interface ShellBrand {
  name: string;
  /** 마크 이미지 주소 — null 이면 이름만 */
  logo: string | null;
  /** 강조색(CSS 색) — null 이면 기본 */
  accent: string | null;
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

function hrefFor(ledger: Ledger, pkg: string, face: Face): string {
  // 화면·대화는 기판이 직접 서빙하는 문서다. 상주·부품은 서빙할 문서가 없으므로 콘솔 패키지의
  // 페이지로 간다 — 기판이 UI 를 굽지 않는다는 규율(굽는 것은 대화 폴백과 이 셸 두 장뿐)
  if (face === "view" || face === "chat") return `/pkg/${encodeURIComponent(pkg)}/view/`;
  return consoleHref(ledger, `?p=${encodeURIComponent(pkg)}&face=${face === "live" ? "live" : "detail"}`);
}

/** semver 앞섬 판정 — a 가 b 보다 새 판인가. 프리릴리스 꼬리는 무시한다(등재 실측이 x.y.z) */
function newerVersion(a: string, b: string): boolean {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** 스토어 인덱스에서 ref→최신 버전 지도를 뜬다 — 홈 렌더를 원격 왕복에 저당잡히지 않도록
 *  짧은 상한을 걸고, 늦으면 배지 없이 그린다(인덱스 캐시가 5분이라 다음 렌더에는 실린다).
 *  원격 실패는 홈을 죽이지 않는다 — store.ts /market/index 와 같은 규율 */
const NAV_INDEX_WAIT = 300;
export async function storeLatest(): Promise<Map<string, string> | undefined> {
  if (!STORE_INDEX_URL) return undefined;
  const fetching = fetchStoreIndex(STORE_INDEX_URL).catch(() => null);
  const idx = await Promise.race([
    fetching,
    new Promise<null>((r) => setTimeout(r, NAV_INDEX_WAIT, null)),
  ]);
  if (!idx) return undefined;
  return new Map(idx.entries.map((e) => [e.ref, e.version]));
}

/** 사이드바와 런처가 그릴 전부. running = 지금 떠 있는 자식 키(<패키지>/<이름>),
 *  latest = 스토어 ref→최신 버전 (storeLatest — 미연결·미도착이면 undefined, 배지 전부 침묵),
 *  drafts = 작업 사본 목록 (listDrafts — 초안 띠와 "수정 중" 배지의 원천) */
export function shellNav(ledger: Ledger, running: string[], latest?: Map<string, string>, drafts: DraftEntry[] = []): ShellNav {
  const live = new Set(running.map((k) => k.split("/")[0]));
  const draftOf = new Map(drafts.map((d) => [d.name, d]));
  const items: ShellItem[] = [];
  for (const [pkg, rec] of Object.entries(ledger.packages)) {
    const base = {
      pkg,
      href: hrefFor(ledger, pkg, "parts"),
      detail: hrefFor(ledger, pkg, "parts"),
      resident: live.has(pkg),
      ring0: rec.ring === 0,
    };
    let m: Manifest;
    try {
      m = loadManifest(rec.path);
    } catch (e) {
      // 판정 실패한 설치 — 목록에서 지우면 "왜 안 보이지" 가 되고 진단은 어디에도 없다.
      // 이름만으로 세우고 사유를 실어 상세로 보낸다(그 화면이 처방을 그린다)
      items.push({ ...base, label: pkg, description: "", version: "", icon: null, face: "parts", faces: ["parts"], view: null, error: String(e), update: null, editing: false });
      continue;
    }
    const faces = facesOf(m);
    const face = faces[0];
    // 새 판 대조 — 설치본의 스토어 좌표는 origin.ref(스토어 설치), 없으면 매니페스트 이름
    // (저자 로컬 설치가 자기 발행본과 만나는 경우). /market/index 의 installed 대조와 같은 축
    const ref = rec.origin?.ref ?? m.name;
    const latestVer = latest?.get(ref);
    const update = latestVer && m.version && newerVersion(latestVer, m.version) ? latestVer : null;
    // 수정 중 = 작업 사본에 기록하지 않은 변경이 있거나, 사본의 버전이 도는 판과 다르다
    const d = draftOf.get(pkg);
    const editing = !!d && (d.changes > 0 || (d.version != null && d.version !== (m.version ?? "")));
    items.push({
      ...base,
      label: m.display_name || pkg,
      description: m.description ?? "",
      version: m.version ?? "",
      icon: m.icon ? `/pkg/${encodeURIComponent(pkg)}/asset/${m.icon}` : null,
      face,
      faces,
      href: hrefFor(ledger, pkg, face),
      view: face === "view" || face === "chat" ? `/pkg/${encodeURIComponent(pkg)}/view/` : null,
      error: null,
      update,
      editing,
    });
  }
  // 설치한 순서대로 아래로 쌓인다 — 이름순은 새로 하나 앉힐 때마다 자리가 흔들려 손이 외우지 못한다.
  // 순서는 원장 키 순서 그대로(재설치는 같은 키를 덮어써 자리를 지킨다). 셸 자신(ring 0)은
  // 설치된 것들과 성격이 다르니 맨 위에 고정한다 — sort 는 안정 정렬이라 나머지 순서는 남는다
  items.sort((a, b) => Number(b.ring0) - Number(a.ring0));
  // 인덱스 주소에서 웹 주소를 얻는 규칙은 데스크톱 앱(daemon.rs store_web)과 같다
  const store = STORE_INDEX_URL ? STORE_INDEX_URL.replace(/\/index\.json$/, "/") : null;
  const pending = drafts
    .filter((d) => !d.installed)
    .map(({ name, version, changes }) => ({ name, version, changes, href: consoleHref(ledger, `?p=${encodeURIComponent(name)}&face=detail`) }));
  return {
    items,
    home: "/",
    importer: "/store/import",
    drafts: pending,
    store,
    library: store ? store + "library" : null,
  };
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
// 홈에도 대화 위젯이 선다 — "말만 하면 된다" 는 이 제품의 대표 동선인데, 종전에는 첫 화면에
// 말할 곳이 없었다(채팅은 콘솔 설정 화면과 앱 화면에만). 좌표는 콘솔 패키지의 것: 홈의 대화
// 상대는 기판 관리 셸 에이전트다(view.ts viewContextTag 와 같은 주입 문법)
export function homeDoc(ledger: Ledger): string {
  const console = consoleInstall(ledger);
  const enc = encodeURIComponent(console);
  return injectShell(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Relay</title><link rel="icon" href="/pkg/${enc}/view/icon.svg">
<link rel="stylesheet" href="/assets/chat-app.css">
</head><body><div id="relay-home"></div>
<script>window.__RELAY_CONTEXT={base:${JSON.stringify("/pkg/" + enc)},root:"",instanceId:${JSON.stringify(console)}};</script>
<script type="module" src="/assets/chat-app.js" async></script>
</body></html>`);
}

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

var FACE_KO = { view: "화면", chat: "대화", live: "상주", parts: "부품" };
var ICONS = {
  home: '<path d="M2.5 7.5 8 2.5l5.5 5v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  store: '<path d="M3 5.5h10l-.7 7a1 1 0 0 1-1 .9H4.7a1 1 0 0 1-1-.9zM5.5 5.5V4a2.5 2.5 0 0 1 5 0v1.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  down: '<path d="M8 3v8M4.5 7.5 8 11l3.5-3.5"/>',
  draft: '<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M6 8h4M6 10.5h4"/>',
  edit: '<path d="M11.5 2.5l2 2L6 12H4v-2z"/><path d="M10 4l2 2"/>',
  fold: '<path d="M6 3.5 2.5 8 6 12.5M13 8H3"/>',
  unfold: '<path d="M10 3.5 13.5 8 10 12.5M3 8h10"/>'
};
function svg(d, cls){ return '<svg class="' + (cls||"") + '" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">' + d + '</svg>'; }
function esc(s){ return String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

var home = document.getElementById("relay-home");

var css = [
':root{--relay-side:' + (collapsed ? RAIL : W) + 'px;--relay-accent:#0f766e;--relay-accent-deep:#115e59;--relay-accent-soft:rgba(13,148,136,.1)}',
'body{margin-left:var(--relay-side);transition:margin-left .16s ease}',
'#rlys{position:fixed;top:0;left:0;bottom:0;width:var(--relay-side);z-index:2147482990;display:flex;flex-direction:column;gap:2px;padding:10px 8px;box-sizing:border-box;background:#fff;border-right:1px solid #e6e9ec;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Segoe UI",sans-serif;color:#16181b;overflow:hidden;transition:width .16s ease}',
'#rlys *{box-sizing:border-box}',
'#rlys .hd{display:flex;align-items:center;gap:8px;padding:8px 8px 12px;font-weight:700;white-space:nowrap;overflow:hidden}',
'#rlys .hd img{height:22px;width:auto;max-width:150px;object-fit:contain;display:block;flex:none}',
'#rlys .hd span{overflow:hidden;text-overflow:ellipsis}',
'#rlys .hd .fold{margin-left:auto;width:24px;height:24px;border:none;background:none;color:#98a1aa;cursor:pointer;padding:0;display:inline-flex;align-items:center;justify-content:center;border-radius:6px;flex:none}',
'#rlys .hd .fold:hover{background:#eef0f2;color:#5c6570}',
'#rlys .hd .fold svg{width:14px;height:14px}',
'#rlys .lb{font-size:11px;font-weight:700;color:#98a1aa;text-transform:uppercase;letter-spacing:.04em;padding:12px 10px 6px;white-space:nowrap}',
'#rlys .gp{display:flex;flex-direction:column;gap:1px}',
'#rlys .pk{overflow-y:auto;overflow-x:hidden;min-height:0;flex:0 1 auto}',
'#rlys .sp{flex:1 1 auto;min-height:8px}',
'#rlys .it.mk{background:#0d9488;color:#fff;font-weight:600;margin:4px 0 12px}',
'#rlys .it.mk:hover{background:#0f766e}',
'#rlys .it.mk .ic{color:#fff}',
'#rlys a.it,#rlys button.it{display:flex;align-items:center;gap:9px;width:100%;padding:7px 10px;border:none;border-radius:8px;background:none;color:inherit;font:inherit;text-align:left;text-decoration:none;cursor:pointer;white-space:nowrap}',
'#rlys .it:hover{background:#eef0f2}',
'#rlys .it.on{background:var(--relay-accent-soft);color:var(--relay-accent-deep);font-weight:600}',
'#rlys .it .ic{width:20px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:#5c6570;border-radius:5px;overflow:hidden}',
'#rlys .it.on .ic{color:var(--relay-accent)}',
'#rlys .it .ic svg{width:15px;height:15px}',
'#rlys .it .ic img{width:18px;height:18px;border-radius:4px;object-fit:cover;display:block}',
'#rlys .it .ic.ltr{background:#eef0f2;font:700 11px inherit;color:#5c6570}',
'#rlys .it .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}',
'#rlys .it .dt{width:7px;height:7px;border-radius:50%;background:#059669;flex:none}',
'#rlys .rw{position:relative;display:flex;align-items:center}',
'#rlys .rw .mo{position:absolute;right:6px;width:22px;height:22px;display:none;align-items:center;justify-content:center;border-radius:6px;color:#98a1aa;background:#eef0f2}',
'#rlys .rw:hover .mo{display:inline-flex}',
'#rlys .rw .mo:hover{background:#dfe3e7;color:#16181b}',
'#rlys .rw .mo svg{width:13px;height:13px}',
'#rlys .rw:hover .it .dt{display:none}',
'#rlys .er{font-size:11.5px;color:#c0392b;padding:8px 10px;white-space:normal}',
'#rlys .em{font-size:12px;color:#98a1aa;padding:8px 10px}',
// 접힌 레일 — 글자를 지우고 아이콘만 남긴다. 폭 계약이 같이 줄어드니 문서는 따라온다
'#rlys.cl .nm,#rlys.cl .lb,#rlys.cl .hd span,#rlys.cl .em,#rlys.cl .er{display:none}',
'#rlys.cl a.it,#rlys.cl button.it{justify-content:center;padding:7px 0;position:relative}',
'#rlys.cl .hd{padding:10px 0 12px;justify-content:center}',
'#rlys.cl .hd .fold{margin:0}',
'#rlys.cl .it .dt{position:absolute;right:6px;bottom:6px}',
// ── 홈(런처) ─────────────────────────────────────────────────────────────
'body:has(#relay-home){margin:0 0 0 var(--relay-side);background:#f5f6f7}',
'#relay-home{min-height:100vh;background:#f5f6f7;color:#16181b;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Segoe UI",sans-serif}',
'#relay-home *{box-sizing:border-box}',
'#relay-home .bt{border:1px solid #e6e9ec;background:#fff;color:#16181b;border-radius:8px;padding:6px 12px;font:600 12.5px inherit;text-decoration:none;display:inline-flex;align-items:center;gap:6px}',
'#relay-home .bt:hover{background:#eef0f2}',
'#relay-home .bt.ac{background:var(--relay-accent);border-color:var(--relay-accent);color:#fff}',
'#relay-home .bt.ac:hover{background:var(--relay-accent-deep)}',
'#relay-home .gr{display:grid;grid-template-columns:repeat(auto-fill,minmax(248px,1fr));gap:12px;padding:18px 20px}',
'#relay-home .cd{background:#fff;border:1px solid #e6e9ec;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
'#relay-home .cd:hover{border-color:var(--relay-accent)}',
'#relay-home .cd .go{display:flex;flex-direction:column;gap:8px;text-decoration:none;color:inherit}',
'#relay-home .cd .tp{display:flex;align-items:center;gap:10px}',
'#relay-home .cd .av{width:30px;height:30px;border-radius:8px;flex:none;display:inline-flex;align-items:center;justify-content:center;background:#eef0f2;font:700 13px inherit;color:#5c6570;overflow:hidden}',
'#relay-home .cd .av img{width:30px;height:30px;object-fit:cover;display:block}',
'#relay-home .cd .nm{flex:1 1 auto;min-width:0}',
'#relay-home .cd b{display:block;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
'#relay-home .cd .ver{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;color:#98a1aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
// 새 판 배지 — 버전 라인의 화살표 칩(.nv) · 푸터의 업데이트 버튼(.upb) · 상단 요약 배너(.ub)
'#relay-home .cd .nv{display:inline-block;margin-left:4px;padding:0 5px;border-radius:5px;font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--relay-accent-deep);background:var(--relay-accent-soft)}',
'#relay-home .cd .upb{background:var(--relay-accent);color:#fff;border-radius:7px;padding:3px 9px;font:700 11.5px inherit;text-decoration:none;white-space:nowrap}',
'#relay-home .cd .upb:hover{background:var(--relay-accent-deep)}',
'#relay-home .ub{display:flex;align-items:center;gap:8px;margin:18px 20px -6px;padding:9px 14px;background:var(--relay-accent-soft);border:1px solid var(--relay-accent);border-radius:10px;font-size:12.5px;color:var(--relay-accent-deep)}',
'#relay-home .ub b{font-weight:800}',
'#relay-home .ub .gap{flex:1}',
'#relay-home .ub a{color:inherit;font-weight:700;text-decoration:underline;text-underline-offset:3px}',
'#relay-home .cd p{margin:0;font-size:12.5px;color:#5c6570;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;min-height:2.6em}',
'#relay-home .cd .ft{display:flex;align-items:center;gap:6px}',
'#relay-home .cd .cp{font-size:11px;font-weight:600;color:#5c6570;background:#eef0f2;border-radius:6px;padding:1px 7px}',
'#relay-home .cd .cp.er{color:#c0392b;background:#fdf2f1}',
'#relay-home .cd .cp.ed{color:#b45309;background:#fef3c7}',
// 말로 만들기 — 홈의 첫 입력. 위젯 대화로 보내진다
'#relay-home .gh{max-width:1240px;margin:8px auto 0;padding:0 20px;font-size:12px;font-weight:700;color:#98a1aa;letter-spacing:.02em}',
'#relay-home .gn{max-width:620px;margin:20px auto;padding:0 20px;text-align:center;font-size:13px;color:#98a1aa}',
'#relay-home .ask{max-width:620px;margin:0 auto;padding:56px 20px 28px}',
'#relay-home .ask h2{margin:0 0 16px;text-align:center;font-size:22px;font-weight:700;letter-spacing:-0.02em}',
'#relay-home .af{display:flex;flex-direction:column;gap:10px;background:#fff;border:1px solid #e6e9ec;border-radius:14px;padding:14px 14px 10px;box-shadow:0 1px 2px rgba(22,24,27,.04)}',
'#relay-home .af:focus-within{border-color:#0f766e;box-shadow:0 0 0 3px rgba(15,118,110,.12)}',
'#relay-home .af textarea{border:0;resize:none;min-height:58px;font:14.5px/1.55 inherit;font-family:inherit;background:transparent;color:#16181b;outline:none;padding:0 2px}',
'#relay-home .af .fr{display:flex;align-items:center;justify-content:space-between;gap:8px}',
'#relay-home .af .fr .ah{margin:0;font-size:12px;color:#98a1aa}',
'#relay-home .af .bt{flex:none;padding:7px 14px;font-size:13px;border-radius:999px}',
'#relay-home .op{display:flex;flex-direction:column;margin-top:14px;border-top:1px solid #e6e9ec}',
'#relay-home .op a{display:flex;align-items:center;gap:10px;padding:10px 6px;border-bottom:1px solid #e6e9ec;color:#16181b;text-decoration:none;font-size:13.5px}',
'#relay-home .op a:hover{background:#eef0f2}',
'#relay-home .op a svg{width:15px;height:15px;color:#5c6570;flex:none}',
'#relay-home .op a span{color:#98a1aa;font-size:12.5px;flex:1 1 auto}',
'#relay-home .op a i{color:#98a1aa;font-style:normal}',
// 만드는 중인 초안 — 장부에 없어도 설치본과 같은 카드로 격자 끝에 선다 (점선 테두리가 "아직" 의 표식)
'#relay-home .cd.df{border-style:dashed;background:#fffdf5}',
'#relay-home .cd.df:hover{border-color:#b45309}',
'#relay-home .cd.df .av{background:#fef3c7;color:#b45309}',
'#relay-home .cd.df .av svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}',
// 사용 안내 — 첫 방문에 한 번, 이후엔 ?guide=1
'.gd-veil{position:fixed;inset:0;background:rgba(22,24,27,.45);display:flex;align-items:center;justify-content:center;z-index:2147483200}',
'.gd{width:min(440px,calc(100vw - 48px));background:#fff;border:1px solid #e6e9ec;border-radius:14px;padding:26px 28px;display:flex;flex-direction:column;gap:12px;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",Pretendard,"Segoe UI",sans-serif;color:#16181b;box-sizing:border-box}',
'.gd *{box-sizing:border-box}',
'.gd .k{font:600 11.5px inherit;color:#0f766e;letter-spacing:.4px}',
'.gd h2{margin:0;font-size:18px;line-height:1.4}',
'.gd p{margin:0;color:#5c6570;min-height:88px}',
'.gd p b{color:#16181b;font-weight:600}',
'.gd .dots{display:flex;gap:6px;justify-content:center;padding:4px 0}',
'.gd .dots i{width:6px;height:6px;border-radius:50%;background:#e6e9ec;cursor:pointer}',
'.gd .dots i.on{background:#0f766e}',
'.gd .nv{display:flex;justify-content:flex-end;gap:8px}',
'.gd .bt{border:1px solid #e6e9ec;background:#fff;color:#16181b;border-radius:8px;padding:6px 12px;font:600 12.5px inherit;cursor:pointer}',
'.gd .bt.ac{background:#0f766e;border-color:#0f766e;color:#fff}',
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
    // 얼굴(화면·대화…) 글리프는 두지 않는다 — 오른쪽 끝의 작은 아이콘은 버튼으로 읽히는데 눌러도 아무 일이 없다.
    // 종류는 title 과 홈 카드의 칩이 말한다
    (opts.dot ? '<span class="dt" title="도는 중"></span>' : "");
  return a;
}

function applyBrand(nav){
  var b = nav && nav.brand;
  if (!b || !b.accent) return;
  var r = document.documentElement.style;
  r.setProperty("--relay-accent", b.accent);
  r.setProperty("--relay-accent-deep", "color-mix(in srgb, " + b.accent + " 82%, black)");
  r.setProperty("--relay-accent-soft", "color-mix(in srgb, " + b.accent + " 12%, white)");
  if (b.name) document.title = document.title === "Relay" ? b.name : document.title;
}

function renderSide(nav, err){
  var here = current();
  applyBrand(nav);
  el.textContent = "";

  var hd = document.createElement("div");
  hd.className = "hd";
  // 얼굴 — 기판이 nav.brand 로 준 이름·마크(임베더 브랜딩). 없으면 "Relay"
  var brand = nav && nav.brand;
  hd.innerHTML = (brand && brand.logo ? '<img src="' + esc(brand.logo) + '" alt="">' : '') +
    '<span>' + esc(brand && brand.name ? brand.name : "Relay") + '</span>';
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
  top.appendChild(item(nav ? nav.home : "/", svg(ICONS.home), "홈", { on: onHome(), title: "홈 — 만들고 손보는 곳" }));
  // 새로 만들기 = 홈의 입력 상자로. 빈 채팅창을 띄우면 "뭘 쓰라는 건지"가 없다 — 상자는
  // 질문("무엇을 만들까요?")·예시·무슨 일이 일어나는지를 같이 말한다. 대화는 거기서 이어진다.
  // 이 화면에서 제일 중요한 행동이라 목록 위, 채워진 버튼이다
  var mk = document.createElement("button");
  mk.type = "button";
  mk.className = "it mk";
  mk.title = "만들고 싶은 것을 말로 설명하면 빌더가 만듭니다";
  mk.innerHTML = '<span class="ic">' + svg(ICONS.plus) + '</span><span class="nm">새로 만들기</span>';
  mk.onclick = function(){
    if (home) focusAsk();
    else location.href = "/#new";
  };
  top.appendChild(mk);
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
      // 행은 패키지 화면으로, 오른쪽 끝 연필은 손보기(상세 화면)로 — 호버할 때만 나타난다.
      // 장식 아이콘은 두지 않는다: 그 자리에 뭔가 보이면 사람은 누른다
      var rw = document.createElement("div");
      rw.className = "rw";
      rw.appendChild(item(it.href, ic, it.label, {
        on: it.pkg === here,
        dot: it.resident,
        letter: !it.icon,
        title: it.pkg + (it.ring0 ? " · ring-0" : "") + " — " + FACE_KO[it.face]
      }));
      if (!collapsed && it.href !== it.detail) {
        var mo = document.createElement("a");
        mo.className = "mo";
        mo.href = it.detail;
        mo.title = it.label + " 손보기";
        mo.setAttribute("aria-label", it.label + " 손보기");
        mo.innerHTML = svg(ICONS.edit);
        rw.appendChild(mo);
      }
      pk.appendChild(rw);
    }
    el.appendChild(pk);
  }

  var sp = document.createElement("div");
  sp.className = "sp";
  el.appendChild(sp);

}

// ── 홈(런처) — 사이드바와 같은 nav 를 그린다 ───────────────────────────────
function renderHome(nav, err){
  if (!home) return;
  var wantAsk = location.hash === "#new";
  if (wantAsk) { try { history.replaceState(null, "", location.pathname); } catch (e) {} }
  // 다시 그릴 때(재조회) 입력 중이던 문장을 지키지 않으면 새로고침이 사용자의 글을 지운다
  var typed = "";
  try { var prev = home.querySelector(".af textarea"); if (prev) typed = prev.value; } catch (e) {}
  home.textContent = "";
  var drafts = nav && nav.drafts ? nav.drafts : [];

  // 말로 만들기 — 이 제품의 대표 동선이 첫 화면에서 시작된다. 문장은 콘솔 에이전트의 대화로
  // 보내지고(relay:chat-open send), 빌더 위임이 시작되면 위젯이 그 탭을 연다
  // 시작은 이 상자 하나다. 별도의 "패키지 만들기" 버튼은 두지 않는다 — 불러오기·스토어는
  // 상자 아래 한 줄씩이라, 처음 온 사람이 고를 것이 "말하기" 하나로 보인다.
  // 빈 패키지를 손으로 여는 화면은 없다 — 빌더 없이 시작하려면 터미널의 relay draft <이름> 이다.
  if (nav) {
    var ask = document.createElement("div");
    ask.className = "ask";
    ask.innerHTML = '<h2>무엇을 만들까요?</h2>' +
      '<form class="af"><textarea maxlength="2000" rows="2" placeholder="만들고 싶은 비서를 적어 주세요. 예: 매일 저녁 하루를 정리해 일기로 남겨 주는 비서" aria-label="만들 것을 말로 설명"></textarea>' +
      '<div class="fr"><p class="ah">적으면 빌더가 설계부터 적용까지 진행하고, 그 대화가 오른쪽에 열립니다.</p><button type="submit" class="bt ac">시작</button></div></form>' +
      '<div class="op">' +
        '<a href="' + esc(nav.importer) + '">' + svg(ICONS.down) + '불러오기<span>누군가에게 받은 에이전트 파일을 엽니다</span><i>›</i></a>' +
        (nav.store ? '<a href="' + esc(nav.store) + '">' + svg(ICONS.store) + '스토어에서 담기<span>만들어진 에이전트를 골라 설치합니다</span><i>›</i></a>' : "") +
      '</div>';
    var af = ask.querySelector("form");
    var ai = ask.querySelector("textarea");
    if (typed) ai.value = typed;
    af.onsubmit = function(ev){
      ev.preventDefault();
      var text = (ai.value || "").trim();
      if (!text) { ai.focus(); return; }
      sendToChat(text);
      ai.value = "";
    };
    // Enter 는 보내기, Shift+Enter 는 줄바꿈
    ai.onkeydown = function(ev){ if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); af.requestSubmit(); } };
    home.appendChild(ask);
    if (wantAsk) focusAsk();
  }

  if (err) {
    var e = document.createElement("div");
    e.className = "ep";
    e.innerHTML = '<h2>설치 목록을 읽지 못했습니다</h2><p>' + esc(err) + '</p>';
    home.appendChild(e);
    return;
  }
  if (!nav) return;

  if (!nav.items.length && !drafts.length) {
    var ep = document.createElement("div");
    ep.className = "ep";
    ep.innerHTML = '<h2>아직 설치된 에이전트가 없습니다</h2>' +
      '<p>위 상자에 만들고 싶은 것을 적어 시작하세요.</p>';
    home.appendChild(ep);
    return;
  }

  // 새 판 요약 배너 — 하나라도 있으면 개수만 말한다. 실행은 각 카드의 버튼이 맡는다
  // (설치 동의 관문이 판마다 서므로 "모두 업데이트" 일괄 버튼은 두지 않는다)
  var ups = 0;
  for (var u = 0; u < nav.items.length; u++) if (nav.items[u].update) ups++;
  if (ups && nav.library) {
    var ub = document.createElement("div");
    ub.className = "ub";
    ub.innerHTML = '⬆ <b>새 판이 나온 에이전트 ' + ups + '개</b> — 카드의 업데이트 버튼으로 받으세요' +
      '<span class="gap"></span><a href="' + esc(nav.library) + '">내 서재 열기</a>';
    home.appendChild(ub);
  }

  // 홈 카드는 전부가 아니라 **지금 신경 쓸 것**만이다 — 초안·수정 중·새 판·오류. 멀쩡히 도는
  // 앱은 사이드바가 이미 목록으로 보여 주므로 여기 또 세우면 같은 목록이 두 번 선다.
  // 손볼 게 없으면 홈은 상자 하나 — "만들 것 없으면 왼쪽에서 골라 쓰세요"가 저절로 읽힌다
  var todo = [];
  for (var t = 0; t < nav.items.length; t++) {
    if (nav.items[t].editing || nav.items[t].update || nav.items[t].error) todo.push(nav.items[t]);
  }
  if (todo.length || drafts.length) {
    var th = document.createElement("h3");
    th.className = "gh";
    th.textContent = "진행 중";
    home.appendChild(th);
  } else {
    var no = document.createElement("p");
    no.className = "gn";
    no.textContent = "진행 중인 것이 없습니다 — 앱은 왼쪽 목록에서 골라 쓰세요.";
    home.appendChild(no);
  }
  var gr = document.createElement("div");
  gr.className = "gr";
  for (var i = 0; i < todo.length; i++) {
    var it = todo[i];
    var av = it.icon ? '<img src="' + esc(it.icon) + '" alt="">' : esc((it.label.trim()[0] || "?").toUpperCase());
    var cd = document.createElement("div");
    cd.className = "cd";
    cd.innerHTML =
      '<a class="go" href="' + esc(it.href) + '">' +
        '<span class="tp">' +
          '<span class="av">' + av + '</span>' +
          '<span class="nm"><b>' + esc(it.label) + '</b>' +
            '<span class="ver">' + esc(it.pkg) + (it.version ? "@" + esc(it.version) : "") +
              (it.update ? '<span class="nv">→ ' + esc(it.update) + '</span>' : "") +
            '</span>' +
          '</span>' +
          (it.resident ? '<span class="dt" title="도는 중"></span>' : "") +
        '</span>' +
        '<p>' + esc(it.description) + '</p>' +
      '</a>' +
      '<div class="ft">' +
        '<span class="cp">' + FACE_KO[it.face] + '</span>' +
        (it.error ? '<span class="cp er">검사 실패</span>' : "") +
        (it.editing ? '<span class="cp ed" title="적용하지 않은 수정이 스튜디오에 있습니다">수정 중</span>' : "") +
        '<span class="sp"></span>' +
        // 새 판 버튼 — 설치 티켓은 스토어 서재가 발급하므로 서재로 보낸다 (동의 관문은 그 다음)
        (it.update && nav.library
          ? '<a class="upb" href="' + esc(nav.library) + '" title="스토어 내 서재에서 새 판을 설치합니다">' + esc(it.update) + ' 업데이트</a>'
          : "") +
        '<a class="mo" href="' + esc(it.detail) + '">상세</a>' +
      '</div>';
    gr.appendChild(cd);
  }
  // 만드는 중인 초안 — 장부에 없어 설치 카드는 못 되지만, 어디에도 없으면 만들다 만 것이 잃은 것처럼
  // 보인다. 설치본과 같은 격자에 같은 모양으로 세우고, 점선과 "초안" 배지로만 가른다
  for (var d = 0; d < drafts.length; d++) {
    var df = drafts[d];
    var dc = document.createElement("div");
    dc.className = "cd df";
    dc.innerHTML =
      '<a class="go" href="' + esc(df.href) + '">' +
        '<span class="tp">' +
          '<span class="av">' + svg(ICONS.draft) + '</span>' +
          '<span class="nm"><b>' + esc(df.name) + '</b>' +
            '<span class="ver">' + esc(df.name) + (df.version ? "@" + esc(df.version) : "") + '</span>' +
          '</span>' +
        '</span>' +
        '<p>' + (df.changes ? '아직 발행하지 않은 초안 — 바뀐 파일 ' + df.changes + '개' : '아직 발행하지 않은 초안') + '</p>' +
      '</a>' +
      '<div class="ft">' +
        '<span class="cp ed">초안</span>' +
        '<span class="sp"></span>' +
        '<a class="mo" href="' + esc(df.href) + '">이어 만들기</a>' +
      '</div>';
    gr.appendChild(dc);
  }
  home.appendChild(gr);
}

// 홈의 문장을 위젯 대화로 보낸다. 위젯 번들은 async 라 늦게 뜰 수 있다 — 전역 표면
// (window.RelayChat, 번들 로드 시 선다)이 설 때까지 250ms 간격으로 기다린다(최대 8초)
function sendToChat(text){ chatOpen({ send: text }); }
/** 홈의 입력 상자로 — 사이드바의 [새로 만들기] */
function focusAsk(){
  var ta = home && home.querySelector(".af textarea");
  if (!ta) return;
  try { ta.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
  ta.focus();
}
function chatOpen(detail){
  var tries = 0;
  (function fire(){
    if (window.RelayChat) {
      try { window.dispatchEvent(new CustomEvent("relay:chat-open", { detail: detail })); } catch (e) {}
      return;
    }
    if (++tries > 32) return;
    setTimeout(fire, 250);
  })();
}

// ── 사용 안내 — 홈 첫 방문에 한 번, 이후엔 ?guide=1(콘솔 설정의 [안내])로 연다 ─────────
// 종전 안내는 콘솔 패키지 화면에 살았고 문구가 옛 3열 콘솔을 설명했다. 처음 닿는 자리가 이
// 홈이므로 안내도 여기 산다 — 문구는 지금 구조(홈 카드·사이드바·말로 만들기·스튜디오)를 말한다
var GUIDE_KEY = "relay-guide-v2";
var GUIDE = [
  { t: "Relay에 오신 것을 환영합니다",
    b: "Relay는 AI 에이전트를 <b>앱처럼 설치해서 쓰는</b> 내 컴퓨터 속 작업 공간입니다. 설치된 앱은 <b>왼쪽 사이드바</b>에서 골라 쓰고, 이 홈에서는 <b>새로 만들거나 손볼 것</b>을 봅니다." },
  { t: "만들기는 말로 시작합니다",
    b: "홈 위의 입력창에 원하는 것을 적어 보세요. 예를 들어 <b>\"근태관리 도우미 만들어줘\"</b>. 빌더가 <b>설계부터 적용까지</b> 진행하고, 그 대화가 오른쪽에 열려 과정과 질문을 볼 수 있습니다." },
  { t: "손으로 고치려면 상세 화면",
    b: "사이드바에서 앱을 고르고 <b>[상세]</b>를 누르면 그 앱이 무엇을 하는지 한 장으로 보입니다. <b>줄을 누르면 그 자리에서</b> 고치고 결과를 미리 보며, <b>[적용]</b>을 눌러야 실제로 돌아가는 판이 바뀝니다." },
  { t: "안전장치가 기본입니다",
    b: "비밀번호와 토큰은 <b>금고에만 저장</b>되고, 에이전트는 <b>허락한 폴더만</b> 봅니다. 앱끼리 연결할 때도 <b>내 승인이 있어야</b> 켜집니다. 이 안내는 설정 화면의 [안내]로 다시 볼 수 있습니다." }
];
function renderGuide(){
  var i = 0;
  var veil = document.createElement("div");
  veil.className = "gd-veil";
  var card = document.createElement("div");
  card.className = "gd";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", "사용 안내");
  veil.appendChild(card);
  function close(){
    try { localStorage.setItem(GUIDE_KEY, "1"); } catch (e) {}
    veil.remove();
    try {
      var u = new URL(location.href);
      if (u.searchParams.has("guide")) { u.searchParams.delete("guide"); history.replaceState(null, "", u.pathname + (u.search || "")); }
    } catch (e) {}
  }
  function draw(){
    var last = i === GUIDE.length - 1;
    var dots = "";
    for (var n = 0; n < GUIDE.length; n++) dots += '<i class="' + (n === i ? "on" : "") + '" data-n="' + n + '"></i>';
    card.innerHTML = '<div class="k">사용 안내 ' + (i + 1) + ' / ' + GUIDE.length + '</div>' +
      '<h2>' + GUIDE[i].t + '</h2><p>' + GUIDE[i].b + '</p>' +
      '<div class="dots">' + dots + '</div>' +
      '<div class="nv">' + (i > 0 ? '<button type="button" class="bt" data-act="prev">이전</button>' : "") +
      '<button type="button" class="bt ac" data-act="next">' + (last ? "시작하기" : "다음") + '</button></div>';
    var ds = card.querySelectorAll(".dots i");
    for (var k = 0; k < ds.length; k++) ds[k].onclick = function(ev){ i = Number(ev.currentTarget.getAttribute("data-n")) || 0; draw(); };
    var pv = card.querySelector('[data-act="prev"]');
    if (pv) pv.onclick = function(){ i = Math.max(0, i - 1); draw(); };
    card.querySelector('[data-act="next"]').onclick = function(){ if (last) close(); else { i += 1; draw(); } };
  }
  veil.onclick = function(ev){ if (ev.target === veil) close(); };
  draw();
  document.body.appendChild(veil);
  try { card.querySelector('[data-act="next"]').focus(); } catch (e) {}
}

function loadNav(){
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
}

renderSide(null, null);
renderHome(null, null);
loadNav();
// 목록은 한 번 읽고 끝이 아니다 — 같은 문서에서 대화가 발행을 끝내거나(relay:turn settled),
// 스튜디오가 적용·버리기를 마치거나(relay:nav-refresh), 다른 탭에 갔다 돌아오면 다시 읽는다.
// 종전에는 한 번뿐이라 채팅으로 만든 앱이 새로고침 전까지 사이드바에 없었다
window.addEventListener("relay:turn", function(ev){ var d = (ev && ev.detail) || {}; if (d.phase === "settled") loadNav(); });
window.addEventListener("relay:nav-refresh", function(){ loadNav(); });
document.addEventListener("visibilitychange", function(){ if (document.visibilityState === "visible") loadNav(); });

if (home) {
  var wantGuide = false, seenGuide = false;
  try { wantGuide = new URLSearchParams(location.search).get("guide") === "1"; } catch (e) {}
  try { seenGuide = localStorage.getItem(GUIDE_KEY) === "1"; } catch (e) {}
  if (wantGuide || !seenGuide) renderGuide();
}
})();`;

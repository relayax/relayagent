// client-wire.ts — 클라이언트 전송 계약 v1(docs/client-protocol.md)의 서버 반쪽.
//
// 배선됨(원자 컷 §9-47-3): api.ts 가 /registry 직후 `if (await handleClientWire(...)) return;`
// 로 마운트하고, session.ts 의 봉투 기록 지점이 setEnvelopeTap 주입을 통해 tapSessionEvent 를
// 부른다(session→client-wire 직접 import 는 순환이라 조립점 api.ts 가 주입한다).
//
// http 보조(json/readBody/MIME)는 api.ts 관용구의 자체 사본이다 — api.ts 를 import 하면
// 순환(api → installer → …)이자 배선이 되므로 금지. 컷에서 구 wire 삭제와 함께 단일화한다.
// 오류 봉투는 구 wire({error: string})가 아니라 계약의 {error:{code,message}} 다(§5.0-10).

import http from "node:http";
import { MIME, json } from "../http.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { RELAY_HOME, packagesPath, sessionDir, sessionPath, saveLedger, type Ledger } from "../supply/ledger.ts";
import { runSession, cancelSession, autoTitleSession, deliverAnswer, deliverSteer, isSessionBusy, sessionLiveness, retireResident, retireResidents, localSessionIO, type SessionIO, type SessionResult, startRemote, stopRemote, remoteStatus } from "./harness.ts";
import { loadManifest, landingAgentName, landingGreeting, type Manifest } from "../supply/manifest.ts";
import { chooseHarness, selectHarness, harnessEntry } from "./harness-entry.ts";
import { harnessVerb, setHarness } from "../supply/install.ts";
import { SLOT_RE, UPLOADS_DIR, UPLOADS_PREFIX, slotOrigin, type SessionOrigin } from "../protocol.ts";
import type { Authority } from "../authority-contract.ts";

/** 클라이언트 프로토콜 버전 — §9-47-3 의 컷부터 발효. 하네스 봉투 protocol(현재 3)과 별개 축 */
export const CLIENT_PROTOCOL = 1;

// ── 계약 축 이음새 ──────────────────────────────────────────────────────────
// 계약(docs/client-protocol.md)이 규정하는 표면이 딛는 **저장소**를 모듈 좌표(./state.ts ·
// ./installer.ts)가 아니라 인자로 받는 주입점. 실행 반쪽 자매 셋(run.ts RunnerIO — 스폰 env ·
// mcp.ts McpIO — 세션이 보는 도구 문 · session.ts SessionIO — 한 턴이 딛는 좌표)의 네 번째이고,
// 넷의 형이 같다: 작은 함수 묶음을 인자로 받고 미주입이면 1인 기판 구현이 꽂힌다(additive).
// 익명의 제3자 임베더 테스트 — 이 형에 org 어휘(principal 바인딩·멤버·라이선스·control)는 없다:
// 세션 목록이 행 배열이고, 이력이 SessionIO 의 장부이고, 하네스 조회가 (패키지, 동사) → 값이고,
// 설정 쓰기가 patch → 결과인 것뿐이다.
//
// 왜 필요한가(relayos I1 실측, 2026-08-24): 임베디드 데몬이 pod 안에서 이 계약을 서빙하는데
// 서빙되는 것이 조직 권위가 아니라 pod 로컬 `~/.relay` 였다. `ClientWireDeps={getLedger,
// authority}` 만으로는 장부(설치·인가)와 권위만 갈아 끼워지고, **계약 축의 저장소**(세션 목록·
// 대화 이력·무대·설정 쓰기·하네스 조회)는 모듈 좌표에 고정이라 임베더가 손댈 자리가 없었다.
//
// 무엇을 인자화했는가:
//  · session(SessionIO) — 한 턴이 딛는 좌표 전부. 턴을 실제로 여는 곳이 이 파일이므로 runSession
//    에 실리는 이음새도 여기서 온다. 턴 장부(turns/<id>.jsonl)·업로드 무대·번들 회전이 전부
//    이 좌표를 딛는다 — 계약 축과 실행 축이 **같은 좌표**를 봐야 화면과 하네스가 갈리지 않는다.
//  · 대화 이력 — 새 멤버가 아니다. history.get 은 session.readMessages 를 지난다: 파일이 정본인
//    기판과 다른 저장소가 정본인 임베더가 갈리는 축은 이미 SessionIO 가 열었고, 여기 같은 축을
//    또 내면 리더가 둘이 되어 한쪽만 고쳐지는 날 조용히 갈린다.
//  · 세션 목록·개설·메타·삭제(listSessions·createSession·updateSession·removeSession) —
//    SessionIO 가 "기판 표면의 일"이라며 열지 않고 남긴 자리가 여기다. 목록이 그 저장소에서
//    오지 않으면 임베더의 대화가 화면에 없다. 정렬(§5.3-21 고정 우선·최근순)과 판정(선언 밖
//    에이전트·param 홀로서기·라벨 상한)은 계약이라 이 파일에 남는다 — 구현은 저장만 한다.
//  · 하네스 조회(harnessQuery·harnessCapabilities) — "어떤 모델·커맨드가 있는가"의 정본이
//    1인 기판은 동봉 어댑터 프로세스이고 임베더는 자기 카탈로그다. 개막 capability 투영을
//    별도 동사로 둔 이유는 캐시다: 1인 기판은 이 답이 어댑터 프로세스 1회 비용이라 캐시가
//    필요하고, 그 무효화 키(어댑터 파일 mtime)는 구현만 안다. info 를 통째로 캐시하면 그 안의
//    계정 상태까지 굳어 로그인이 화면에 늦게 선다.
//  · 설정 쓰기(setHarnessConfig) — 이 파일이 장부를 쓰는 유일한 자리(§5.5-30/30-a)다. 쪼개서
//    saveLedger 만 열면 반쪽이 된다: 변형 전환은 installer.setHarness 가 **자기 안에서** 장부를
//    쓰므로, 그 절반이 임베더 몰래 ~/.relay 로 샌다 — 200 {ok:true} 를 받고 다음 조회에 값이
//    없는 조용한 갈림이다(requirePkg 머리의 실사고와 같은 형).
//
// 열지 않은 축과 이유 (인터페이스는 소비자가 있을 때만 판다):
//  · 턴 큐·사슬·sinks(turns·sessionQueues·sessionChains·TurnRecord.sinks) — 담는 것이 살아 있는
//    SSE 라이터와 Promise 사슬이라 프로세스 지역이다(SessionIO 가 진행 명부를 열지 않은 것과
//    같은 근거). 게다가 세션 직렬화는 계약이 **기판에게 맡긴 판정**이다(§5.1-12 "기판만이 세션의
//    유일한 직렬화 지점") — 인자화하면 그 불변식이 구현마다 갈린다. 턴 장부의 **파일 자리**는
//    주입된 session.sessionDir 을 따라간다(세션의 턴 장부와 같은 자리).
//  · 취소·회송·얹기·busy(cancelSession·deliverAnswer·deliverSteer·isSessionBusy·retireResident) — 착지점이
//    session.ts 의 진행 명부(ChildProcess 핸들·stdin)다. 턴을 이 데몬이 돌리는 한 같은 프로세스
//    안이고, 돌리지 않는 기판이면 이 파일이 애초에 그 문의 서버가 아니다.
//  · 인스턴스 열거(/instances) — 이미 갈아 끼워져 있다. getLedger()+manifest 파생이라 임베더가
//    장부 투영만 주면 그대로 자기 행을 낸다(relayos I0 실측 ②).
//  · capabilities 목록 자체 — 파생값이다. 열거·업로드 스트리밍은 이 파일의 구현이 참이라 무조건
//    이고, 하네스 계열은 harnessCapabilities 의 투영이다. push·state 는 이 파일에 라우트 자체가
//    없어 선언할 것이 없다 — 그 축을 여는 것은 계약 개정(§5.7·§5.8)이지 이음새가 아니다.
//  · 업로드 상한(MAX_UPLOAD)·마운트 문법(/pkg/<pkg>) — 전자는 소비자가 없고, 후자는 계약이
//    "기판의 마운트 지점일 뿐"이라 규정한 축이다(§2-6). 임베더는 자기 문에서 재마운트한다.

/** 세션 목록 한 행(§5.3-21) — 저장소가 무엇이든 계약이 보는 것은 이 형뿐이다.
 *  정렬은 이 파일이 한다(구현은 아무 순서나 답해도 된다) */
export interface SessionRow {
  session: string;
  label: string;
  /** epoch ms — 최근순 정렬 축 */
  updated: number;
  archived: boolean;
  pinned: boolean;
  /** 이 대화의 정체성(§5.3-21 additive) — 착지 에이전트가 아닌 대화가 밝힌다 */
  agent?: string;
  param?: string;
  /** 작업 사본 위 세션 — 고친 판을 적용 전에 써보는 대화. 설치본 대화 목록과 섞이지 않게 표시한다 */
  draft?: boolean;
  /** 사람이 연 대화가 아닌, 기계가 판 슬롯(§5.3-25 additive) — 위임(dispatch)·미션 수신(mission).
   *  판정은 슬롯 문법이지만 그건 기판 내부 어휘라(SLOT_RE 의 왜) 계약에는 이 축만 나간다.
   *  사람이 연 대화는 이 필드가 없다 — 목록은 그것으로 위임 세션을 접는다. */
  origin?: SessionOrigin;
  /** 지금 턴이 돌고 있는가(§5.3-26 additive). 없으면 미상이 아니라 **안 돌고 있음**이다 —
   *  기판은 자기 상주를 전부 알기 때문이다. 목록이 위임을 접어 두고도 진행 중인 것만
   *  세울 수 있는 근거. */
  busy?: boolean;
  /** 마지막 하네스 활동 시각(epoch ms, §5.3-26 additive). updated 와 다른 축이다:
   *  updated 는 이력 파일의 mtime 이라 **턴이 끝나야** 늘고, 이 축은 도구 하나가 도는
   *  중에도 늘어난다. 30분 도는 대화와 30분 멈춘 대화를 가르는 것이 이 차이다. */
  lastEvent?: number;
  /** 마지막 박동 시각(epoch ms, §5.3-26 additive) — 봉투가 살아 있음의 근거.
   *  lastEvent 는 오래됐는데 이 값이 방금이면 "오래 걸리는 중"이고, 둘 다 오래됐으면
   *  "멈춤"이다. 화면이 그 둘을 다르게 말하라고 나누어 둔다. */
  lastAlive?: number;
  /** 이 대화를 판 부모 대화의 슬롯(§5.3-26 additive) — 위임이 어디로 보고하는지.
   *  **같은 인스턴스 안의 슬롯**이라 목록이 그대로 짝지을 수 있다. 다른 인스턴스가 미션으로
   *  연 대화(origin=mission)에는 없다 — 부모가 이 목록 밖에 있어 슬롯 하나로는 못 가리킨다.
   *  종전엔 이 관계가 배달 클로저의 메모리에만 있어 데몬이 죽으면 함께 사라졌다. */
  parent?: string;
}

/** 개설 시점의 대화 바인딩(§5.3-22) — 판정을 통과한 값만 온다 */
export interface SessionBinding {
  agent?: string;
  param?: string;
  /** true 면 이 세션은 작업 사본 트리 위에 선다(harness.ts sessionTreeOf). 작업 사본이 없으면 400 */
  draft?: boolean;
}

/** 세션 메타 갱신(§5.3-23). 키가 있는 축만 바뀐다 */
export interface SessionPatch {
  /** null = 사용자 라벨 해제(자동 라벨 복귀) */
  label?: string | null;
  archived?: boolean;
  pinned?: boolean;
}

/** 하네스 조회 3동사의 답(§5.5-29) — value 는 어댑터 계약의 JSON 값. 비 JSON 답은 원문 문자열 */
export interface HarnessAnswer {
  ok: boolean;
  value: unknown;
}

/** 설정 쓰기 요청(§5.5-30/30-a). 키 부재 = 손대지 않음, null = 오버라이드 해제 */
export interface HarnessConfigPatch {
  model?: string | null;
  effort?: string | null;
  /** 변형 전환 — 이 전환이 모델 오버라이드를 지운다(모델 어휘는 하네스 소속) */
  harness?: string;
}

/** 설정 쓰기의 결과 — 응답의 판정값이 여기서 온다 */
export interface HarnessConfig {
  model: string | null;
  effort: string | null;
  harness: string | null;
  /** 전환이 돌린 setup 판정 — 전환 요청일 때만 실린다 */
  ready?: { ok: boolean; note: string };
}

export interface ClientWireIO {
  /** 한 턴이 딛는 좌표 — runSession·autoTitle 에 그대로 실리고, 턴 장부·무대·번들 회전도
   *  이 좌표를 딛는다. 이력 조회(history.get)는 이 이음새의 readMessages 를 지난다 */
  session: SessionIO;
  /** 계약 목록의 원천(§5.3-21) — 순서는 상관없다(정렬은 계약이 한다) */
  listSessions(pkg: string): SessionRow[] | Promise<SessionRow[]>;
  /** 세션 개설 — 기판 발급 불투명 id 를 돌려준다(§5.3-22). 바인딩은 판정을 통과한 값이다 */
  createSession(pkg: string, binding: SessionBinding): string | Promise<string>;
  /** 메타 갱신 — false = 없는 세션(계약은 404 E_NO_SESSION 으로 답한다) */
  updateSession(pkg: string, slot: string, patch: SessionPatch): boolean | Promise<boolean>;
  /** 세션 제거 — 저장소에서 이 대화의 자취를 지운다. 진행 중 상주 은퇴는 계약이 먼저 한다 */
  removeSession(pkg: string, slot: string): void | Promise<void>;
  /** 하네스 조회 3동사(§5.5-29). variant = 활성이 아닌 선언 변형에 묻기(models 의 `?variant=`) */
  harnessQuery(pkg: string, verb: "info" | "models" | "commands", variant?: string): HarnessAnswer | Promise<HarnessAnswer>;
  /** 개막(§3-7)이 투영할 어댑터 capability. null = 하네스 조회 축 자체가 없다(동사도 함께 죽는다) */
  harnessCapabilities(pkg: string): string[] | null | Promise<string[] | null>;
  /** 모델·강도·변형 설정의 영속(§5.5-30/30-a) — 이 계약 축이 장부를 쓰는 유일한 자리 */
  setHarnessConfig(pkg: string, patch: HarnessConfigPatch): HarnessConfig | Promise<HarnessConfig>;
  /** 읽기 짝 — 턴이 스폰 직전에 묻는다. 미구현이면 장부(rec.model/effort)가 답한다(1인 기판).
   *  임베더가 설정을 자기 저장소(사람별 행)에 두면 여기서 그 값을 낸다 — 안 내면 사람이 고른
   *  모델이 저장만 되고 세션에는 실리지 않는다(조직 실측 2026-08-26) */
  harnessConfig?(pkg: string): HarnessConfig | Promise<HarnessConfig>;
}

export interface ClientWireDeps {
  getLedger: () => Ledger;
  authority: Authority;
  /** 계약 축 이음새 — 미주입이면 1인 기판 좌표(localClientWireIO) */
  io?: ClientWireIO;
}

// ── http 보조 — 정본은 ../http.ts. readBody 만 여기 남는다: 신 wire 의 본문은
// JSON 단일이라(§5.0-11) 문의 form-urlencoded 분기와 계약이 다르다 ─────────────

/** 계약 오류 봉투(§5.0-10) — HTTP 상태 + {error:{code,message}}. code 는 E_ 접두 */
function fail(res: http.ServerResponse, status: number, code: string, message: string): void {
  json(res, status, { error: { code, message } });
}

/** 핸들러가 던지면 dispatch 그물이 봉투로 바꾼다 — 상태·코드를 실은 fail-loud 통로 */
class WireError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// 신 wire 의 본문은 JSON 단일이다(§5.0-11) — 구 wire 와 달리 form-urlencoded 분기가 없다
async function readBody(req: http.IncomingMessage): Promise<any> {
  // 형식 판정은 api.ts 의 Origin 검사와 짝이다: content-type 을 안 보고 파싱하면 브라우저가
  // 프리플라이트 없이 보낼 수 있는 simple request(text/plain·form)가 상태 변경 문에 그대로
  // 닿는다. 미선언은 통과 — 브라우저가 아닌 소비자(어댑터·CLI)는 헤더를 안 붙이기도 한다
  const ctype = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (ctype && ctype !== "application/json") {
    throw new WireError(415, "E_BAD_CONTENT_TYPE", `본문은 application/json 이어야 합니다: ${ctype}`);
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new WireError(400, "E_BAD_JSON", "본문이 JSON 이 아닙니다");
  }
}

/**
 * 장부를 **인자로 받는다** — deps.getLedger() 는 요청마다 파일을 다시 읽어 매번 새 객체를 준다.
 * 안에서 몰래 부르면 "레코드를 준 장부"와 "저장할 장부"가 갈려, 쓴 값이 조용히 버려진다:
 * 실사고 — POST /model 이 200 {ok:true} 를 돌려주는데 원장은 그대로였다(모델이 안 바뀐다는 보고).
 * 호출자가 자기 장부를 넘기게 해서 그 갈림이 타입에서 보이게 한다.
 */
function requirePkg(l: Ledger, pkg: string): { path: string; model?: string; effort?: string; harness?: string } {
  const rec = l.packages[pkg];
  if (!rec) throw new WireError(404, "E_NO_PKG", `미설치 패키지: ${pkg}`);
  return rec;
}

// ── SSE 프레이밍(§5.2) — 이벤트 하나 = data: JSON 하나, 15초 하트비트 :hb ────

const HEARTBEAT_MS = 15_000;

interface Sse {
  /** line 은 직렬화된 JSON 한 덩이 — data: 한 줄에 그대로 싣는다(§5.2-18) */
  send(line: string): void;
  /** 서버측 정상 종결 — settled 이후에만 부른다(§5.2-20) */
  close(): void;
  /** 절단·종결 공통 정리 콜백(구독 해제 등) */
  onClose(fn: () => void): void;
}

function openSse(req: http.IncomingMessage, res: http.ServerResponse): Sse {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "x-accel-buffering": "no",
  });
  // 이벤트 공백이 15초를 넘기 전에 주석 라인을 흘린다 — 중간 프록시 idle timeout 의
  // 조용한 절단을 §5.2-20 판정으로 드러나게 하는 최소 장치(§5.2-19)
  const hb = setInterval(() => {
    res.write(":hb\n\n");
  }, HEARTBEAT_MS);
  hb.unref?.();
  let open = true;
  const onCloseFns: (() => void)[] = [];
  const shut = (): void => {
    if (!open) return;
    open = false;
    clearInterval(hb);
    for (const f of onCloseFns) {
      try { f(); } catch { /* 정리 실패가 다른 정리를 막으면 안 된다 */ }
    }
  };
  req.on("close", shut);
  return {
    send(line: string): void {
      if (open) res.write("data: " + line + "\n\n");
    },
    close(): void {
      if (open) res.end();
      shut();
    },
    onClose(fn: () => void): void {
      onCloseFns.push(fn);
    },
  };
}

// ── 턴 단위 이벤트 장부(§6-35 리플레이 원천) ─────────────────────────────────
// 턴당 파일이다(구 events.jsonl 은 슬롯당 하나라 턴마다 truncate 되어 종결 턴 재생(§5.1-13)과
// attach 처음부터 재생(§5.1-14)의 원천이 못 된다. 신 wire 는 턴마다 독립 장부를 쓴다:
//   ~/.relay/sessions/<pkg>/<slot>/turns/<turnId>.jsonl
// 장부 한 줄 = {t, ...봉투이벤트} — 세션과 wire 가 같은 어휘로 쓰므로 라이브 SSE 와 재생이
// 같은 JSON 을 나른다(§5.2-18 의 단일 축).

const TURNS_DIR = "turns";
/** 슬롯당 보존 상한 — 재생 계약의 보존 정책은 기판 소유다. 무한 축적만 막는다 */
const TURN_LEDGER_KEEP = 200;

interface EnvelopeEvent {
  event: string;
  [k: string]: unknown;
}

interface TurnSink {
  write(line: string): void;
  end(): void;
}

interface TurnRecord {
  id: string;
  pkg: string;
  session: string;
  status: "queued" | "running" | "settled";
  ok: boolean | null;
  /** 턴 장부 경로 — 202 시점에 빈 파일로 실재한다(stream 이 즉시 붙어도 읽을 파일이 있게) */
  file: string;
  sinks: Set<TurnSink>;
  /** reply/error 봉투가 장부를 지나갔는가 — 지나지 않은 턴만 종결 봉투를 합성한다 */
  settledEnvelope: boolean;
  /** 봉투 file 이벤트가 이미 알린 stage 상대경로 — 종결 시 무대 산출물 중복 고지를 막는다 */
  announcedFiles: Set<string>;
  /** 입양 턴의 종결 신호 — 세션 사슬(§5.1-12)이 이 턴 뒤에 선 wire 턴을 기다리는 근거 */
  onSettled?: () => void;
}

const turns = new Map<string, TurnRecord>();
/** 세션별 턴 열 — [0] 이 진행(또는 다음 실행) 턴. attach 의 착지점 */
const sessionQueues = new Map<string, TurnRecord[]>();
/** 세션 직렬화 지점(§5.1-12) — 기판만이 세션의 유일한 직렬화 지점이다 */
const sessionChains = new Map<string, Promise<void>>();

function sessionKey(pkg: string, session: string): string {
  return pkg + "/" + session;
}

/** 그 세션의 진행 중 턴 — running 이 없으면 첫 queued. 없으면 null */
function activeTurn(pkg: string, session: string): TurnRecord | null {
  return sessionQueues.get(sessionKey(pkg, session))?.[0] ?? null;
}

// ── 관찰 다중화(§5.2-20-a, capability observe) — 세션 여러 개의 턴 이벤트를 SSE 한 줄기로 ──
// 브라우저의 HTTP/1.1 origin 커넥션 예산(6)이 관찰 SSE 에 잠식되는 것을 막는다: 탭 셸은 pane 마다
// 자기 세션을 관찰하므로 세션 수만큼 커넥션이 열렸다(§5.2 예산 조항의 실사고). 관찰자 하나 =
// 커넥션 하나, 구독 세션은 POST 로 늘리고 줄인다. 줄기의 이벤트 줄에는 turn·session 이 덧붙는다.
// 세션 구독은 §5.1-14 attach 와 같은 골격이다 — 관찰 창(진행·대기 턴)의 장부를 재생하고 라이브를
// 잇는다. 구독 뒤에 서는 턴(개설·입양)은 observe/turn 으로 알리고 같은 줄기에 싣는다.

const OBSERVER_ID_RE = /^[A-Za-z0-9-]{1,80}$/;

interface Observer {
  id: string;
  pkg: string;
  sse: Sse;
  sessions: Set<string>;
  /** 이 관찰자가 턴에 꽂은 싱크 — 구독을 걷거나 줄기가 닫힐 때 함께 걷는다 */
  sinks: Map<TurnRecord, TurnSink>;
}
const observers = new Map<string, Observer>(); // `${pkg}/${id}` → 열린 줄기
const sessionObservers = new Map<string, Set<Observer>>(); // sessionKey → 구독 중 관찰자

function observerKey(pkg: string, id: string): string {
  return pkg + "/" + id;
}

/** 이벤트 줄에 좌표를 덧붙인다 — 한 줄기에 여러 턴이 흐르므로 소비자가 나눌 열쇠다. 장부 줄은
 *  검증된 JSON 객체라 첫 중괄호 뒤에 끼워 넣는다(파싱·재직렬화 없이). 수명주기 turn 이벤트가
 *  이미 든 turn·session 은 같은 값이라 중복 키가 뜻을 바꾸지 않는다. */
function tagLine(line: string, turn: string, session: string): string {
  const head = JSON.stringify({ turn, session });
  if (line.length > 2 && line.startsWith("{")) return head.slice(0, -1) + "," + line.slice(1);
  return head;
}

function observerSink(obs: Observer, t: TurnRecord): void {
  if (obs.sinks.has(t)) return;
  const sink: TurnSink = {
    write: (line) => obs.sse.send(tagLine(line, t.id, t.session)),
    end: () => { obs.sinks.delete(t); }, // 턴 종결은 settled 줄이 말한다 — 줄기는 닫지 않는다
  };
  obs.sinks.set(t, sink);
  t.sinks.add(sink);
}

/** 세션 구독 — 관찰 창의 턴 목록을 알리고, 각 턴의 장부 재생 + 라이브. 재생→구독 사이에 await 가
 *  없어야 한다(동기 한 틱 안이라 이벤트가 새지 않는다). */
function observeSession(obs: Observer, session: string): void {
  obs.sessions.add(session);
  const key = sessionKey(obs.pkg, session);
  const set = sessionObservers.get(key) ?? new Set<Observer>();
  set.add(obs);
  sessionObservers.set(key, set);
  const q = sessionQueues.get(key) ?? [];
  obs.sse.send(JSON.stringify({ t: Date.now(), event: "observe", status: "session", session, turns: q.map((t) => t.id) }));
  for (const t of q) {
    for (const line of ledgerLines(t.file)) obs.sse.send(tagLine(line, t.id, session));
    if (t.status !== "settled") observerSink(obs, t);
  }
}

function unobserveSession(obs: Observer, session: string): void {
  obs.sessions.delete(session);
  const key = sessionKey(obs.pkg, session);
  const set = sessionObservers.get(key);
  if (set) {
    set.delete(obs);
    if (!set.size) sessionObservers.delete(key);
  }
  for (const [t, sink] of [...obs.sinks]) {
    if (t.session !== session) continue;
    t.sinks.delete(sink);
    obs.sinks.delete(t);
  }
}

/** 구독 중인 세션에 턴이 새로 서면(개설·입양) 알리고 싱크를 꽂는다. 장부는 비었거나 첫 줄뿐이지만
 *  같은 골격으로 재생한다 — 입양 턴은 첫 이벤트가 개설 알림보다 먼저 적힐 수 있다. */
function announceTurn(t: TurnRecord): void {
  const set = sessionObservers.get(sessionKey(t.pkg, t.session));
  if (!set) return;
  for (const obs of set) {
    obs.sse.send(JSON.stringify({ t: Date.now(), event: "observe", status: "turn", session: t.session, turn: t.id }));
    for (const line of ledgerLines(t.file)) obs.sse.send(tagLine(line, t.id, t.session));
    observerSink(obs, t);
  }
}

function closeObserver(obs: Observer): void {
  const key = observerKey(obs.pkg, obs.id);
  if (observers.get(key) === obs) observers.delete(key);
  for (const s of [...obs.sessions]) unobserveSession(obs, s);
}

/** 라이브 중계 + 상태 — 봉투 이벤트는 번역 없이 그대로 나른다(§6-35 데몬=파이프).
 *  기록하지 않는다: 세션이 이미 같은 줄을 장부에 썼다(harness.ts appendEvent). */
function relayTurnEvent(t: TurnRecord, ev: EnvelopeEvent): void {
  if (ev.event === "reply" || ev.event === "error") t.settledEnvelope = true;
  if (ev.event === "file" && typeof ev.path === "string") t.announcedFiles.add(ev.path);
  const line = JSON.stringify({ t: Date.now(), ...ev });
  for (const s of [...t.sinks]) s.write(line);
}

/** wire 자신이 내는 이벤트 — 개설·종결·합성 reply·stage diff 고지. 세션이 모르는 것들이라
 *  여기가 유일한 writer 다. 세션의 기록과 한 파일에 붙지만 append 는 순차라 섞이지 않는다 */
function appendTurnEvent(t: TurnRecord, ev: EnvelopeEvent): void {
  const line = JSON.stringify({ t: Date.now(), ...ev });
  try {
    fs.appendFileSync(t.file, line + "\n");
  } catch { /* 세션 삭제 경합 — 기록만 포기, 라이브 중계는 계속 */ }
  if (ev.event === "reply" || ev.event === "error") t.settledEnvelope = true;
  if (ev.event === "file" && typeof ev.path === "string") t.announcedFiles.add(ev.path);
  for (const s of [...t.sinks]) s.write(line);
}

/**
 * runSession 이벤트 스트림에 얹는 기록 훅 — session.ts 의 봉투 기록 지점이 부른다
 * (배선은 api.ts createApi 의 setEnvelopeTap(tapSessionEvent) — session→client-wire 직접
 * import 는 순환이라 조립점이 주입한다).
 * wire 밖에서 열린 턴(도구 위임·트리거·CLI)의 이벤트도 여기 온다 — 그 턴은 세션이 개설을
 * 알릴 때 입양되므로(adoptSessionTurn) 활성 턴이 서 있고, 중계는 wire 가 연 턴과 같다.
 */
export function tapSessionEvent(pkg: string, slot: string, ev: EnvelopeEvent): void {
  const t = activeTurn(pkg, slot);
  if (!t || t.status !== "running") return;
  // 기록은 세션이 이미 했다(SessionInput.turnLedger) — 여기서는 라이브 중계와 상태만.
  // 한 봉투를 두 자리에서 쓰던 이중 기록의 해소점이다
  relayTurnEvent(t, ev);
}

/**
 * wire 밖에서 열린 턴을 관찰 창에 들인다 — 도구 위임(서브에이전트·a2a)·트리거·CLI 처럼
 * runSession 을 직접 부른 턴이다. 세션이 자기 턴 좌표를 알리면(harness TurnTap) 여기서 그
 * 턴의 기록을 세운다.
 *
 * 왜 필요한가: 관찰(재부착·attach·SSE)은 전부 **턴 id** 로 붙는다. 입양이 없으면 /history 는
 * busy 만 답하고 실을 id 가 없어(§5.3-24), 화면은 물음 하나만 그린 채 멈춘다 — 위임 대화가
 * "아무 일도 안 일어나는 것처럼" 보이던 자리다(2026-08-25 실사용 보고). 도는 턴은 하나인데
 * 그 턴을 볼 창이 없었을 뿐이다.
 *
 * 기록은 세션 몫이다(자기 turns/<id>.jsonl 에 쓴다) — 여기는 개설 표식과 중계·종결만 얹는다.
 */
export function adoptSessionTurn(pkg: string, slot: string, turn: { id: string; file: string }): void {
  if (turns.has(turn.id)) return;
  // wire 가 연 턴이 서 있으면 그쪽이 정본이다 — 한 슬롯에 관찰 대상 턴은 하나다
  if (activeTurn(pkg, slot)) return;
  const t: TurnRecord = {
    id: turn.id,
    pkg,
    session: slot,
    status: "running",
    ok: null,
    file: turn.file,
    sinks: new Set(),
    settledEnvelope: false,
    announcedFiles: new Set(),
  };
  turns.set(t.id, t);
  const key = sessionKey(pkg, slot);
  const q = sessionQueues.get(key) ?? [];
  q.push(t);
  sessionQueues.set(key, q);
  // 입양한 턴도 세션 사슬에 선다(§5.1-12). 없으면 이 턴이 도는 동안 도착한 wire 턴이 뒤에 줄을
  // 서지 않고 runSession 문지기("이 대화는 아직 이전 요청을 처리하는 중입니다")에 즉시 부딪힌다 —
  // 위임 탭에서 보낸 말이 전부 오류로 종결하던 실사고(2026-08-28). 종결 신호는 settleTurn 이 내고,
  // 그 시점엔 live 슬롯이 이미 풀려 있다(harness.ts finish → live.delete 가 closeObserved 보다 앞).
  const done = new Promise<void>((resolve) => { t.onSettled = resolve; });
  sessionChains.set(key, (sessionChains.get(key) ?? Promise.resolve()).then(() => done));
  announceTurn(t); // 관찰 줄기에는 개설 줄보다 먼저 알린다 — 그 줄이 싱크를 지나게
  appendTurnEvent(t, { event: "turn", status: "started", turn: t.id, session: slot });
}

/** 입양한 턴의 종결 — runTurn 의 종결 절과 같은 골격이다: 봉투 reply 가 지나가지 않았으면
 *  세션 결과로 합성하고(빈 답·구형 어댑터), 무대 산출물을 고지한 뒤 settled 로 닫는다 */
export function releaseSessionTurn(
  pkg: string,
  slot: string,
  turnId: string,
  outcome: { ok: true; result: SessionResult } | { ok: false; message: string },
): void {
  const t = turns.get(turnId);
  if (!t || t.pkg !== pkg || t.session !== slot) return;
  if (outcome.ok) {
    for (const f of outcome.result.files ?? []) {
      if (!t.announcedFiles.has(f.path)) appendTurnEvent(t, { event: "file", path: f.path });
    }
    if (!t.settledEnvelope) {
      const r = outcome.result;
      appendTurnEvent(t, { event: "reply", text: r.reply, model: r.model ?? null, usage: r.usage ?? null, context: r.context ?? null });
    }
  } else if (!t.settledEnvelope) {
    appendTurnEvent(t, { event: "error", message: outcome.message });
  }
  settleTurn(t, outcome.ok);
}

function settleTurn(t: TurnRecord, ok: boolean): void {
  if (t.status === "settled") return;
  t.status = "settled";
  t.ok = ok;
  // 수명주기 settled(§6-36) — 스트림의 마지막 이벤트. 장부에도 앉아 재생이 같은 종결을 본다
  appendTurnEvent(t, { event: "turn", status: "settled", turn: t.id, ok });
  t.onSettled?.(); // 입양 턴 뒤에 선 wire 턴의 차례
  const key = sessionKey(t.pkg, t.session);
  const q = sessionQueues.get(key);
  if (q) {
    const i = q.indexOf(t);
    if (i >= 0) q.splice(i, 1);
    if (!q.length) {
      sessionQueues.delete(key);
      sessionChains.delete(key);
    }
  }
  // settled 후 서버가 스트림을 닫는다(§5.2-20)
  for (const s of [...t.sinks]) s.end();
  t.sinks.clear();
  // 종결한 턴은 메모리에서 내려간다 — 재생의 원천은 디스크 장부(findTurnFile)라 stream 은
  // 그대로 성립한다. 이 삭제가 없으면 데몬 수명 동안 턴 레코드가 무한 누적된다
  turns.delete(t.id);
}

async function runTurn(deps: ClientWireDeps, io: ClientWireIO, t: TurnRecord, body: any): Promise<void> {
  if (t.status === "settled") return; // 대기 중 interrupt 로 이미 종결된 턴
  t.status = "running";
  // 수명주기 started(§6-36) — 관찰이 어느 턴에 붙었는지의 에코. 장부 첫 줄이라 attach 재생에서도 맨 앞
  appendTurnEvent(t, { event: "turn", status: "started", turn: t.id, session: t.session });
  let ok = false;
  try {
    // 이 사람의 모델·강도 — 이음새가 답하면 그것, 아니면 장부(runSession 이 rec 를 본다)
    const cfg = io.harnessConfig ? await io.harnessConfig(t.pkg) : null;
    const r = await runSession({
      ledger: deps.getLedger(),
      pkg: t.pkg,
      authority: deps.authority,
      ...(cfg?.model ? { model: cfg.model } : {}),
      ...(cfg?.effort ? { effort: cfg.effort } : {}),
      // 계약 축과 실행 축이 같은 좌표를 딛는다 — 여기서 세션 이음새를 안 실으면 화면이 보는
      // 대화(이 파일의 history.get)와 하네스가 쌓는 대화가 서로 다른 저장소로 갈린다
      io: io.session,
      prompt: String(body.message ?? ""),
      slot: t.session,
      // agent 미지정 개설은 runSession 이 슬롯의 agent 메타로 폴백한다 — 위임 대화에
      // 문법 모르는 소비자가 열어도 착지 에이전트로 새지 않는다
      agent: body.agent ? String(body.agent) : undefined,
      attachments: Array.isArray(body.attachments) ? body.attachments : undefined,
      scene: body.scene ? String(body.scene) : undefined,
      // 이 턴의 장부 — 세션이 봉투를 여기 직접 쓴다. 종전에는 세션이 events.jsonl 에,
      // wire 가 tap 으로 같은 봉투를 여기 또 썼다(같은 줄을 두 파일에 두 번)
      turnLedger: t.file,
    });
    // 무대 산출물 고지 — 구 wire 는 이것을 응답의 files 로 실어 보냈다(구 POST /chat).
    // 신 wire 의 자리는 봉투 어휘의 file 이벤트다(§6-35): stage diff 로만 발견된 파일은
    // 어댑터가 알린 적이 없으므로 여기서 알린다. settled 앞이라 재생에서도 같은 자리에 온다
    for (const f of r.files ?? []) {
      if (!t.announcedFiles.has(f.path)) appendTurnEvent(t, { event: "file", path: f.path });
    }
    // 봉투 reply 가 훅(tapSessionEvent)으로 이미 지나갔으면 합성하지 않는다 — 이중 종결 방지.
    // 지나지 않은 경우(훅 미배선·구형 통짜 어댑터)는 runSession 결과로 종결 봉투를 세운다
    if (!t.settledEnvelope) {
      appendTurnEvent(t, { event: "reply", text: r.reply, model: r.model ?? null, usage: r.usage ?? null, context: r.context ?? null });
    }
    ok = true;
  } catch (e) {
    if (!t.settledEnvelope) {
      appendTurnEvent(t, { event: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }
  settleTurn(t, ok);
  // 첫 교환이 완결된 무명 세션의 자동 제목 — 구 /chat 관용구 유지(fire-and-forget)
  void autoTitleSession(deps.getLedger(), t.pkg, t.session, io.session).catch(() => { /* 제목 실패는 무시 */ });
}

function pruneTurnLedgers(dir: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".jsonl"));
  if (files.length <= TURN_LEDGER_KEEP) return;
  const dated = files
    .map((e) => {
      const p = path.join(dir, e.name);
      let mt = 0;
      try { mt = fs.statSync(p).mtimeMs; } catch { /* 경합 삭제 */ }
      return { p, mt };
    })
    .sort((a, b) => a.mt - b.mt);
  for (const f of dated.slice(0, dated.length - TURN_LEDGER_KEEP)) fs.rmSync(f.p, { force: true });
}

function enqueueTurn(deps: ClientWireDeps, io: ClientWireIO, pkg: string, session: string, body: any): TurnRecord {
  // 턴 장부의 파일 자리는 주입된 세션 좌표를 따라간다(세션도 같은 자리에 쓴다)
  const dir = path.join(io.session.sessionDir(pkg, session), TURNS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  pruneTurnLedgers(dir);
  const id = crypto.randomUUID();
  const t: TurnRecord = {
    id,
    pkg,
    session,
    status: "queued",
    ok: null,
    file: path.join(dir, id + ".jsonl"),
    sinks: new Set(),
    settledEnvelope: false,
    announcedFiles: new Set(),
  };
  fs.writeFileSync(t.file, "");
  turns.set(id, t);
  const key = sessionKey(pkg, session);
  const q = sessionQueues.get(key) ?? [];
  q.push(t);
  sessionQueues.set(key, q);
  announceTurn(t); // 구독 중인 관찰 줄기에 이 턴이 선다(§5.2-20-a)
  // 같은 세션의 진행 중 턴 뒤에 도착순으로 직렬화한다(§5.1-12) — 클라이언트 큐는 은퇴
  const chain = (sessionChains.get(key) ?? Promise.resolve()).then(() => runTurn(deps, io, t, body));
  sessionChains.set(key, chain.catch(() => { /* runTurn 은 던지지 않는다 — 사슬 보존 그물 */ }));
  return t;
}

// 턴 id 는 서버 발급(randomUUID)이라 이 문법이 전부다 — 경로 인자의 탈출 방지 검증
const TURN_ID_RE = /^[A-Za-z0-9-]{1,80}$/;

/** 종결 턴 장부 찾기 — 데몬 재기동 후에도 stream 재생(§5.1-13)이 성립하는 근거.
 *  후보 슬롯은 계약 목록에서 온다: 좌표를 옮긴 임베더는 자기 저장소를 열거하고, 이 파일은
 *  그 슬롯의 세션 좌표 아래에서 장부를 찾는다. 기판 내부 슬롯("_" 접두 — 자동 제목의 임시
 *  세션)은 목록에 없고 wire 가 턴을 열지도 않으므로 후보가 아니다 */
async function findTurnFile(io: ClientWireIO, pkg: string, id: string): Promise<string | null> {
  if (!TURN_ID_RE.test(id)) return null;
  for (const row of await io.listSessions(pkg)) {
    const f = path.join(io.session.sessionDir(pkg, row.session), TURNS_DIR, id + ".jsonl");
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function ledgerLines(file: string): string[] {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      JSON.parse(l); // 부서진 줄(기록 중 사망)은 재생하지 않는다 — data: 는 JSON 한 덩이어야 한다
      out.push(l);
    } catch { /* skip */ }
  }
  return out;
}

/** 진행 중(또는 방금 종결된 메모리 내) 턴에 관찰을 붙인다 — 장부 재생 후 라이브(§5.1-13/14) */
function openLiveStream(t: TurnRecord, req: http.IncomingMessage, res: http.ServerResponse): void {
  const sse = openSse(req, res);
  // 재생→구독 사이에 await 가 없어야 한다 — 동기 한 틱 안이라 이벤트가 새지 않는다
  for (const line of ledgerLines(t.file)) sse.send(line);
  if (t.status === "settled") return void sse.close();
  const sink: TurnSink = {
    write: (line) => sse.send(line),
    end: () => sse.close(),
  };
  t.sinks.add(sink);
  // 클라이언트 절단은 관찰만 사라진다 — 턴은 계속 돌고, 복귀는 attach(§5.2-20)
  sse.onClose(() => t.sinks.delete(sink));
}

/** 디스크 장부만 남은 종결 턴 — 재생 후 즉시 종결·EOF. settled 없는 장부(데몬 사망 턴)는
 *  영원히 종결되지 않을 턴이므로 합성 settled(ok:false)로 정직하게 닫는다 */
function replaySettledFile(req: http.IncomingMessage, res: http.ServerResponse, file: string, id: string): void {
  const sse = openSse(req, res);
  let settled = false;
  for (const line of ledgerLines(file)) {
    sse.send(line);
    try {
      const ev = JSON.parse(line);
      if (ev.event === "turn" && ev.status === "settled") settled = true;
    } catch { /* ledgerLines 가 걸렀다 */ }
  }
  if (!settled) sse.send(JSON.stringify({ t: Date.now(), event: "turn", status: "settled", turn: id, ok: false }));
  sse.close();
}

// ── 1인 기판의 계약 축 이음새 — RELAY_HOME 세션 살림·동봉 어댑터·파일 장부 ──────
// 미주입 시 이것이 꽂히므로 기존 소비자는 무영향이다. 장부는 getLedger 를 늦게 부른다
// (권위·세션 이음새와 같은 관용구 — 요청마다 신선한 장부를 본다).

// effort capability 는 하네스 어댑터 capability 의 투영(§7)이다. 어댑터 info 는 프로세스
// 1회 비용이라 entry mtime 캐시로 어댑터당 한 번만 돈다(session.ts serveCache 와 같은 결).
// 캐시가 담는 것은 **파생된 capability 목록**이지 info 원문이 아니다 — info 에는 계정 상태처럼
// 어댑터 파일과 무관하게 변하는 값이 실려서, 통째로 굳히면 로그인이 화면에 늦게 선다
const capsCache = new Map<string, { mtime: number; caps: string[] }>();

function sessionsRoot(pkg: string): string {
  return path.join(RELAY_HOME, "sessions", pkg);
}

export function localClientWireIO(getLedger: () => Ledger): ClientWireIO {
  const meta = (dir: string, name: string): string => {
    try {
      return fs.readFileSync(path.join(dir, name), "utf8").trim();
    } catch {
      return ""; // 메타 없음
    }
  };
  return {
    session: localSessionIO(getLedger),

    /** 라벨 우선순위(사용자 label > auto-label > 첫 발화)는 기판 내부 규칙이다 — 계약은 label 만 본다 */
    listSessions: (pkg) => {
      const root = sessionsRoot(pkg);
      if (!fs.existsSync(root)) return [];
      const rows: SessionRow[] = [];
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        // "_" 접두 슬롯은 기판 내부용(자동 제목 등의 임시 세션) — 목록에 내지 않는다
        if (!e.isDirectory() || !SLOT_RE.test(e.name) || e.name.startsWith("_")) continue;
        const dir = path.join(root, e.name);
        const hist = path.join(dir, "history.jsonl");
        let label = meta(dir, "label") || meta(dir, "auto-label");
        if (!label && fs.existsSync(hist)) {
          try {
            label = String(JSON.parse(fs.readFileSync(hist, "utf8").split("\n", 1)[0]).text ?? "").slice(0, 40);
          } catch {
            label = "";
          }
        }
        const rowAgent = meta(dir, "agent");
        const rowParam = meta(dir, "param");
        const rowParent = meta(dir, "parent");
        const origin = slotOrigin(e.name);
        // 목록은 디스크를 읽고 생존은 메모리에 있다 — 행을 세우는 이 자리가 둘이 만나는
        // 유일한 지점이다. 상주가 없으면 축이 통째로 빠진다(없음 = 안 돌고 있음)
        const liveness = sessionLiveness(pkg, e.name);
        rows.push({
          session: e.name,
          ...(rowAgent ? { agent: rowAgent } : {}),
          ...(rowParam ? { param: rowParam } : {}),
          ...(rowParent ? { parent: rowParent } : {}),
          ...(origin ? { origin } : {}),
          ...(liveness?.busy ? { busy: true } : {}),
          ...(liveness?.lastEvent ? { lastEvent: liveness.lastEvent } : {}),
          ...(liveness?.lastAlive ? { lastAlive: liveness.lastAlive } : {}),
          ...(fs.existsSync(path.join(dir, "draft")) ? { draft: true } : {}),
          label: label || e.name,
          updated: fs.statSync(fs.existsSync(hist) ? hist : dir).mtimeMs,
          archived: fs.existsSync(path.join(dir, "archived")),
          pinned: fs.existsSync(path.join(dir, "pinned")),
        });
      }
      return rows;
    },

    createSession: (pkg, binding) => {
      // 세션 id 는 기판 발급 불투명 문자열(§5.3-22) — SLOT_RE 는 내부 문법일 뿐 계약이 아니다
      const id = "s-" + Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex");
      const dir = sessionDir(pkg, id); // 즉시 영속 — 발급한 세션이 목록·이력 조회에 곧장 실재한다
      if (binding.agent) fs.writeFileSync(path.join(dir, "agent"), binding.agent);
      if (binding.param) fs.writeFileSync(path.join(dir, "param"), binding.param);
      if (binding.draft) fs.writeFileSync(path.join(dir, "draft"), "");
      return id;
    },

    updateSession: (pkg, slot, patch) => {
      const dir = sessionPath(pkg, slot);
      if (!fs.existsSync(dir)) return false;
      if ("label" in patch) {
        // marker/라벨 파일 하나가 상태의 전부 — 이력은 그대로 두고 목록의 자리만 옮긴다(§5.3-23)
        if (patch.label) fs.writeFileSync(path.join(dir, "label"), patch.label);
        else fs.rmSync(path.join(dir, "label"), { force: true });
      }
      for (const [key, marker] of [["archived", "archived"], ["pinned", "pinned"]] as const) {
        if (!(key in patch)) continue;
        const p = path.join(dir, marker);
        if (patch[key]) fs.writeFileSync(p, "");
        else fs.rmSync(p, { force: true });
      }
      return true;
    },

    // sessionPath 인 이유: 삭제가 살림을 먼저 만들면 안 된다(없는 세션의 삭제가 빈 디렉토리를 남긴다)
    removeSession: (pkg, slot) => fs.rmSync(sessionPath(pkg, slot), { recursive: true, force: true }),

    harnessQuery: async (pkg, verb, variant) => {
      const r = await harnessVerb(getLedger(), pkg, verb, variant);
      let value: unknown;
      try {
        value = JSON.parse(r.out);
      } catch {
        value = r.out; // 비 JSON 답 — 원문 그대로가 정직하다
      }
      return { ok: r.ok, value };
    },

    harnessCapabilities: async (pkg) => {
      const l = getLedger();
      const rec = l.packages[pkg];
      if (!rec) return null;
      let m: Manifest;
      try {
        m = loadManifest(rec.path);
      } catch {
        return null;
      }
      const v = selectHarness(m, rec.harness, l.preferences?.harness);
      if (!v) return null; // 하네스 미동봉 — harness 조회 동사 자체가 없다
      const entry = harnessEntry(rec.path, v);
      let mtime: number;
      try {
        mtime = fs.statSync(entry).mtimeMs;
      } catch {
        return null;
      }
      const hit = capsCache.get(entry);
      if (hit && hit.mtime === mtime) return hit.caps;
      let caps: string[] = [];
      try {
        const j = JSON.parse((await harnessVerb(getLedger(), pkg, "info")).out || "{}");
        if (Array.isArray(j.capabilities)) caps = j.capabilities.filter((c: unknown): c is string => typeof c === "string");
      } catch { /* info 불달 — 어댑터 capability 없음으로 판정(선언 못 하는 것이 정직) */ }
      capsCache.set(entry, { mtime, caps });
      return caps;
    },

    setHarnessConfig: async (pkg, patch) => {
      const l = getLedger();
      const rec = l.packages[pkg];
      if (!rec) throw new Error(`미설치 패키지: ${pkg}`);
      let ready: { ok: boolean; note: string } | undefined;
      // 변형 전환이 먼저다 — setHarness 가 모델 오버라이드를 지우므로(모델 어휘는 하네스 소속),
      // 같은 요청의 model 이 그 뒤에 앉아야 지워지지 않는다. 미선언 이름은 거부된다.
      // 전환은 setup 을 이미 돌린다 — 그 판정을 버리지 않는다: 준비 안 된 하네스로 바꾼 사람에게
      // 아무 말도 안 하면 다음 턴이 실패할 때까지 "왜 안 되지" 가 남는다(실사고: 네이티브
      // 바이너리가 빠진 codex 로 전환 → 무신호)
      if (patch.harness) {
        const r = await setHarness(l, pkg, patch.harness);
        ready = { ok: r.setup.ok, note: r.setup.out.split("\n").slice(0, 2).join(" · ") };
      }
      if ("model" in patch) rec.model = patch.model ?? undefined;
      if ("effort" in patch) rec.effort = patch.effort ?? undefined;
      saveLedger(l);
      return { model: rec.model ?? null, effort: rec.effort ?? null, harness: rec.harness ?? null, ...(ready ? { ready } : {}) };
    },
  };
}

// ── 계약이 소유하는 판정 — 이음새가 아니라 이 파일이 답하는 것 ────────────────

/** §5.3-21 정렬 — 고정 우선, 그 안에서 최근순. 구현은 아무 순서나 답해도 계약 순서로 나간다 */
function sortSessionRows(rows: SessionRow[]): SessionRow[] {
  return [...rows].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updated - a.updated);
}

/** 대화 장부 → 계약 message shape(§5.3-24: role·text·files?·usage?·context?·model?).
 *  장부의 원천은 세션 이음새다 — 계약 축이 자기 리더를 따로 가지면 임베더의 정본과 화면이 갈린다 */
function historyMessages(io: ClientWireIO, pkg: string, slot: string, limit: number): Record<string, unknown>[] {
  return io.session.readMessages(pkg, slot).slice(-limit).map((rec) => ({
    role: String(rec.role ?? ""),
    text: String(rec.text ?? ""),
    ...(rec.files ? { files: rec.files } : {}),
    ...(rec.usage ? { usage: rec.usage } : {}),
    ...(rec.context ? { context: rec.context } : {}),
    ...(rec.model ? { model: rec.model } : {}),
  }));
}

/** 착지 에이전트의 패키지 커맨드 — harness.commands 병합의 기판 반쪽(api.ts pkgCommands 사본, 컷에서 단일화) */
function pkgCommandRows(ledger: Ledger, pkg: string): { name: string; description: string; tty: boolean }[] {
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

// ── 라우팅 테이블 — 경로 패턴(base/root 상대) → 핸들러 ──────────────────────
// {base}=/pkg/<pkg> · {root}=/ 는 기판의 마운트 지점이지 계약이 아니다(§2-6).
// 클라이언트는 base 주입으로 이 좌표를 받는다 — 마운트 문법을 아는 쪽은 이 파일뿐이다.

export interface WireCtx {
  deps: ClientWireDeps;
  /** 해석된 계약 축 이음새 — deps.io 또는 1인 기판 기본 구현 */
  io: ClientWireIO;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  /** base 스코프의 마운트 키(패키지 이름). root 스코프는 빈 문자열 */
  pkg: string;
  m: RegExpMatchArray;
}

export interface WireRoute {
  methods: string[];
  scope: "base" | "root";
  pattern: RegExp;
  handler: (ctx: WireCtx) => void | Promise<void>;
}

const MAX_UPLOAD = 100 * 1024 * 1024;

export const WIRE_ROUTES: WireRoute[] = [
  // ── 개막(§3-7): {protocol, capabilities}. push·state 는 OSS 미구현 — 목록에서 뺀다(§3-8) ──
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/capabilities$/,
    handler: async ({ deps, io, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      // enumerate: /registry 재포장으로 구현(§5.6-32) · upload-progress: 업로드가 전 구간
      // 스트리밍이라 진행률이 실제를 반영한다(§5.4-28, 아래 upload 핸들러가 그 구현)
      // observe: 관찰 다중화 줄기(§5.2-20-a) — 이 파일이 구현하므로 무조건이다
      const caps = ["enumerate", "upload-progress", "observe"];
      const adapter = await io.harnessCapabilities(pkg);
      if (adapter) {
        // 하네스 조회 3동사는 어댑터 필수 동사(info/models/commands)의 중계라 하네스가 있으면 산다
        caps.push("harness-info", "harness-models", "harness-commands");
        if (adapter.includes("effort")) caps.push("effort"); // 어댑터 capability 의 투영(§7)
        // 얹기도 같은 투영이다(§7 steer) — 얹을 프로세스가 있는 하네스만 선언한다.
        // 미선언이면 화면은 큐 의미론으로 떨어진다(§5.1-16-a): 어느 쪽이든 사용자가 턴
        // 중에 친 말은 잃지 않고, 갈리는 것은 **언제 전달되는가** 하나뿐이다
        if (adapter.includes("steer")) caps.push("steer");
        // 변형 선택은 자격 행위가 아니라 설정이다(§5.5-30-a) — 매니페스트가 후보를 선언하고
        // 장부가 활성 하나를 든다. 후보가 둘 이상일 때만 고를 것이 있다.
        try {
          const man = loadManifest(deps.getLedger().packages[pkg].path);
          if ((man.harness?.variants ?? []).length > 1) caps.push("harness-variants");
        } catch { /* 판정 실패 설치본 — 선언 못 하는 것이 정직 */ }
      }
      json(res, 200, { protocol: CLIENT_PROTOCOL, capabilities: caps });
    },
  },

  // ── 턴(§5.1): 비블로킹 시작 + SSE 관찰 ──────────────────────────────────
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/turns$/,
    handler: async ({ deps, io, req, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const b = await readBody(req);
      const session = String(b.session ?? "");
      if (!SLOT_RE.test(session)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${session}`);
      // 개설도 민팅(POST /sessions)과 같은 것을 거절한다 — 선언 밖 이름은 400 이지, 열렸다가
      // 스트림 중간에 죽는 턴이 아니다. 이 문이 없으면 runSession 의 관문까지 내려가 봉투
      // 오류가 되는데, 요청 자체가 틀린 것은 개설 지점에서 답하는 편이 정직하다
      const agent = String(b.agent ?? "").trim();
      if (agent && !(loadManifest(deps.getLedger().packages[pkg].path).agents ?? []).some((a) => a.name === agent)) {
        throw new WireError(400, "E_BAD_AGENT", `agents[] 선언 밖 에이전트: ${agent}`);
      }
      const t = enqueueTurn(deps, io, pkg, session, b);
      // 202 — 턴 종결을 붙들지 않는다(§5.1-12). 관찰은 stream/attach 로 몇 번이든 다시 연다
      json(res, 202, { turn: t.id, session });
    },
  },
  // ── 관찰 다중화(§5.2-20-a): 줄기 열기 + 구독 편집 ──
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/observe$/,
    handler: ({ deps, req, res, url, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const id = String(url.searchParams.get("id") ?? "");
      if (!OBSERVER_ID_RE.test(id)) throw new WireError(400, "E_BAD_OBSERVER", `관찰자 id 형식 위반: ${id}`);
      const key = observerKey(pkg, id);
      observers.get(key)?.sse.close(); // 같은 id 의 재접속 — 이전 줄기는 대체된다(§5.2 ③)
      const sse = openSse(req, res);
      const obs: Observer = { id, pkg, sse, sessions: new Set(), sinks: new Map() };
      observers.set(key, obs);
      sse.onClose(() => closeObserver(obs));
      sse.send(JSON.stringify({ t: Date.now(), event: "observe", status: "ready", id }));
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/observe\/([A-Za-z0-9-]{1,80})\/sessions$/,
    handler: async ({ deps, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const obs = observers.get(observerKey(pkg, m[1]));
      if (!obs) throw new WireError(404, "E_NO_OBSERVER", `열린 관찰 줄기 없음: ${m[1]}`);
      const b = await readBody(req);
      const list = (v: unknown): string[] => (Array.isArray(v) ? v : []).map((x) => String(x));
      for (const sid of list(b.remove)) if (SLOT_RE.test(sid)) unobserveSession(obs, sid);
      for (const sid of list(b.add)) {
        if (!SLOT_RE.test(sid)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${sid}`);
        if (obs.sessions.has(sid)) unobserveSession(obs, sid); // 재구독 = 재생부터 다시(§5.1-14)
        observeSession(obs, sid);
      }
      json(res, 200, { ok: true, sessions: [...obs.sessions] });
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/turns\/attach$/,
    handler: ({ deps, req, res, url, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const session = String(url.searchParams.get("session") ?? "");
      if (!SLOT_RE.test(session)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${session}`);
      // 관찰 창에 선 턴이면 붙는다 — wire 가 개설한 턴과 입양한 턴(도구 위임·트리거)이
      // 같은 자리에 선다. 그 창 밖(개설 알림 없는 턴)은 E_NO_TURN 이 맞다(§5.1-14)
      const t = activeTurn(pkg, session);
      if (!t) throw new WireError(404, "E_NO_TURN", `진행 중 턴 없음: ${session}`);
      openLiveStream(t, req, res);
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/turns\/([A-Za-z0-9-]{1,80})\/stream$/,
    handler: async ({ deps, io, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const id = m[1];
      const t = turns.get(id);
      if (t && t.pkg === pkg) return void openLiveStream(t, req, res);
      const file = await findTurnFile(io, pkg, id); // 데몬 재기동 이전의 종결 턴 — 장부 재생
      if (!file) throw new WireError(404, "E_NO_TURN", `없는 턴: ${id}`);
      replaySettledFile(req, res, file, id);
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/turns\/([A-Za-z0-9-]{1,80})\/interrupt$/,
    handler: async ({ deps, io, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const t = turns.get(m[1]);
      // 종결과 함께 메모리에서 내려간 턴 — 장부가 남아 있으면 "있었지만 끝난 턴"이라
      // ok:false 로 답한다(애초에 없는 턴의 404 와 구별한다)
      if (!t || t.pkg !== pkg) {
        if (await findTurnFile(io, pkg, m[1])) return void json(res, 200, { ok: false });
        throw new WireError(404, "E_NO_TURN", `없는 턴: ${m[1]}`);
      }
      if (t.status === "queued") {
        // 시작 전 턴 — 봉투 제어가 닿을 프로세스가 없으므로 여기서 종결한다
        appendTurnEvent(t, { event: "error", message: "시작 전에 중단되었습니다" });
        settleTurn(t, false);
        return void json(res, 200, { ok: true });
      }
      // 봉투 cancel 제어(§5.1-15) — 종결은 봉투 error 이벤트가 가져온다
      json(res, 200, { ok: cancelSession(pkg, t.session) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/turns\/([A-Za-z0-9-]{1,80})\/respond$/,
    handler: async ({ deps, io, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const t = turns.get(m[1]);
      // 종결한 턴에는 회송할 ask 가 없다 — interrupt 와 같은 판정(장부 있음 = ok:false)
      if (!t || t.pkg !== pkg) {
        if (await findTurnFile(io, pkg, m[1])) return void json(res, 200, { ok: false });
        throw new WireError(404, "E_NO_TURN", `없는 턴: ${m[1]}`);
      }
      const b = await readBody(req);
      // 봉투 ask 회송(§5.1-16) — 빈 answers = 사용자 취소
      json(res, 200, { ok: deliverAnswer(pkg, t.session, String(b.ask ?? ""), Array.isArray(b.answers) ? b.answers : []) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/turns\/([A-Za-z0-9-]{1,80})\/steer$/,
    handler: async ({ deps, io, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      // 미선언 capability 의 동사는 없는 문이다(§3-8) — 501 이 아니라 404 다
      const adapter = await io.harnessCapabilities(pkg);
      if (!adapter?.includes("steer")) throw new WireError(404, "E_NO_STEER", `얹기를 지원하지 않는 하네스입니다: ${pkg}`);
      const t = turns.get(m[1]);
      // 종결한 턴에는 얹을 자리가 없다 — interrupt·respond 와 같은 판정(장부 있음 = ok:false)
      if (!t || t.pkg !== pkg) {
        if (await findTurnFile(io, pkg, m[1])) return void json(res, 200, { ok: false });
        throw new WireError(404, "E_NO_TURN", `없는 턴: ${m[1]}`);
      }
      const b = await readBody(req);
      const prompt = String(b.prompt ?? "");
      if (!prompt.trim()) throw new WireError(400, "E_BAD_PROMPT", "빈 발화는 얹을 수 없습니다");
      // 시작 전 큐 턴에는 얹을 프로세스가 없다. ok:false 로 답해 화면을 새 턴 폴백으로 보낸다 —
      // 여기서 큐에 얹어 주면 도착순 직렬화(§5.1-12)가 이 문에서만 다르게 굽는다
      if (t.status !== "running") return void json(res, 200, { ok: false });
      // 봉투 steer 제어(§5.1-16-a). 이력 기록은 deliverSteer 안에서 얹힌 직후에 일어나고,
      // 화면에 보이는 것은 어댑터가 되돌려 주는 steer 이벤트다(장부·라이브 같은 줄)
      json(res, 200, { ok: deliverSteer(io.session, pkg, t.session, prompt) });
    },
  },

  // ── 세션(§5.3): 서버 발급 불투명 id + 부속 동사 ─────────────────────────
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/sessions$/,
    handler: async ({ deps, io, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      json(res, 200, { sessions: sortSessionRows(await io.listSessions(pkg)) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/sessions$/,
    handler: async ({ deps, io, req, res, pkg }) => {
      const ledger = deps.getLedger();
      requirePkg(ledger, pkg);
      // 대화 바인딩(§5.3-22 additive) — 화면 스레드 문법의 param 축은 기판 발급 id 에 실을 수
      // 없으므로 민팅 순간이 바인딩이 wire 에 닿는 유일한 자리다. 판정은 선언이다(agents[] 밖 =
      // 400). 기록된 메타는 §5.3-21 행으로 되돌아가고, runSession 이 페르소나 문맥으로 주입한다.
      // 판정은 계약이 하고 저장만 이음새에 맡긴다 — 구현이 갈려도 같은 것을 거절한다
      const b = await readBody(req);
      const agent = String(b.agent ?? "").trim();
      const param = String(b.param ?? "").trim();
      // 작업 사본 위 세션(additive) — 고친 판을 적용 전에 써보는 대화. 에이전트 판정도 그 나무에서
      const draft = b.draft === true;
      const tree = draft ? path.join(packagesPath(), pkg) : ledger.packages[pkg].path;
      if (draft && !fs.existsSync(tree)) throw new WireError(400, "E_NO_DRAFT", `작업 사본 없는 패키지: ${pkg}`);
      if (agent && !(loadManifest(tree).agents ?? []).some((a) => a.name === agent)) {
        throw new WireError(400, "E_BAD_AGENT", `agents[] 선언 밖 에이전트: ${agent}`);
      }
      if (param && !agent) throw new WireError(400, "E_BAD_PARAM", "param 은 agent 없이 설 수 없다");
      if (param.length > 256) throw new WireError(400, "E_BAD_PARAM", "param 이 너무 길다(≤256)");
      const id = await io.createSession(pkg, { ...(agent ? { agent } : {}), ...(param ? { param } : {}), ...(draft ? { draft: true } : {}) });
      json(res, 200, { session: id });
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/sessions\/([^/]+)\/history$/,
    handler: ({ deps, io, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const slot = m[1];
      if (!SLOT_RE.test(slot)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${slot}`);
      // busy+turn(§5.3-24) — 새로고침 복구가 폴링 없이 한 왕복으로 끝나는 근거.
      // turn 은 관찰 창에 선 턴이다 — wire 가 개설한 것과 입양한 것(도구 위임·트리거) 둘 다.
      // 창 밖 busy 는 turn 없이 나간다(붙을 수 없는 id 를 싣지 않는 것이 정직하다)
      const t = activeTurn(pkg, slot);
      const busy = t != null || isSessionBusy(pkg, slot);
      json(res, 200, { messages: historyMessages(io, pkg, slot, 200), busy, ...(t ? { turn: t.id } : {}) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/sessions\/([^/]+)\/(rename|archive|pin|delete|reset)$/,
    handler: async ({ deps, io, req, res, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      const slot = m[1];
      const op = m[2];
      if (!SLOT_RE.test(slot)) throw new WireError(400, "E_BAD_SESSION", `세션 id 형식 위반: ${slot}`);
      // 메타 3동사(§5.3-23) — 상한·빈 문자열 의미는 계약이 쥐고, 저장은 이음새가 한다.
      // false = 없는 세션(구현이 자기 저장소로 판정한다)
      const patch = async (p: SessionPatch): Promise<void> => {
        if (!(await io.updateSession(pkg, slot, p))) throw new WireError(404, "E_NO_SESSION", `없는 세션: ${slot}`);
      };
      if (op === "rename") {
        const b = await readBody(req);
        const label = String(b.label ?? "").trim().slice(0, 80);
        await patch({ label: label || null }); // 빈 문자열 = 자동 라벨 복귀(§5.3-23)
        return void json(res, 200, { ok: true });
      }
      if (op === "archive" || op === "pin") {
        const b = await readBody(req);
        // 이력은 그대로 두고 목록의 자리만 옮긴다(§5.3-23)
        const on = op === "archive" ? !!b.archived : !!b.pinned;
        await patch(op === "archive" ? { archived: on } : { pinned: on });
        return void json(res, 200, { ok: true, ...(op === "archive" ? { archived: on } : { pinned: on }) });
      }
      if (op === "delete") {
        // 대기 중 wire 턴은 먼저 종결한다 — 지워진 세션 위에서 턴 사슬이 계속 돌면 안 된다
        for (const t of [...(sessionQueues.get(sessionKey(pkg, slot)) ?? [])]) {
          if (t.status === "queued") {
            appendTurnEvent(t, { event: "error", message: "세션이 삭제되었습니다" });
            settleTurn(t, false);
          }
        }
        retireResident(pkg, slot); // 상주가 지워진 번들 경로를 물고 있으면 안 된다 — 프로세스 지역 정리
        await io.removeSession(pkg, slot);
        return void json(res, 200, { ok: true });
      }
      // reset — 이력은 두고 하네스 대화 포인터만 끊는다(§5.3-23). 포인터 파일 이름은 어댑터
      // 소유(claude-session·codex-thread·…)라 기판이 열거할 수 없다 — 종전엔 claude-session
      // 만 하드코딩해서 다른 하네스의 reset 이 무동작이었다. 번들을 통째로 비우는 것이
      // 이름을 모른 채 전부 회전시키는 유일한 방법이고, 다음 턴의 조립이 다시 채운다.
      // 이음새 밖인 이유: 번들은 이 턴을 돌리는 쪽의 작업물이라 세션 좌표를 그대로 딛는다.
      retireResident(pkg, slot); // 상주가 낡은 대화를 메모리에 물고 있으면 포인터를 지워도 대화가 이어진다
      fs.rmSync(path.join(io.session.sessionDir(pkg, slot), "bundle"), { recursive: true, force: true });
      json(res, 200, { ok: true });
    },
  },

  // ── 파일(§5.4): upload 단일 동사(+프로브) · download ────────────────────
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/upload$/,
    handler: ({ deps, io, req, res, url, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      // 업로드 프로브(§5.4-26) — 바이트 전송 없이 인가·상한을 선판정한다. 2xx = 통과
      if (String(req.headers["x-upload-probe"] ?? "") === "1") {
        const size = Number(req.headers["x-upload-size"] ?? 0);
        if (!Number.isFinite(size) || size < 0) throw new WireError(400, "E_BAD_REQUEST", "X-Upload-Size 가 숫자가 아닙니다");
        if (size > MAX_UPLOAD) throw new WireError(413, "E_TOO_LARGE", `첨부 상한 초과: ${MAX_UPLOAD} bytes`);
        return void json(res, 200, { ok: true });
      }
      // 본문이 곧 바이트다(§5.4-25) — 전 구간 스트리밍(capability upload-progress 의 실체)
      const rawName = String(url.searchParams.get("name") ?? "file");
      const name = (rawName.split(/[\\/]/).pop() ?? "file").replace(/^\.+/, "_").slice(0, 128) || "file";
      // 무대 좌표는 세션 이음새가 답한다 — 첨부가 앉는 자리와 하네스가 읽는 자리가 같아야 한다
      const dir = path.join(io.session.stageDir(pkg), UPLOADS_DIR);
      fs.mkdirSync(dir, { recursive: true });
      let target = path.join(dir, name);
      if (fs.existsSync(target)) {
        const ext = path.extname(name);
        target = path.join(dir, path.basename(name, ext) + "-" + Date.now().toString(36) + ext);
      }
      let size = 0;
      let failed = false;
      const ws = fs.createWriteStream(target);
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_UPLOAD && !failed) {
          failed = true;
          ws.destroy();
          fs.rmSync(target, { force: true });
          fail(res, 413, "E_TOO_LARGE", `첨부 상한 초과: ${MAX_UPLOAD} bytes`);
          req.destroy();
        }
      });
      req.pipe(ws);
      ws.on("finish", () => {
        // 반환 path 는 클라이언트에게 불투명 참조다(§5.4-25) — UPLOADS_PREFIX 는 기판 내부 어휘
        if (!failed) json(res, 200, { path: UPLOADS_PREFIX + path.basename(target), size, name: path.basename(target) });
      });
      ws.on("error", (e) => {
        if (!failed) fail(res, 500, "E_INTERNAL", String(e));
      });
    },
  },
  {
    methods: ["GET", "HEAD"],
    scope: "base",
    pattern: /^\/file\/(.+)$/,
    handler: ({ deps, io, req, res, url, pkg, m }) => {
      requirePkg(deps.getLedger(), pkg);
      // stage 봉인 아래에서만(§5.4-27). HEAD 는 실재 프로브
      const root = path.normalize(io.session.stageDir(pkg));
      const target = path.normalize(path.join(root, decodeURIComponent(m[1])));
      if (target !== root && !target.startsWith(root + path.sep)) throw new WireError(403, "E_FORBIDDEN", "경로 탈출");
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) throw new WireError(404, "E_NO_FILE", "없는 파일");
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
    },
  },

  // ── 하네스 조회·설정(§5.5) — 관리 동사(variants·connect·login)는 계약 밖(§5.5-31) ──
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/harness\/(info|models|commands)$/,
    handler: async ({ deps, io, url, res, pkg, m }) => {
      const rec = requirePkg(deps.getLedger(), pkg);
      const man = loadManifest(rec.path);
      // capability 미선언(하네스 미동봉) 동사 호출은 404 + 봉투(§3-8) — 코드는 기판 소유 어휘.
      // 선언(BOM)의 판정은 이 파일이 쥔다 — 이음새는 "무엇이 답인가"만 답한다
      const choice = chooseHarness(man, rec.harness, deps.getLedger().preferences?.harness);
      if (!choice.variant) throw new WireError(404, "E_NO_HARNESS", choice.reason ?? `하네스 없음: ${pkg}`);
      const verb = m[1] as "info" | "models" | "commands";
      // models 만 `?variant=` 로 활성 아닌 선언 변형의 카탈로그를 묻는다(§5.5-29) — 모델 피커가
      // 공급자에 호버했을 때 전환 없이 그 목록을 보여주는 자리. 선언 밖 이름은 요청 결함.
      const variant = verb === "models" ? (url.searchParams.get("variant") || undefined) : undefined;
      if (variant && !(man.harness?.variants ?? []).some((v) => v.name === variant)) {
        throw new WireError(400, "E_BAD_REQUEST", `미선언 하네스: ${variant}`);
      }
      const r = await io.harnessQuery(pkg, verb, variant);
      if (verb === "commands") {
        // 패키지 커맨드 + 하네스 네이티브 커맨드의 병합 — 병합은 기판 몫(§5.5-29)
        const fromHarness = Array.isArray(r.value) ? r.value : [];
        return void json(res, 200, { ok: r.ok, value: [...pkgCommandRows(deps.getLedger(), pkg), ...fromHarness] });
      }
      json(res, 200, { ok: r.ok, value: r.value });
    },
  },
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/harness\/variants$/,
    handler: ({ deps, res, pkg }) => {
      const l = deps.getLedger();
      const rec = requirePkg(l, pkg);
      const man = loadManifest(rec.path);
      const variants = (man.harness?.variants ?? []).map((v) => ({
        name: v.name,
        ...(v.llm?.provider ? { provider: v.llm.provider } : {}),
      }));
      // 준비 상태(도구 실재·로그인)는 이 문의 소관이 아니다(§5.5-30-a) — 프로브는 프로세스
      // 전수 스폰이라 채팅 문이 감당할 비용이 아니고, 기판 소유 콘솔에 그 표면이 이미 있다.
      json(res, 200, { ok: true, value: { active: rec.harness ?? variants[0]?.name ?? null, variants } });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/model$/,
    handler: async ({ deps, io, req, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const b = await readBody(req);
      // 계약 어휘 → patch. 키 부재와 "값 비움"이 다른 뜻이라 null 로 가른다(§5.5-30)
      const patch: HarnessConfigPatch = {};
      if (b.harness) patch.harness = String(b.harness);
      if ("model" in b) patch.model = b.model ? String(b.model) : null;
      if ("effort" in b) patch.effort = b.effort ? String(b.effort) : null;
      // 상주는 이전 하네스로 떠 있다 — 콘솔 전환 라우트(api.ts)와 같은 동반 조치.
      // 이음새 밖인 이유: 상주 명부는 이 프로세스의 것이다(취소·은퇴와 같은 축)
      if (patch.harness) retireResidents(pkg);
      let cfg: HarnessConfig;
      try {
        cfg = await io.setHarnessConfig(pkg, patch);
      } catch (e) {
        // 전환 요청의 거절은 요청 결함이다(미선언 변형 등) — 그 외는 그물이 500 으로 받는다
        if (!patch.harness) throw e;
        throw new WireError(400, "E_BAD_REQUEST", String(e instanceof Error ? e.message : e));
      }
      // known 은 경고가 아니라 판정 정보다(§5.5-30) — 저장은 되고, 어댑터가 세션에서 거부하면 그 턴이 실패한다
      let known: boolean | null = null;
      if (cfg.model) {
        try {
          const r = await io.harnessQuery(pkg, "models");
          if (Array.isArray(r.value)) known = r.value.includes(cfg.model);
        } catch { /* models 불달 — 판정 불가 */ }
      }
      json(res, 200, { ok: true, model: cfg.model, effort: cfg.effort, harness: cfg.harness, known, ...(cfg.ready ? { ready: cfg.ready } : {}) });
    },
  },

  // ── 원격 제어 상주(§5.5-30-b) — capability `remote` 를 선언한 하네스에만 있는 문 ──
  {
    methods: ["GET"],
    scope: "base",
    pattern: /^\/harness\/remote$/,
    handler: async ({ deps, io, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const caps = await io.harnessCapabilities(pkg);
      if (!caps?.includes("remote")) throw new WireError(404, "E_NO_REMOTE", `원격 제어를 지원하지 않는 하네스입니다: ${pkg}`);
      json(res, 200, { ok: true, ...remoteStatus(pkg) });
    },
  },
  {
    methods: ["POST"],
    scope: "base",
    pattern: /^\/harness\/remote$/,
    handler: async ({ deps, io, req, res, pkg }) => {
      requirePkg(deps.getLedger(), pkg);
      const caps = await io.harnessCapabilities(pkg);
      if (!caps?.includes("remote")) throw new WireError(404, "E_NO_REMOTE", `원격 제어를 지원하지 않는 하네스입니다: ${pkg}`);
      const b = await readBody(req);
      if (b.enabled) {
        try {
          await startRemote(deps.authority, io.session, pkg);
        } catch (e) {
          throw new WireError(400, "E_BAD_REQUEST", String(e instanceof Error ? e.message : e));
        }
      } else {
        stopRemote(pkg, true);
      }
      json(res, 200, { ok: true, ...remoteStatus(pkg) });
    },
  },

  // ── 열거(§5.6) — root 소속, /registry 데이터의 닫힌 shape 재포장 ─────────
  {
    methods: ["GET"],
    scope: "root",
    pattern: /^\/instances$/,
    handler: ({ deps, res }) => {
      const l = deps.getLedger();
      const instances: Record<string, unknown>[] = [];
      for (const [name, rec] of Object.entries(l.packages)) {
        let man: Manifest;
        try {
          man = loadManifest(rec.path);
        } catch {
          // 판정 실패 설치본 — 닫힌 shape 로 표현할 수 없다. 결함 표면은 기판 소유 콘솔(/registry)이다
          continue;
        }
        const greeting = landingGreeting(man);
        instances.push({
          id: name, // base 마운트의 키 — 클라이언트는 이 id 로 base URL 을 얻는 기판 제공 함수를 쓴다(§2-6)
          display_name: man.display_name ?? name,
          ...(man.icon ? { icon: `/pkg/${encodeURIComponent(name)}/asset/${man.icon}` } : {}),
          // 인사말은 착지 에이전트 소속이다 — 새 대화가 떨어지는 자리가 곧 첫 줄의 주인이다
          ...(greeting ? { greeting } : {}),
          agents: (man.agents ?? []).map((a) => a.name),
          // 착지 에이전트 판정 결과 — 정본은 manifest.landingAgentName, 클라 재구현 금지(§8-42)
          agent: landingAgentName(man),
          ...(rec.model ? { model: rec.model } : {}),
          ...(rec.effort ? { effort: rec.effort } : {}),
        });
      }
      json(res, 200, { instances });
    },
  },
];

// ── 부착 함수 — Phase 2 가 api.ts 에 한 줄로 마운트한다 ──────────────────────

// 미주입 deps 의 기본 이음새는 deps 하나당 한 번만 세운다 — 요청마다 새로 만들면 구현이
// 안에 둔 캐시·상태가 매번 버려진다. deps 는 조립 지점(createApi)이 한 번 만드는 객체다
const defaultIOs = new WeakMap<ClientWireDeps, ClientWireIO>();

function wireIO(deps: ClientWireDeps): ClientWireIO {
  if (deps.io) return deps.io;
  let io = defaultIOs.get(deps);
  if (!io) {
    io = localClientWireIO(deps.getLedger);
    defaultIOs.set(deps, io);
  }
  return io;
}

/**
 * 신 wire dispatch. 매치되면 응답까지 책임지고 true, 아니면 손대지 않고 false 를 돌려
 * 호출측(api.ts)의 나머지 라우팅이 이어진다. base 마운트 문법(/pkg/<pkg>)은 기판 소유이며
 * 이 함수 안에서만 해석된다 — 클라이언트에는 base URL 주입으로 전달된다(§2-6).
 */
export async function handleClientWire(
  deps: ClientWireDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const p = url.pathname;
  const io = wireIO(deps);

  const run = async (route: WireRoute, pkg: string, m: RegExpMatchArray): Promise<boolean> => {
    try {
      await route.handler({ deps, io, req, res, url, pkg, m });
    } catch (e) {
      if (e instanceof WireError) fail(res, e.status, e.code, e.message);
      else fail(res, 500, "E_INTERNAL", e instanceof Error ? e.message : String(e));
    }
    return true;
  };

  for (const r of WIRE_ROUTES) {
    if (r.scope !== "root" || !r.methods.includes(method)) continue;
    const m = p.match(r.pattern);
    if (m) return run(r, "", m);
  }

  const base = p.match(/^\/pkg\/([^/]+)(\/.*)?$/);
  if (!base) return false;
  const pkg = decodeURIComponent(base[1]);
  const rest = base[2] ?? "/";
  for (const r of WIRE_ROUTES) {
    if (r.scope !== "base" || !r.methods.includes(method)) continue;
    const m = rest.match(r.pattern);
    if (m) return run(r, pkg, m);
  }
  return false;
}

import type { ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { API_URL, RELAY_HOME, loadLedger, saveLedger, packagesPath, sessionDir, sessionPath, workspaceDir, stageDir, type Ledger } from "../supply/ledger.ts";
import { loadManifest, landingAgentName, activeHarness, type Manifest } from "../supply/manifest.ts";
import { spawnEntry, spawnEntrySync } from "../spawn.ts";
// 동사의 뜻은 기판만 안다 — 어댑터는 이름만 싣고 지나간다(verbLabels)
import { verbLabels } from "./scripts.ts";
import { binaryEnv } from "../supply/binaries.ts";
import { localAuthority } from "../authority.ts";
import type { Authority } from "../authority-contract.ts";
import { UPLOADS_DIR, paramTargets } from "../protocol.ts";

/** 봉투 이벤트 방청 훅 — 세션이 장부에 쓰는 이벤트를 그대로 흘린다 */
export type EnvelopeTap = (pkg: string, slot: string, ev: { event: string; [k: string]: unknown }) => void;

// 주입인 이유: 이 훅의 소비자(client-wire 의 턴 장부)가 session.ts 를 import 하므로,
// 반대 방향 import 는 순환이 된다. 배선은 두 쪽을 다 아는 조립점(api.ts)이 한 줄로 한다
let envelopeTap: EnvelopeTap | null = null;
export function setEnvelopeTap(fn: EnvelopeTap | null): void {
  envelopeTap = fn;
}

/** 방청은 세션의 일이 아니다 — 훅이 던져도 턴은 계속 간다 */
function tap(pkg: string, slot: string, ev: { event: string; [k: string]: unknown }): void {
  if (!envelopeTap) return;
  try {
    envelopeTap(pkg, slot, ev);
  } catch { /* 방청자 사정 — 턴에 전가하지 않는다 */ }
}

/** 턴 수명주기 방청 — **wire 밖에서 열린 턴**(도구 위임·트리거·CLI)의 개설과 종결.
 *
 *  봉투 방청(EnvelopeTap)만으로는 부족하다: 관찰 창(재부착·SSE)은 턴 id 로 붙는데, 그 턴에는
 *  개설한 자가 없어 id 를 아는 곳이 없었다. 그래서 위임 대화는 물음만 그려진 채 멈춰 보였고,
 *  실황(delta·도구)은 통째로 버려졌다. 세션이 자기 턴 좌표를 알리면 방청자가 그 창을 연다.
 *  wire 가 개설한 턴(SessionInput.turnLedger)은 그쪽이 이미 수명주기를 가지므로 알리지 않는다. */
export interface TurnTap {
  open(pkg: string, slot: string, turn: { id: string; file: string }): void;
  close(
    pkg: string,
    slot: string,
    turnId: string,
    outcome: { ok: true; result: SessionResult } | { ok: false; message: string },
  ): void;
}

let turnTap: TurnTap | null = null;
export function setTurnTap(t: TurnTap | null): void {
  turnTap = t;
}

// ── 세션 이음새 ────────────────────────────────────────────────────────────
// 한 턴이 딛는 좌표를 모듈 좌표(./state.ts)가 아니라 인자로 받는 주입점. 실행 이음새
// (run.ts RunnerIO — 스폰의 env 를 나르는 손)·문 이음새(mcp.ts McpIO — 세션이 보는 도구
// 목록과 그 집행)의 세 번째 자매이고, 셋의 형이 같다: 작은 함수 묶음을 인자로 받고 미주입
// 이면 1인 기판의 현행 구현이 꽂힌다. 익명의 제3자 임베더 테스트 — 이 형은 특정 조직 기판을
// 모른다: 세션이 서는 자리가 디렉토리 셋, 대화가 (append, read) 장부, 문이 (이름 → url·헤더)
// 목록인 것뿐이고, 어느 답도 밖의 형상을 요구하지 않는다.
//
// 무엇을 인자화했는가 (2026-08-24):
//  · 경로(sessionDir·workspaceDir·stageDir) — 임베더의 세션 살림은 다른 땅에 앉는다. 번들·
//    진행 장부·슬롯 메타가 전부 sessionDir 하위라 디렉토리 하나로 따라온다.
//  · 기판 좌표(apiUrl·denyRoots) — 자식이 보는 문 주소(env RELAY_API·번들 mcp 문의 뿌리)와
//    선언과 무관하게 병합되는 담장 뿌리. RunnerIO.apiUrl 의 세션측 쌍둥이다.
//  · 대화 장부(appendMessage·readMessages) — 이 이음새의 갈림길. 파일(history.jsonl)이 정본인
//    기판과 다른 저장소가 정본인 임베더가 갈리는 유일한 축이라 **백엔드를 갈아 끼운다**.
//    "장부를 통째로 임베더에 위임"(세션은 아무것도 쓰지 않는다)은 택하지 않았다: 하네스 전환
//    인수인계·자동 제목·끊긴 턴 복구가 전부 장부를 되읽어야 성립하므로, 쓰기만 위임하면 읽는
//    좌표가 모듈에 남아 반쪽 이음새가 된다.
//  · MCP 문(mcpServers) — 번들 meta 의 다중 문(harness-protocol §The bundle). 기본 답은 빈
//    map 이라 현행(단일 meta.mcp)이 그대로 나간다.
//
// 열지 않은 축과 이유 (인터페이스는 소비자가 있을 때만 판다):
//  · 진행 명부(live·residents Map) — 담는 것이 ChildProcess 핸들과 그 stdin 이다. 원격 구현이
//    물리적으로 불가능하고(핸들은 프로세스 지역), 취소·상주 은퇴는 이미 내보낸 함수
//    (cancelSession·retireResident*)로 임베더가 부른다. 인자화하면 구현이 하나뿐인 형이 된다.
//  · 도구 조달(binaries.ts binaryEnv) — 기판 사본 디렉토리가 없으면 PATH 를 건드리지 않는
//    항등이다. 도구를 실행 이미지에 동봉하는 임베더에서 이미 무해한 항등이라 열 이유가 없다.
//  · 턴 장부(turns/<id>.jsonl) — 자리는 주입된 sessionDir 을 따라가고, 파일은 wire 가
//    개설한 턴이면 그쪽이 정한다(SessionInput.turnLedger). 밖으로 흐르는 축은 EnvelopeTap.
//  · 슬롯 열거(listSessionSlots) — 목록 조회는 세션 실행이 아니라 기판 표면의 일이다. 그 자리는
//    계약 축 이음새가 가져갔다(client-wire.ts ClientWireIO.listSessions, 2026-08-24) — 여기에도
//    같은 열거를 내면 두 열거가 갈린다. 이력 **읽기**는 반대로 여기가 정본이다: 계약 축의
//    history.get 이 아래 readMessages 를 지난다(중복 리더 금지).

/** 대화 장부 한 줄 — 파일 정본(history.jsonl)의 행 형상 그대로다. 저장소가 무엇이든 세션이
 *  쓰고 읽는 것은 이 형뿐이다. user 의 text 는 첨부·화면맥락 서문이 붙지 않은 원문이고,
 *  bot 의 files 는 그 턴의 stage 산출물, model·usage·context 는 봉투 reply 의 장부다 */
export interface SessionMessage {
  /** ISO 8601 */
  t: string;
  role: "user" | "bot";
  text: string;
  files?: { path: string; name: string }[];
  model?: string | null;
  usage?: unknown;
  context?: unknown;
}

/** MCP 문 하나 — 번들 계약(harness-protocol §The bundle)의 항목 형상 */
export interface McpDoor {
  url: string;
  /** Authorization 헤더 값 */
  authorization?: string;
  /** 다른 이름으로 인증하는 문의 불투명 추가 헤더 */
  headers?: Record<string, string>;
}

export interface SessionIO {
  /** 세션 살림 — 번들·진행 장부·슬롯 메타(agent·param·label·harness)가 이 아래 앉는다 */
  sessionDir(pkg: string, slot: string): string;
  /** 세션 cwd 의 뿌리. harness.workdir 선언은 이 아래 상대경로로 해석된다 */
  workspaceDir(pkg: string): string;
  /** 파일 교환 무대 — 첨부가 앉고 이 턴의 산출물이 나온다 */
  stageDir(pkg: string): string;
  /** 자식이 보는 기판 문 주소 — 자식 env RELAY_API 이자 번들 mcp 문의 뿌리 */
  apiUrl: string;
  /** 패키지 선언과 무관하게 모든 세션에 병합되는 담장 뿌리 — 기판 장기의 좌표 */
  denyRoots: string[];
  /** 대화 장부 append. 물음은 턴 시작에, 답은 종결에 앉는다(실패 턴의 답도 남는다) */
  appendMessage(pkg: string, slot: string, msg: SessionMessage): void;
  /** 대화 장부 읽기(오래된 것부터) — 하네스 전환 인수인계·자동 제목·끊긴 턴 복구가 같은 답을 본다 */
  readMessages(pkg: string, slot: string): SessionMessage[];
  /** 이 세션이 볼 MCP 문들 = 번들 meta.mcpServers. 기판 문(relay)을 인자로 주므로 그대로
   *  실을지·이름을 바꿀지·자기 문만 낼지는 구현이 정한다. 빈 답이면 meta.mcpServers 를 아예
   *  내지 않는다 — 구형 단일 meta.mcp 만 나가는 현행 그대로다 */
  mcpServers(pkg: string, agent: string, slot: string, relay: McpDoor): Record<string, McpDoor>;
}

/** 1인 기판의 기본 이음새 — RELAY_HOME 세션 살림, 파일 정본 장부(history.jsonl), 단일 기판 문.
 *  인자 미주입 시 이것이 꽂히므로 기존 소비자는 무영향이다. 장부는 getLedger 를 늦게 부른다:
 *  workspace 결재만 장부를 보고, 그마저 turn 시점에야 필요하다(권위 이음새와 같은 관용구) */
export function localSessionIO(getLedger: () => Ledger): SessionIO {
  return {
    sessionDir,
    workspaceDir: (pkg) => workspaceDir(getLedger(), pkg),
    stageDir,
    apiUrl: API_URL,
    denyRoots: [RELAY_HOME],
    appendMessage: (pkg, slot, msg) => {
      fs.appendFileSync(path.join(sessionDir(pkg, slot), "history.jsonl"), JSON.stringify(msg) + "\n");
    },
    readMessages: (pkg, slot) => {
      let raw: string;
      try {
        // sessionPath 인 이유: 읽기가 살림을 만들면 안 된다. 계약 축의 이력 조회(client-wire
        // history.get)가 이 문을 지나므로, 없는 세션의 조회 하나가 목록에 유령 행을 세운다
        raw = fs.readFileSync(path.join(sessionPath(pkg, slot), "history.jsonl"), "utf8");
      } catch {
        return []; // 이력 없는 슬롯 — 첫 턴
      }
      const out: SessionMessage[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as SessionMessage);
        } catch { /* 부서진 줄은 건너뛴다 */ }
      }
      return out;
    },
    mcpServers: () => ({}),
  };
}

export interface SessionInput {
  ledger: Ledger;
  pkg: string;
  /** 권위 이음새 — 미지정이면 1인 기판의 로컬 권위. 신원 토큰·principal·LLM 자격·감사가 이 문을 지난다 */
  authority?: Authority;
  /** 세션 이음새 — 미지정이면 1인 기판의 로컬 좌표. 경로·대화 장부·MCP 문이 이 문을 지난다 */
  io?: SessionIO;
  agent?: string;
  prompt?: string;
  slot?: string;
  interactive?: boolean;
  /** workspace 상대경로. 업로드 라우트가 발급한 참조만 유효하다 */
  attachments?: { path: string; name?: string }[];
  /** 화면 맥락 스냅샷 — 프롬프트 서문으로만 붙는다. 이력의 user text 는 원문으로 남는다 (첨부와 같은 계약) */
  scene?: string;
  /** 이 턴의 모델·강도 오버라이드 — 계약 축(ClientWireIO.harnessConfig)이 답한 값. 없으면 장부(rec) */
  model?: string;
  effort?: string;
  /** 이 턴의 장부 파일. wire 가 개설한 턴은 그 turns/<id>.jsonl 을 넘긴다 —
   *  넘기지 않으면(CLI·트리거·a2a) 세션이 같은 자리에 자기 id 로 하나 뜬다.
   *  종전에는 세션이 events.jsonl(턴마다 truncate)에, wire 가 턴 장부에 같은 봉투를
   *  두 번 썼다. 쓰는 자리를 하나로 모으면 어휘도 하나가 된다 — "슬롯의 스크래치"가 사라지고
   *  모든 턴이 관찰·재생 가능한 장부를 갖는다(a2a·트리거 턴도 마찬가지). */
  turnLedger?: string;
}

export interface SessionResult {
  reply: string;
  code: number;
  /** 봉투 reply 이벤트가 알려준 실제 사용 모델 (별칭 해석 결과) */
  model?: string | null;
  /** 봉투 reply 이벤트의 토큰 장부 {input, output, context_window} — 턴의 청구 합계다 */
  usage?: unknown;
  /** 봉투 reply 의 context {input, window} — 대화 점유량. 게이지는 usage 가 아니라 이걸 쓴다
      (usage.input 은 툴 왕복마다 캐시 읽기가 누적돼 점유율로 쓰면 부푼다) */
  context?: unknown;
  /** 이 턴이 stage 에 내놓은 파일들 (봉투 file 이벤트 + stage diff 합집합) */
  files?: { path: string; name: string }[];
}

// 첨부는 프롬프트 앞에 경로로 붙는다. 첨부의 실체는 stage 에 앉으므로 cwd 와 무관하게
// 절대경로로 준다 (이미지는 비전). 사용자는 경로를 보지 않는다 — 위젯이 칩으로 보여줄 뿐이다
/** 턴 장부의 자리. wire 의 TURNS_DIR 과 같은 문법이라 열거·재생이 한 규칙을 본다 */
export function turnLedgerPath(io: SessionIO, pkg: string, slot: string, id: string): string {
  return path.join(io.sessionDir(pkg, slot), "turns", id + ".jsonl");
}

function safeAttachments(atts: SessionInput["attachments"]): { path: string; name: string }[] {
  return (atts ?? [])
    .map((a) => ({ path: String(a.path ?? ""), name: String(a.name ?? path.basename(String(a.path ?? ""))) }))
    .filter((a) => a.path && !a.path.startsWith("/") && !a.path.split("/").includes(".."));
}

/**
 * 하네스 전환 인수인계 — 전환이 감지되면 번들을 비우고(네이티브 포인터 회전) 최근 이력을
 * 서문으로 돌려준다. 반환 "" = 전환 아님(첫 턴 포함 — 이어받을 이력이 없으면 서문도 없다).
 *
 * 포인터 회전이 번들 통삭제인 이유: 포인터 파일 이름(claude-session·codex-thread)은 어댑터
 * 소유라 기판이 열거할 수 없다. 어댑터 계약이 "네이티브 포인터·작업물은 번들 안에만" 이므로
 * (harness-protocol) 번들을 비우는 것이 이름을 모른 채 전부 회전시키는 유일한 방법이고,
 * 조립(composeBundle)이 바로 뒤에서 빈 자리를 다시 채운다.
 */
function harnessHandoff(io: SessionIO, pkg: string, slot: string, variantName: string): string {
  const dir = io.sessionDir(pkg, slot);
  const marker = path.join(dir, "harness");
  let last = "";
  try {
    last = fs.readFileSync(marker, "utf8").trim();
  } catch { /* 첫 턴 — 기준 없음 */ }
  if (!last || last === variantName) return "";

  fs.rmSync(path.join(dir, "bundle"), { recursive: true, force: true });
  fs.rmSync(marker, { force: true }); // 이 턴이 실패해도 다음 턴이 다시 인수인계하도록

  const msgs = io.readMessages(pkg, slot);
  // 최근 대화 꼬리 — 메시지당·전체 상한을 걸어 서문이 컨텍스트를 삼키지 않게 한다
  const MSG_CAP = 600;
  const TOTAL_CAP = 6_000;
  const rows: string[] = [];
  let total = 0;
  for (let i = msgs.length - 1; i >= 0 && total < TOTAL_CAP; i--) {
    const text = String(msgs[i].text ?? "").trim();
    if (!text) continue;
    const row = `${msgs[i].role === "user" ? "사용자" : "에이전트"}: ${text.length > MSG_CAP ? text.slice(0, MSG_CAP) + " …" : text}`;
    rows.unshift(row);
    total += row.length;
  }
  if (!rows.length) return "";
  return `[대화 인수인계 — 이 대화는 지금까지 다른 하네스(${last})로 진행됐고 방금 ${variantName} 로 전환됐다. 이전 도구의 네이티브 세션 맥락은 이어지지 않는다. 아래 최근 대화 기록을 맥락으로 삼아 자연스럽게 이어서 답하라. 이 안내와 기록 자체는 사용자에게 언급하지 마라]\n${rows.join("\n")}`;
}

function composeBundle(io: SessionIO, pkgPath: string, m: Manifest, agent: string, slot: string, pkg: string, token: string, ground: { cwd: string; stage: string }): string {
  const bundle = path.join(io.sessionDir(pkg, slot), "bundle");
  fs.mkdirSync(path.join(bundle, "agents"), { recursive: true });

  // 선언 밖 이름으로는 번들을 조립하지 않는다. 종전에는 display_name 으로 기본 페르소나를
  // 합성했는데, 그러면 오타 난 이름이 "이름 없는 에이전트" 로 강등돼 대화가 성립해 버렸다.
  // runSession 이 앞서 끊으므로 여기 닿으면 판정을 건너뛴 새 호출 경로다 — 조립 대신 판정
  const decl = (m.agents ?? []).find((a) => a.name === agent);
  if (!decl) throw new Error(`선언 밖 에이전트로 번들 조립: ${pkg}/${agent || "(빈 이름)"}`);
  for (const sub of ["skills", "commands"]) fs.rmSync(path.join(bundle, sub), { recursive: true, force: true });
  let persona = fs.readFileSync(path.join(pkgPath, decl.persona), "utf8");
  if (decl.skills && fs.existsSync(path.join(pkgPath, decl.skills))) {
    fs.cpSync(path.join(pkgPath, decl.skills), path.join(bundle, "skills"), { recursive: true });
  }
  if (decl.commands && fs.existsSync(path.join(pkgPath, decl.commands))) {
    fs.cpSync(path.join(pkgPath, decl.commands), path.join(bundle, "commands"), { recursive: true });
  }

  for (const sub of decl.dispatch ?? []) {
    const subDecl = (m.agents ?? []).find((a) => a.name === sub);
    if (!subDecl) continue;
    fs.writeFileSync(path.join(bundle, "agents", sub + ".md"), fs.readFileSync(path.join(pkgPath, subDecl.persona), "utf8"));
  }
  // 작업 대상(param 축) 주입 — 세션 메타의 param 이 대화의 "무엇의 <agent>인가"를 밝힌다
  // (§5.3-22). relayos runtime/turn/claudedir.go personaDoc 의 쌍둥이: 목록이면 펴서 알린다 —
  // 단수 표현은 목록을 하나의 이름으로 오해하게 한다. 권한 축이 아니라 맥락 한 줄이다.
  let slotParam = "";
  try {
    slotParam = fs.readFileSync(path.join(io.sessionDir(pkg, slot), "param"), "utf8").trim();
  } catch { /* 메타 없음 — 대상 무주입 */ }
  if (slotParam) {
    const targets = paramTargets(slotParam);
    persona += targets.length > 1
      ? `\n\n---\n[세션 컨텍스트] 현재 작업 대상: ${targets.join(", ")} — 이 대화의 범위는 이들 전부입니다.`
      : `\n\n---\n[세션 컨텍스트] 현재 작업 대상(param): ${targets[0]}.`;
  }
  fs.writeFileSync(path.join(bundle, "persona.md"), persona);

  const relay: McpDoor = {
    // session = 이 번들의 슬롯 — agent_dispatch 완료 배달의 회신 주소다
    url: `${io.apiUrl}/mcp/${encodeURIComponent(pkg)}?agent=${encodeURIComponent(agent)}&session=${encodeURIComponent(slot)}`,
    authorization: `Bearer ${token}`,
  };
  // 다중 문은 이음새가 답한다(기본은 빈 답 = 현행). 복수 선언이 있어도 단일 mcp 를 함께 내는
  // 것이 계약이다 — 구형 어댑터(codex·kimi)는 mcp 만 읽는다 (harness-protocol §The bundle)
  const doors = io.mcpServers(pkg, agent, slot, relay);
  const meta = {
    pkg,
    agent,
    slot,
    greeting: decl?.greeting,
    // cwd 다. workspace 가 아니다 — harness.workdir 을 선언한 패키지에서 이 값은 결재된 뿌리가
    // 아니라 그 하위 폴더이고, 세션은 여기에 선다(메모리 정본 AGENTS.md·샌드박스 쓰기 뿌리도
    // 여기다). 2026-08-25 까지 이 키의 이름은 workspace 였는데, 같은 단어가 ctx.workspace·
    // relay ls·화면에서는 뿌리를 가리켜 한 단어가 두 값이었다. 이름을 값에 맞춘다
    cwd: ground.cwd,
    stage: ground.stage,
    // 담장은 기판 장기의 좌표뿐이다. 패키지가 자기 담장을 선언하던 문법(hooks)은 은퇴했다 —
    // 방어 대상이 곧 선언 주체라 적대적 패키지는 선언을 비우면 그만이었고, 결재할 사람도 없었다.
    // 번역(네이티브 훅·권한 규칙)은 어댑터 소유. 가드레일이지 OS 샌드박스가 아니다
    hooks: { deny: [...io.denyRoots] },
    agents: (decl?.dispatch ?? []).map((sub) => ({
      name: sub,
      description: `${m.display_name} 패키지의 ${sub} 서브에이전트`,
    })),
    mcp: relay,
    ...(Object.keys(doors).length ? { mcpServers: doors } : {}),
  };
  fs.writeFileSync(path.join(bundle, "meta.json"), JSON.stringify(meta, null, 2));
  return bundle;
}

// ── 진행 중 턴 레지스트리 — cancel 라우트의 착지점 ─────────────────────────
const live = new Map<string, ChildProcess>();

/** 봉투 제어(stdin cancel)가 1순위 — 어댑터가 정리할 기회. 그물은 SIGTERM, 최후는 SIGKILL */
export function cancelSession(pkg: string, slot: string): boolean {
  const key = `${pkg}/${slot}`;
  const child = live.get(key);
  if (!child) return false;
  condemnResident(key, child);
  try {
    child.stdin?.write(JSON.stringify({ type: "cancel" }) + "\n");
  } catch { /* stdin 이미 닫힘 — 아래 신호로 */ }
  const term = setTimeout(() => { try { child.kill("SIGTERM"); } catch { /* 이미 종료 */ } }, 3000);
  const kill = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 이미 종료 */ } }, 8000);
  child.once("exit", () => {
    clearTimeout(term);
    clearTimeout(kill);
  });
  return true;
}

// ── 상주 하네스 (serve 동사) ───────────────────────────────────────────────
// 어댑터가 info 로 serve 를 선언하면 프로세스를 턴마다 갈지 않고 상주시킨다:
// 턴 = stdin 의 {"type":"turn"} 주입, 턴 경계 = reply/error 이벤트, 은퇴 = stdin EOF.
// 얻는 것은 warm turn(프로세스 spawn·대화 재독·MCP 재연결이 턴마다 사라진다)이고,
// 잃지 않는 것은 투영물 계약이다 — 상주는 언제 죽어도 다음 턴이 디스크의 대화를 잇는다.
// 상주는 데몬 전용이다: CLI 1회 실행이 상주를 남기면 고아가 된다 (enableResidents 는 데몬만 부른다)
let residentsEnabled = false;
export function enableResidents(): void {
  residentsEnabled = true;
}

interface Resident {
  child: ChildProcess;
  pkg: string;
  slot: string;
  /** 상주를 편 턴의 세션 이음새 — 유휴 턴(자발 continuation)의 장부·진행 기록이 이 좌표로 간다.
   *  슬롯의 좌표는 턴마다 바뀌지 않으므로 재사용 턴이 이것을 갱신하지 않는다 */
  io: SessionIO;
  /** 상주를 가른 조립 지문 — 모델·강도·자격·설치 경로가 달라지면 낡은 상주를 은퇴시킨다 */
  fp: string;
  idle: ReturnType<typeof setTimeout> | null;
  /** 진행 중 턴의 이벤트 수신자 — null 이면 유휴 */
  sink: ((ev: { event: string; [k: string]: unknown }) => void) | null;
  stderrTail: string;
  /** 봉투가 알린 미완 백그라운드 작업(task 이벤트) — 유휴 은퇴와 강제 종료를 유예하는 근거 */
  tasks: Set<string>;
  /** 마지막 봉투 이벤트 시각 — 스톨 워치독의 근거 */
  lastEvent: number;
  /**
   * 유휴 중에 열린 자발 턴 — 주입 없이 하네스가 스스로 연 턴이다(백그라운드 완료의 continuation,
   * 그리고 남은 경계가 없어 다음 턴으로 미뤄진 얹기의 답).
   *
   * 자기 장부를 갖는다. 종전에는 **직전 턴의 장부**에 이어 적었는데 그것은 계약 위반이었다:
   * 재생은 settled 에서 끊어야 하고 그 뒤로는 어떤 이벤트도 없어야 하는데(client-protocol
   * §6-36), 이어 적으면 재부착이 종결 뒤 줄을 다시 재생한다. 게다가 붙을 턴 id 가 없어
   * 화면은 그 실황을 통째로 버렸다 — 답이 나왔는데 "아무 일도 안 일어나는" 자리였다.
   */
  spont: { id: string; file: string } | null;
}

const residents = new Map<string, Resident>();
const RESIDENT_TTL_MS = (() => {
  const v = Number(process.env.RELAY_RESIDENT_TTL_S);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 600_000;
})();
// 스톨 워치독 — 턴 진행 중 무이벤트가 이 시간을 넘으면 고착으로 판정하고 취소를 넣는다.
// 없으면 wedge 된 턴이 슬롯을 영구 busy 로 만들어 다음 메시지가 전부 튕긴다
const STALL_MS = (() => {
  const v = Number(process.env.RELAY_TURN_STALL_S);
  return Number.isFinite(v) && v > 0 ? v * 1000 : 1_200_000;
})();
// 검사 주기는 판정선보다 촘촘해야 한다 — 60초 고정이면 RELAY_TURN_STALL_S=5 로 줄여도 첫
// 검사가 60초 뒤라 그 설정이 아무 일도 하지 않는다(시험도 못 한다)
const STALL_TICK_MS = Math.min(60_000, Math.max(250, STALL_MS));

/**
 * 질문이 서 있는 슬롯(`pkg/slot`) — 스톨 시계를 멈추는 근거.
 *
 * 대기 중 ask 는 **무이벤트지 고착이 아니다**: 턴이 사람을 올바르게 기다리는 중이다. 이 명부가
 * 없으면 두 시계가 싸우고 늘 긴 쪽이 틀린 방향으로 이긴다 — 사람이 20분 넘게 고민하면 기판이
 * 그 질문을 취소해 버린다. 어댑터의 10분 자동 기본값이 은퇴한 자리가 여기다(2026-08-26):
 * 답을 지어내지 않는 대신, 기다림이 턴에 아무 비용도 물리지 않게 한다.
 */
const askPending = new Set<string>();

/** 봉투가 지나가는 두 경로(상주·1회)가 같이 부른다 — ask 는 시계를 멈추고, 답·정산은 푼다 */
function trackAsk(key: string, event: string): void {
  if (event === "ask") askPending.add(key);
  else if (event === "reply" || event === "error") askPending.delete(key);
}

// serve 선언 조회 — info 는 어댑터 프로세스 1회 비용이라 mtime 캐시로 어댑터당 한 번만 돈다
const serveCache = new Map<string, { mtime: number; serves: boolean }>();
function harnessServes(entry: string, envForInfo: NodeJS.ProcessEnv): boolean {
  let mtime: number;
  try {
    mtime = fs.statSync(entry).mtimeMs;
  } catch {
    return false;
  }
  const hit = serveCache.get(entry);
  if (hit && hit.mtime === mtime) return hit.serves;
  let serves = false;
  try {
    const r = spawnEntrySync(entry, ["info"], { encoding: "utf8", timeout: 15_000, env: envForInfo });
    const j = JSON.parse(r.stdout || "{}");
    serves = Array.isArray(j.verbs) && j.verbs.includes("serve");
  } catch { /* info 불달 — 상주 없이 턴마다 프로세스로 */ }
  serveCache.set(entry, { mtime, serves });
  return serves;
}

function retireEntry(key: string, r: Resident, force = false): void {
  if (residents.get(key) === r) residents.delete(key);
  if (r.idle) {
    clearTimeout(r.idle);
    r.idle = null;
  }
  try {
    r.child.stdin?.end(); // EOF = 은퇴 지시 — 봉투가 claude 를 자연 종료시킨다
  } catch { /* 이미 닫힘 */ }
  // 미완 백그라운드가 있으면 드레인이다 — 도구가 작업 완주까지 살았다가 스스로 내려온다(실측).
  // 강제 시계는 드레인이 아닐 때와 데몬 종료(force)에만 건다
  if (!force && r.tasks.size > 0) return;
  const term = setTimeout(() => { try { r.child.kill("SIGTERM"); } catch { /* 이미 종료 */ } }, 5000);
  const kill = setTimeout(() => { try { r.child.kill("SIGKILL"); } catch { /* 이미 종료 */ } }, 8000);
  term.unref?.();
  kill.unref?.();
  r.child.once("close", () => {
    clearTimeout(term);
    clearTimeout(kill);
  });
}

/** 대화 재시작(reset)·세션 삭제의 동반 조치 — 상주가 낡은 대화를 메모리에 물고 있으면 안 된다 */
export function retireResident(pkg: string, slot: string): boolean {
  const key = `${pkg}/${slot}`;
  const r = residents.get(key);
  if (!r) return false;
  retireEntry(key, r);
  return true;
}

/** 설치·발행·롤백·하네스 전환의 동반 조치 — 상주는 옛 코드·옛 번들로 떠 있다 */
export function retireResidents(pkg: string): number {
  let n = 0;
  for (const [key, r] of [...residents]) {
    if (key.startsWith(pkg + "/")) {
      retireEntry(key, r);
      n++;
    }
  }
  return n;
}

export function retireAllResidents(): void {
  for (const [key, r] of [...residents]) retireEntry(key, r, true);
}

/** cancel 제어는 계약상 어댑터의 사형선고다(harness-protocol §control — error 종결 + exit 130).
 *  선고받은 상주가 명부에 남으면, stdin cancel → 프로세스 exit 사이의 창에 시작되는 다음 턴을
 *  acquireResident 가 그 죽어가는 프로세스에 주입한다 — 어댑터는 cancelled 가드로 주입을 삼키고,
 *  exit 가 그 턴을 "하네스 상주 종료" 실패로 만든다(사용자 Stop 직후의 큐 드레인이 정확히 이
 *  창에 떨어진다 — 2026-08-21 실사고). 선고와 동시에 명부에서 내려 다음 턴이 새 상주를 펴게
 *  한다. 프로세스 정리는 cancel 을 받은 어댑터 자신과 호출측의 신호 그물이 맡는다. */
function condemnResident(key: string, child: ChildProcess): void {
  const r = residents.get(key);
  if (!r || r.child !== child) return;
  residents.delete(key);
  if (r.idle) {
    clearTimeout(r.idle);
    r.idle = null;
  }
}

/** 진행 중 턴 여부 — 화면이 새로고침 뒤에도 서버의 진행 상태(와 중지 버튼)를 되찾게 한다 */
export function isSessionBusy(pkg: string, slot: string): boolean {
  return live.has(`${pkg}/${slot}`);
}

/** ask(질문) 회송 — 위젯 답변을 진행 중 봉투의 제어 채널로 넣는다 */
export function deliverAnswer(pkg: string, slot: string, id: string, answers: unknown): boolean {
  const child = live.get(`${pkg}/${slot}`);
  if (!child?.stdin) return false;
  try {
    child.stdin.write(JSON.stringify({ type: "answer", id, answers }) + "\n");
  } catch {
    return false;
  }
  // 답이 돌아갔으니 기다림이 끝났다 — 여기서 풀지 않으면 이 턴은 남은 구간 내내 워치독 밖이다
  askPending.delete(`${pkg}/${slot}`);
  return true;
}

/**
 * steer(얹기) — 진행 중 턴에 사용자 발화를 더한다(client-protocol §5.1-16-a).
 * 턴을 열지 않는다: 정산은 여전히 하나이고 그 하나가 얹힌 발화까지 포함한다.
 *
 * false = **얹을 턴이 없다**(진행 명부에 없음 = 그 사이 종결됐거나 애초에 안 돌고 있다).
 * 이 판정을 여기서 하는 이유는 진행 명부가 프로세스 지역이라 여기만 볼 수 있어서다 —
 * 어댑터에 맡기면 어댑터의 큐와 화면의 새 턴 폴백이 같은 말을 두 번 보낸다.
 *
 * 이력 기록은 얹힌 **직후**다. appendUser 와 같은 규율이다("물음은 지금, 답은 끝나고"):
 * 정산까지 모아 두면 그 사이 죽은 기판에서 사용자가 한 말만 통째로 사라진다. 반대로 쓰기가
 * 실패했으면 적지 않는다 — 얹히지 않은 말이 이력에 앉으면 다음 턴의 하네스가 사용자가 한 적
 * 없는 지시를 읽는다.
 */
export function deliverSteer(io: SessionIO, pkg: string, slot: string, prompt: string): boolean {
  const child = live.get(`${pkg}/${slot}`);
  if (!child?.stdin) return false;
  try {
    child.stdin.write(JSON.stringify({ type: "steer", prompt }) + "\n");
  } catch {
    return false;
  }
  appendUser(io, pkg, slot, prompt);
  return true;
}

// 유휴 은퇴 시계 — 미완 백그라운드가 있으면 은퇴 대신 재무장한다(드레인)
function armIdle(key: string, r: Resident): void {
  r.idle = setTimeout(() => {
    r.idle = null;
    if (residents.get(key) !== r) return;
    if (r.tasks.size > 0) return armIdle(key, r);
    retireEntry(key, r);
  }, RESIDENT_TTL_MS);
  r.idle.unref?.();
}

/**
 * 유휴 이벤트 — 주입 없이 하네스가 스스로 연 턴의 배달.
 *
 * 첫 이벤트가 턴을 **연다**: 자기 장부를 하나 만들고 관찰 창에 세운다(turnTap). 관찰·재부착·
 * 재생이 전부 턴 id 로 붙으므로, 이 개설이 없으면 답이 실제로 나와도 화면에 닿을 길이 없다 —
 * 도구 위임 턴이 "아무 일도 안 일어나는 것처럼" 보이던 자리와 같은 구멍이다(wire adoptSessionTurn).
 * reply/error 가 그 턴을 닫는다. 이력에 앉히는 것은 종전과 같다.
 */
function idleEvent(r: Resident, ev: { event: string; [k: string]: unknown }): void {
  if (!r.spont) {
    const id = crypto.randomUUID();
    const file = turnLedgerPath(r.io, r.pkg, r.slot, id);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, ""); // 관찰이 즉시 붙어도 읽을 파일이 있게(wire enqueueTurn 과 같은 규율)
      r.spont = { id, file };
      // 개설을 먼저 알린다 — 아래 tap 이 중계될 턴이 그 사이 서 있어야 한다
      turnTap?.open(r.pkg, r.slot, r.spont);
    } catch { /* 세션 디렉토리가 지워짐 — 장부 없이 이력 배달만 계속한다 */ }
  }
  try {
    if (r.spont) appendEvent(r.spont.file, ev);
  } catch { /* 세션 디렉토리가 지워짐 — 기록만 포기 */ }
  tap(r.pkg, r.slot, ev);
  if (ev.event === "reply") {
    appendBot(r.io, r.pkg, r.slot, String(ev.text ?? ""), {
      model: typeof ev.model === "string" ? ev.model : null,
      usage: ev.usage ?? null,
      context: ev.context ?? null,
    });
  }
  if (ev.event !== "reply" && ev.event !== "error") return;
  const spont = r.spont;
  r.spont = null;
  if (!spont) return;
  try {
    turnTap?.close(r.pkg, r.slot, spont.id, ev.event === "reply"
      ? { ok: true, result: { reply: String(ev.text ?? ""), code: 0, model: typeof ev.model === "string" ? ev.model : null, usage: ev.usage ?? null, context: ev.context ?? null } }
      : { ok: false, message: String(ev.message ?? "하네스 오류") });
  } catch { /* 방청자 사정 */ }
}

function acquireResident(io: SessionIO, pkg: string, slot: string, entry: string, env: Record<string, string>, cwd: string, fp: string): Resident {
  const key = `${pkg}/${slot}`;
  const cur = residents.get(key);
  if (cur && cur.fp === fp && cur.child.exitCode === null) {
    if (cur.idle) {
      clearTimeout(cur.idle);
      cur.idle = null;
    }
    return cur;
  }
  if (cur) retireEntry(key, cur);
  const child = spawnEntry(entry, ["serve"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const r: Resident = { child, pkg, slot, io, fp, idle: null, sink: null, stderrTail: "", tasks: new Set(), lastEvent: Date.now(), spont: null };
  child.stdin?.on("error", () => { /* EPIPE — 실패는 close 가 sink 로 배달한다 */ });
  const rl = readline.createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    // serve 선언 어댑터의 stdout 은 봉투 전용이다 — 이벤트 아닌 줄은 소음으로 버린다
    if (!line.startsWith("{")) return;
    let ev: { event?: unknown; [k: string]: unknown } | null = null;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (!ev || typeof ev.event !== "string") return;
    r.lastEvent = Date.now();
    // 백그라운드 원장 — 턴 중이든 유휴든 항상 접는다. 유휴 은퇴·강제 종료 유예의 근거다
    if (ev.event === "task" && typeof ev.id === "string" && ev.id) {
      if (ev.status === "started") r.tasks.add(ev.id);
      else r.tasks.delete(ev.id);
    }
    if (r.sink) r.sink(ev as { event: string });
    else idleEvent(r, ev as { event: string });
  });
  child.stderr!.on("data", (d) => {
    r.stderrTail = (r.stderrTail + String(d)).slice(-2000);
  });
  // 사망 배달 — 진행 중 턴이 있으면 그 턴의 실패이고, 유휴라도 **자발 턴이 열려 있으면**
  // 그것을 닫아야 한다. 안 닫으면 관찰 창에 선 턴이 영영 running 으로 남아 그 슬롯이
  // 영구 busy 가 되고, 다음 메시지가 전부 그 유령 턴으로 수렴한다
  const dying = (message: string): void => {
    if (r.sink) return void r.sink({ event: "error", message });
    if (r.spont) idleEvent(r, { event: "error", message });
  };
  child.on("error", (e) => {
    if (residents.get(key) === r) residents.delete(key);
    dying(`하네스 상주 기동 실패: ${e}`);
  });
  child.on("close", (code) => {
    rl.close();
    if (residents.get(key) === r) residents.delete(key);
    if (r.idle) clearTimeout(r.idle);
    // 턴 도중의 사망은 그 턴의 실패다 — 유휴 사망은 다음 턴이 새 상주로 잇는다
    const tail = r.stderrTail.trim().split("\n").slice(-2).join(" / ");
    dying(`하네스 상주 종료 (exit ${code})${tail ? " — " + tail : ""}`);
  });
  residents.set(key, r);
  return r;
}

function residentTurn(
  authority: Authority,
  io: SessionIO,
  pkg: string,
  slot: string,
  entry: string,
  env: Record<string, string>,
  cwd: string,
  fp: string,
  prompt: string,
  eventsFile: string,
  evFiles: { path: string; name: string }[],
  toolLabels: Record<string, string>,
): Promise<{ reply: string; code: number; model: string | null; usage: unknown; context?: unknown }> {
  return new Promise((resolve, reject) => {
    const key = `${pkg}/${slot}`;
    const r = acquireResident(io, pkg, slot, entry, env, cwd, fp);
    live.set(key, r.child);
    r.lastEvent = Date.now();
    // 스톨 워치독 — 무이벤트가 길면 고착이다. 취소 제어로 턴을 실패 종결시켜 슬롯을 풀어준다
    const stall = setInterval(() => {
      if (askPending.has(key)) return; // 사람을 기다리는 중 — 무이벤트지 고착이 아니다
      if (Date.now() - r.lastEvent < STALL_MS) return;
      void authority.audit("sessions", { pkg, slot, stall_s: Math.round((Date.now() - r.lastEvent) / 1000) });
      condemnResident(key, r.child); // cancel 은 사형선고 — 죽어가는 상주를 다음 턴이 재사용하지 않게
      try {
        r.child.stdin?.write(JSON.stringify({ type: "cancel" }) + "\n");
      } catch { /* 이미 닫힘 */ }
    }, STALL_TICK_MS);
    stall.unref?.();
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearInterval(stall);
      askPending.delete(key);
      r.sink = null;
      if (live.get(key) === r.child) live.delete(key);
      if (residents.get(key) === r && r.child.exitCode === null) {
        // 유휴 은퇴 시계 — 다음 턴의 acquire 가 푼다
        armIdle(key, r);
      }
      fn();
    };
    r.sink = (raw) => {
      const ev = labelTool(raw, toolLabels);
      trackAsk(key, ev.event);
      appendEvent(eventsFile, ev);
      tap(pkg, slot, ev);
      if (ev.event === "reply") {
        finish(() => resolve({
          reply: String(ev.text ?? ""),
          code: 0,
          model: typeof ev.model === "string" ? ev.model : null,
          usage: ev.usage ?? null,
          context: ev.context ?? null,
        }));
      } else if (ev.event === "error") {
        finish(() => reject(new Error(String(ev.message ?? "하네스 오류"))));
      } else if (ev.event === "file" && typeof ev.path === "string" && !ev.path.startsWith("/") && !ev.path.split("/").includes("..")) {
        evFiles.push({ path: ev.path, name: path.basename(ev.path) });
      }
    };
    try {
      r.child.stdin!.write(JSON.stringify({ type: "turn", prompt }) + "\n");
    } catch (e) {
      finish(() => reject(e instanceof Error ? e : new Error(String(e))));
    }
  });
}

// ── stage 산출물 감지 ──────────────────────────────────────────────────────
// 봉투 file 이벤트가 없는 어댑터에서도 파일 회신이 성립하는 보장선: 턴 전후 diff.
// 인바운드 무대(protocol.ts UPLOADS_DIR)는 사용자 업로드 착지라 제외한다
function stageSnapshot(stage: string): Map<string, number> {
  const seen = new Map<string, number>();
  const walk = (dir: string, rel: string, depth: number): void => {
    if (depth > 6 || seen.size > 2000) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rel === "" && e.name === UPLOADS_DIR) continue;
      const p = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(p, r, depth + 1);
      else if (e.isFile()) {
        try {
          seen.set(r, fs.statSync(p).mtimeMs);
        } catch { /* 경합 삭제 */ }
      }
    }
  };
  walk(stage, "", 0);
  return seen;
}

function stageDiffFiles(stage: string, before: Map<string, number>): { path: string; name: string }[] {
  const out: { path: string; name: string }[] = [];
  for (const [r, mtime] of stageSnapshot(stage)) {
    const prev = before.get(r);
    if (prev == null || prev < mtime) out.push({ path: r, name: path.basename(r) });
  }
  return out;
}

/**
 * 이 세션이 서는 나무 — 작업 사본 위 세션이면 draft 트리, 아니면 설치본(fallback).
 * 슬롯의 `draft` 마커가 판정이다(wire 가 민팅 때 심는다, SessionBinding.draft). 고친 에이전트를
 * 적용 전에 써보는 자리: 페르소나·스킬·커맨드·동사가 전부 작업 사본에서 온다. 장부·도는 판은
 * 그대로다. 마커가 있어도 작업 사본이 없으면(버렸다) 설치본으로 — 없는 나무 위에 세우지 않는다
 */
export function sessionTreeOf(pkg: string, slot: string | null | undefined, fallback: string): string {
  if (!slot) return fallback;
  if (!fs.existsSync(path.join(sessionPath(pkg, slot), "draft"))) return fallback;
  const tree = path.join(packagesPath(), pkg);
  return fs.existsSync(tree) ? tree : fallback;
}

/** 번들 재료(페르소나·스킬·커맨드)의 지문 — 파일 mtime·size 를 훑는다. 내용이 바뀌면 값이 달라져
 *  상주가 은퇴하고 새 글로 다시 선다. 서브에이전트 페르소나까지 포함(dispatch). */
function bundleSourceSig(tree: string, m: Manifest, agent: string): string {
  const decl = (m.agents ?? []).find((a) => a.name === agent);
  if (!decl) return "";
  const h = crypto.createHash("sha256");
  const stamp = (rel: string | undefined) => {
    if (!rel) return;
    const abs = path.join(tree, rel);
    const walk = (p: string) => {
      let st: fs.Stats;
      try { st = fs.statSync(p); } catch { return; }
      if (st.isDirectory()) { for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e)); return; }
      h.update(p + "\u0000" + st.mtimeMs + "\u0000" + st.size + "\u0000");
    };
    walk(abs);
  };
  stamp(decl.persona);
  stamp(decl.skills);
  stamp(decl.commands);
  for (const sub of decl.dispatch ?? []) stamp((m.agents ?? []).find((a) => a.name === sub)?.persona);
  return h.digest("hex").slice(0, 16);
}

export async function runSession(input: SessionInput): Promise<SessionResult> {
  const rec = input.ledger.packages[input.pkg];
  if (!rec) throw new Error(`미설치 패키지: ${input.pkg}`);
  const authority = input.authority ?? localAuthority(() => input.ledger);
  const io = input.io ?? localSessionIO(() => input.ledger);
  const tree = sessionTreeOf(input.pkg, input.slot, rec.path);
  const m = loadManifest(tree);
  // 대화의 에이전트 정체성 — 명시 > 슬롯의 agent 메타(위임 세션이 심는다) > 착지.
  // 메타가 없으면 착지로 가는 종전 동작 그대로다. 메타는 선언 검증을 거친다: 임의 문자열이
  // 에이전트 행세를 하면 composeBundle 이 기본 페르소나로 조용히 강등된다(fail-loud 위반).
  let slotAgent: string | undefined;
  if (!input.agent && input.slot) {
    try {
      const cand = fs.readFileSync(path.join(io.sessionDir(input.pkg, input.slot), "agent"), "utf8").trim();
      if (cand && (m.agents ?? []).some((a) => a.name === cand)) slotAgent = cand;
    } catch { /* 메타 없음 — 착지로 */ }
  }
  const agent = input.agent ?? slotAgent ?? landingAgentName(m) ?? "";
  // 세션은 페르소나 위에 선다 — 선언 없는 이름으로 열면 번들이 이름 없는 기본 페르소나로
  // 조용히 강등된다. 작업폴더 생성·번들 회전보다 앞에서 끊어야 실패가 흔적을 남기지 않는다.
  // 착지 부재는 판정(judge)이 설치에서 막지만, 명시 agent 는 여기가 유일한 관문이다
  // (POST /turns 의 body.agent — 민팅 라우트와 달리 개설은 이름을 검사하지 않는다)
  if (!(m.agents ?? []).some((a) => a.name === agent)) {
    const declared = (m.agents ?? []).map((a) => a.name);
    throw new Error(
      declared.length === 0
        ? `에이전트 미선언 패키지: ${input.pkg} — 세션은 페르소나 위에 섭니다. relay.yaml 에 agents[] 를 선언하세요`
        : agent
          ? `선언 밖 에이전트: ${input.pkg}/${agent} (선언: ${declared.join(", ")})`
          : `착지 에이전트 없음: ${input.pkg} — agents[] 중 하나에 default: true 를 선언하거나 패키지 짧은 이름과 같은 에이전트를 두세요`,
    );
  }
  const slot = input.slot ?? `agent-${agent}`;
  const token = authority.packageToken(input.pkg);

  // cwd = 결재된 workspace(기본 ~/Relay/<이름>) + harness.workdir 선언(있으면).
  // 번들에 실리는 이름도 cwd 다 — 이 값은 workdir 을 선언한 패키지에서 workspace 와 갈린다
  const workdir = path.join(io.workspaceDir(input.pkg), m.harness?.workdir ?? "");
  fs.mkdirSync(workdir, { recursive: true });
  const stage = io.stageDir(input.pkg);
  const variant = activeHarness(m, rec.harness);
  if (!variant) throw new Error(`하네스 미동봉 패키지: ${input.pkg} — relay.yaml 에 harness.variants 를 선언하고 어댑터를 동봉하세요`);
  // 인수인계 판정은 번들 조립보다 앞이어야 한다 — 회전(번들 삭제)이 조립 뒤에 오면
  // 이 턴이 방금 조립된 번들을 지우고, 앞에 오면 조립이 빈 자리를 새로 채운다
  const handoff = harnessHandoff(io, input.pkg, slot, variant.name);
  const bundle = composeBundle(io, tree, m, agent, slot, input.pkg, token, { cwd: workdir, stage });
  const entry = path.join(tree, variant.source, variant.entry);

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    RELAY_NAME: input.pkg,
    RELAY_AGENT: agent,
    RELAY_PRINCIPAL: authority.principal(),
    RELAY_API: io.apiUrl,
    RELAY_TOKEN: token,
    RELAY_SESSION: slot,
    RELAY_BUNDLE: bundle,
  };
  // 기판이 대는 도구가 있으면 PATH 앞에 — 호스트의 깨진 전역 설치보다 먼저 걸려야 한다.
  // 이 축은 이음새에 없다: 기판 사본 디렉토리가 없으면 PATH 를 건드리지 않는 항등이라,
  // 도구를 실행 이미지에 동봉하는 임베더에서 그대로 무해하다
  Object.assign(env, binaryEnv(input.pkg, env));
  if (variant?.llm?.auth?.env) {
    // LLM 자격 — 스폰 직전 요청 시점에 권위 이음새로 발급받아 이 세션의 env 에만 싣는다.
    // kind 를 가리지 않는다: oauth 변형도 선언이 env 이름을 말하면 기판이 댈 수 있다 —
    // 무인 기판(조직 pod)에는 로그인할 사람이 없다. 이음새가 null 이면 항등이라 1인
    // 기판에서는 도구 자신의 로그인(Keychain·홈)이 그대로 답이다
    const cred = await authority.credential(`llm/${variant.llm.provider}`);
    if (cred) env[variant.llm.auth.env] = cred;
  }
  const model = input.model ?? rec.model;
  const effort = input.effort ?? rec.effort;
  if (model) env.RELAY_MODEL = model;
  if (effort) env.RELAY_EFFORT = effort;

  // 상주 지문: 이 값이 달라지면 낡은 상주를 은퇴시키고 새로 편다.
  // 자격은 값 대신 해시로 — 지문이 로그에 실려도 비밀이 새지 않는다
  const cred = variant.llm?.auth?.env ? env[variant.llm.auth.env] ?? "" : "";
  // 페르소나·스킬·커맨드의 지문도 넣는다 — 이것이 빠지면 에이전트 글을 고쳐도 상주가 옛 번들을
  // 계속 들고 돈다(고쳐도 안 먹는 침묵 실패). 파일 mtime·size 로 싸게 잰다(내용 읽기 없이).
  const personaSig = bundleSourceSig(tree, m, agent);
  const fp = crypto.createHash("sha256")
    // 축은 양쪽에서 온다. tree·personaSig 는 저작 축(초안 트리에서 돌 때, 그리고 에이전트 글을
    // 고쳤을 때 상주가 갈려야 한다), model·effort 는 **턴별 오버라이드가 반영된 값**이다
    // (rec.* 만 보면 /model 로 바꾼 턴이 낡은 상주를 재사용해 조용히 옛 모델로 돈다)
    .update([tree, agent, variant.name, model ?? "", effort ?? "", cred, personaSig].join("\u0000"))
    .digest("hex").slice(0, 16);
  const resident = !input.interactive && residentsEnabled && harnessServes(entry, env);

  await authority.audit("sessions", { pkg: input.pkg, agent, slot, mode: input.interactive ? "tty" : resident ? "resident" : "auto" });

  if (input.interactive) {
    return await new Promise((resolve) => {
      const child = spawnEntry(entry, ["session"], { cwd: workdir, env, stdio: "inherit" });
      child.on("exit", (code) => resolve({ reply: "", code: code ?? 0 }));
    });
  }

  // 도구 이름의 뜻은 턴마다 한 번만 짓는다 — 이벤트마다 지으면 표시 하나가 모듈 적재를 부른다
  const toolLabels = await verbLabels(input.ledger, input.pkg, agent);
  const atts = safeAttachments(input.attachments);
  // 서문 합성은 기판 몫이다 — 화면 맥락(scene)도 첨부도 프롬프트에만 붙고 이력에는 원문만 남는다
  const scene = String(input.scene ?? "").trim();
  // 하네스 인수인계 — 네이티브 맥락(claude 세션·codex 스레드)은 각 도구 소유라 교차 resume 이
  // 물리적으로 불가하다. 전환된 대화의 연속성은 기판 이력이 답한다: 마지막 턴을 돈 변형이
  // 지금과 다르면 ① 번들을 비워 모든 네이티브 포인터를 회전시키고(사이 대화를 모르는 낡은
  // 네이티브 세션이 이력과 어긋난 답을 만드는 것을 막는다 — 위젯은 전체 이력을 보여 주는데
  // 에이전트만 다른 기억을 갖게 된다) ② 최근 이력을 서문으로 실어 새 하네스가 이어받게 한다.
  const prompt = (handoff ? handoff + "\n\n" : "")
    + (scene ? `[화면 맥락 — 사용자가 지금 보고 있는 화면]\n${scene}\n\n` : "")
    + (atts.length ? `첨부 파일 — Read 도구로 읽어라:\n${atts.map((a) => "- " + path.join(stage, a.path)).join("\n")}\n\n` : "")
    + (input.prompt ?? "");

  // 한 슬롯에 턴은 하나다. 돌고 있는데 또 넣으면 두 프로세스가 같은 하네스 세션을
  // --resume 으로 함께 물어 답이 통째로 비는 일이 생긴다. 조용히 비우느니 막고 알린다.
  // 아래 장부를 건드리기 전에 막아야 한다 — 진행 장부는 턴마다 비우므로,
  // 늦게 막으면 돌고 있는 턴의 실황 로그를 지워버린다
  const key = `${input.pkg}/${slot}`;
  if (live.has(key)) {
    throw new Error("이 대화는 아직 이전 요청을 처리하는 중입니다. 끝나면 이어서 말씀해 주세요 (급하면 진행 표시의 중지를 누르세요)");
  }

  // 이 턴의 진행 이벤트 장부 — 위젯이 폴링해 delta·tool 진행을 그린다. 턴마다 새로 시작한다
  // 장부 자리: wire 가 개설한 턴이면 그 파일, 아니면(CLI·트리거·a2a) 세션이 하나 뜬다
  const eventsFile = input.turnLedger ?? turnLedgerPath(io, input.pkg, slot, crypto.randomUUID());
  fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
  // wire 가 개설한 턴은 그쪽이 수명주기를 갖는다. 아닌 턴(도구 위임·트리거·CLI)의 관찰 창은
  // 여기서 연다 — 열지 않으면 화면이 붙을 턴 id 가 없어 실황이 그대로 버려진다
  const observed = input.turnLedger ? null : { id: path.basename(eventsFile, ".jsonl"), file: eventsFile };
  if (observed) {
    try { turnTap?.open(input.pkg, slot, observed); } catch { /* 방청자 사정 */ }
  }
  const closeObserved = (outcome: { ok: true; result: SessionResult } | { ok: false; message: string }): void => {
    if (!observed) return;
    try { turnTap?.close(input.pkg, slot, observed.id, outcome); } catch { /* 방청자 사정 */ }
  };
  // 질문은 턴이 끝나기를 기다리지 않는다. 답변까지 모아서 마지막에 한 번 쓰면
  // 도중에 기판이 죽었을 때 질문까지 통째로 사라진다 — 물음은 지금, 답은 끝나고
  appendUser(io, input.pkg, slot, input.prompt ?? "", atts);
  const stageBefore = stageSnapshot(stage);
  const evFiles: { path: string; name: string }[] = [];

  // 세션 봉투는 감지형이다: stdout 의 JSON 이벤트 줄은 봉투로, 그 외 줄은 구형 통짜 응답으로
  // 받는다. 어댑터의 protocol 선언을 세션마다 조회하지 않아도 신구가 공존한다.
  // serve 선언 어댑터는 상주 경로다 — 프로세스를 갈지 않고 stdin 으로 턴을 주입한다
  const turn = resident
    ? residentTurn(authority, io, input.pkg, slot, entry, env, workdir, fp, prompt, eventsFile, evFiles, toolLabels)
    : new Promise<{ reply: string; code: number; model: string | null; usage: unknown; context?: unknown }>((resolve, reject) => {
      const child = spawnEntry(entry, ["session", prompt], { cwd: workdir, env, stdio: ["pipe", "pipe", "pipe"] });
      live.set(key, child);
      let raw = "";
      let err = "";
      let lastLine = Date.now();
      // 스톨 워치독 — 봉투가 취소 제어를 받는 어댑터라면 고착 턴이 여기서 풀린다
      const stall = setInterval(() => {
        if (askPending.has(key)) return; // 사람을 기다리는 중 — 무이벤트지 고착이 아니다
        if (Date.now() - lastLine < STALL_MS) return;
        void authority.audit("sessions", { pkg: input.pkg, slot, stall_s: Math.round((Date.now() - lastLine) / 1000) });
        try {
          child.stdin?.write(JSON.stringify({ type: "cancel" }) + "\n");
        } catch { /* 이미 닫힘 */ }
      }, STALL_TICK_MS);
      stall.unref?.();
      let reply: { text: string; model: string | null; usage: unknown; context: unknown } | null = null;
      let errEvent = "";
      const rl = readline.createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        lastLine = Date.now();
        let ev: { event?: unknown; [k: string]: unknown } | null = null;
        if (line.startsWith("{")) {
          try {
            ev = JSON.parse(line);
          } catch { /* 봉투 아님 */ }
        }
        if (!ev || typeof ev.event !== "string") {
          raw += line + "\n";
          return;
        }
        // 위 가드(typeof ev.event !== "string" 조기 반환)가 이미 증명한 형 — 인덱스 시그니처라 좁혀지지 않는다
        ev = labelTool(ev as { event: string; [k: string]: unknown }, toolLabels);
        trackAsk(key, ev.event as string);
        appendEvent(eventsFile, ev as { event: string; [k: string]: unknown });
        tap(input.pkg, slot, ev as { event: string; [k: string]: unknown });
        if (ev.event === "reply") {
          reply = {
            text: String(ev.text ?? ""),
            model: typeof ev.model === "string" ? ev.model : null,
            usage: ev.usage ?? null,
            context: ev.context ?? null,
          };
        } else if (ev.event === "error") {
          errEvent = String(ev.message ?? "");
        } else if (ev.event === "file" && typeof ev.path === "string" && !ev.path.startsWith("/") && !ev.path.split("/").includes("..")) {
          evFiles.push({ path: ev.path, name: path.basename(ev.path) });
        }
      });
      child.stderr!.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearInterval(stall);
        askPending.delete(key);
        live.delete(key);
        reject(e);
      });
      child.on("close", (code) => {
        clearInterval(stall);
        askPending.delete(key);
        live.delete(key);
        if (reply) return resolve({ reply: reply.text, code: code ?? 0, model: reply.model, usage: reply.usage, context: reply.context });
        if (errEvent) return reject(new Error(errEvent));
        const legacy = raw.trim();
        if (code !== 0 && !legacy) return reject(new Error(`하네스 종료 코드 ${code}: ${err.slice(-500)}`));
        resolve({ reply: legacy, code: code ?? 0, model: null, usage: null, context: null });
      });
    });

  // 실패도 이력이다. 물음만 남기고 끝내면 다음 기동의 복구가 죽은 턴으로 오해한다
  let r: { reply: string; code: number; model: string | null; usage: unknown; context?: unknown };
  try {
    r = await turn;
  } catch (e) {
    appendBot(io, input.pkg, slot, `오류: ${e instanceof Error ? e.message : String(e)}`);
    closeObserved({ ok: false, message: e instanceof Error ? e.message : String(e) });
    throw e;
  }
  // 어댑터가 종결 본문을 못 준 턴 — 화면에 "(빈 응답)" 을 띄우기 전에 이 턴에 흘렀던
  // 말부터 줍는다. 하네스가 어떤 이유로 침묵해도 한 말이 있으면 그것이 답이다
  if (!r.reply.trim()) {
    const salvaged = deltaText(eventsFile);
    if (salvaged) r = { ...r, reply: salvaged };
  }

  const seen = new Set(evFiles.map((f) => f.path));
  const files = [...evFiles, ...stageDiffFiles(stage, stageBefore).filter((f) => !seen.has(f.path))];
  appendBot(io, input.pkg, slot, r.reply, { model: r.model, usage: r.usage, context: r.context, files });
  // 이 슬롯의 마지막 턴을 돈 변형 — 다음 턴의 인수인계 판정 기준. 성공한 턴만 기록한다:
  // 실패 턴 뒤 재시도에도 서문이 다시 실려야 새 하네스가 맥락 없이 시작하지 않는다
  fs.writeFileSync(path.join(io.sessionDir(input.pkg, slot), "harness"), variant.name);
  // 이력이 앉은 **뒤에** 닫는다 — 종결을 본 화면이 곧바로 이력을 다시 읽어도 같은 답을 본다
  closeObserved({ ok: true, result: { ...r, files } });
  return { ...r, files };
}

// 대화 이력은 기판 장부다. 하네스가 자기 세션(claude jsonl)을 따로 갖더라도,
// 세션 목록·전환·복원은 기판이 답해야 하므로 여기서 쌓는다. 어디에 쌓이는가는 이음새가
// 답하고(SessionIO.appendMessage — 1인 기판은 history.jsonl), 무엇이 한 줄인가는 여기 규율이다.
// 이력의 user text 는 첨부 서문 없는 원문이다 — 첨부는 files 필드로 따로 앉는다 (위젯이 칩으로 그림).
// bot 의 files 는 아웃바운드(이 턴의 stage 산출물), model·usage 는 봉투 reply 의 장부다
const HISTORY_TEXT_CAP = 16_384;

function appendUser(io: SessionIO, pkg: string, slot: string, prompt: string, files: { path: string; name: string }[] = []): void {
  if (!prompt.trim() && !files.length) return;
  io.appendMessage(pkg, slot, {
    t: new Date().toISOString(),
    role: "user",
    text: prompt.slice(0, HISTORY_TEXT_CAP),
    ...(files.length ? { files } : {}),
  });
}

function appendBot(
  io: SessionIO,
  pkg: string,
  slot: string,
  reply: string,
  extra: { model?: string | null; usage?: unknown; context?: unknown; files?: { path: string; name: string }[] } = {},
): void {
  io.appendMessage(pkg, slot, {
    t: new Date().toISOString(),
    role: "bot",
    text: reply.slice(0, HISTORY_TEXT_CAP),
    ...(extra.model ? { model: extra.model } : {}),
    ...(extra.usage ? { usage: extra.usage } : {}),
    ...(extra.context ? { context: extra.context } : {}),
    ...(extra.files?.length ? { files: extra.files } : {}),
  });
}

/** 진행 장부에 흘렀던 본류 텍스트를 이어 붙인다 — 종결 본문이 없는 턴의 대타 */
/** 슬롯의 가장 최근 턴 장부 — 끊긴 턴 복구가 읽는다. 종전의 events.jsonl(슬롯당 하나,
 *  턴마다 truncate)이 하던 일을 "가장 최근 파일"이 대신한다 */
function latestTurnLedger(io: SessionIO, pkg: string, slot: string): string {
  const dir = path.join(io.sessionDir(pkg, slot), "turns");
  let best = "";
  let bestAt = -1;
  try {
    for (const e of fs.readdirSync(dir)) {
      if (!e.endsWith(".jsonl")) continue;
      const f = path.join(dir, e);
      const at = fs.statSync(f).mtimeMs;
      if (at > bestAt) { bestAt = at; best = f; }
    }
  } catch { /* 턴 없음 */ }
  return best;
}

/**
 * 기판이 아는 것을 봉투에 붙인다 — 도구 이벤트의 짧은 이름. 어댑터는 우리 문의 도구가 무엇을
 * 하는지 모르므로 이름만 싣고 지나가고, 화면은 그 슬러그를 그대로 그렸다.
 *
 * 붙이는 자리가 **장부 기록과 실황 tap 앞** 한 곳인 것이 요점이다: 둘 중 하나에만 붙이면 방금
 * 본 화면과 다시 연 화면이 다른 이름을 그린다(재생과 실황의 갈림 — 이 리포가 봉투를 한 벌로
 * 두는 이유와 같다). 접두가 붙는 문(dir·edge·a2a·mcp)은 이름 자체가 분해되므로 지나친다.
 */
function labelTool(ev: { event: string; [k: string]: unknown }, labels: Record<string, string>): { event: string; [k: string]: unknown } {
  if (ev.event !== "tool" || typeof ev.name !== "string") return ev;
  const label = labels[ev.name];
  return label ? { ...ev, label } : ev;
}

/** 장부 한 줄 — wire 의 appendTurnEvent 와 같은 형({t, ...봉투}). 두 writer 가 한 파일에
 *  붙지만 append 는 순차라 섞이지 않는다: 세션은 턴 도중, wire 는 개설·종결에 쓴다 */
function appendEvent(file: string, ev: { event: string; [k: string]: unknown }): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...ev }) + "\n");
  } catch { /* 세션 삭제 경합 — 기록만 포기, 턴은 계속 (wire appendTurnEvent 와 같은 판정) */ }
}

function deltaText(eventsFile: string): string {
  if (!eventsFile || !fs.existsSync(eventsFile)) return "";
  let out = "";
  for (const l of fs.readFileSync(eventsFile, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const ev = JSON.parse(l);
      if (ev.event === "delta" && typeof ev.text === "string") out += ev.text;
      else if (ev.event === "reply" && typeof ev.text === "string" && ev.text.trim()) out = ev.text;
    } catch { /* 부서진 줄은 건너뛴다 */ }
  }
  return out.trim();
}

// ── 자동 제목 — 첫 턴이 끝난 뒤 하네스에 한 줄 요약을 시켜 auto-label 로 앉힌다.
// 사용자가 지은 이름(label 파일)이 항상 이긴다. 생성은 임시 슬롯(_title-*)에서 돌고
// 끝나면 그 슬롯을 지운다 — 목록에는 "_" 접두 슬롯이 애초에 안 나온다(api.listSessions).
// 실패는 조용히 삼킨다: 제목은 편의지 대화의 기능이 아니다
const titling = new Set<string>();

export async function autoTitleSession(ledger: Ledger, pkg: string, slot: string, io: SessionIO = localSessionIO(() => ledger)): Promise<void> {
  const key = `${pkg}/${slot}`;
  if (titling.has(key)) return;
  const dir = io.sessionDir(pkg, slot);
  if (fs.existsSync(path.join(dir, "label")) || fs.existsSync(path.join(dir, "auto-label"))) return;
  const msgs = io.readMessages(pkg, slot);
  const user = msgs.find((m) => m.role === "user");
  const bot = msgs.find((m) => m.role === "bot");
  if (!user || !bot) return; // 완결된 첫 교환이 있어야 제목이 선다
  titling.add(key);
  const tmp = `_title-${slot}`.slice(0, 64);
  try {
    const prompt = [
      "아래 대화에 어울리는 제목을 짓는 작업이다. 도구를 쓰지 말고 즉시 답하라.",
      "요구: 한국어 20자 이내의 명사구 한 줄. 따옴표나 마침표, '제목:' 같은 접두어 없이 제목 텍스트만 출력하라.",
      "",
      "사용자: " + String(user.text ?? "").slice(0, 500),
      "어시스턴트: " + String(bot.text ?? "").slice(0, 500),
    ].join("\n");
    const r = await runSession({ ledger, pkg, prompt, slot: tmp, io });
    const title = String(r.reply ?? "")
      .split("\n").map((s) => s.trim()).filter(Boolean)[0]
      ?.replace(/^["'`「『]+|["'`」』.]+$/g, "").slice(0, 40) ?? "";
    // 생성 도중 사용자가 직접 이름을 지었을 수 있다 — 그때는 버린다
    if (title && !fs.existsSync(path.join(dir, "label"))) {
      fs.writeFileSync(path.join(dir, "auto-label"), title);
    }
  } catch { /* 제목 실패는 대화에 영향을 주지 않는다 */ } finally {
    titling.delete(key);
    // 상주 하네스가 켜져 있으면 제목 턴이 임시 슬롯의 상주를 남긴다 — TTL 을 기다리지 않고 은퇴시킨다
    retireResident(pkg, tmp);
    fs.rmSync(io.sessionDir(pkg, tmp), { recursive: true, force: true });
  }
}

/** 한 패키지가 가진 세션 슬롯 목록 — 복구는 슬롯 단위로 돈다. 이 열거는 이음새 밖이다:
 *  목록 조회는 세션 실행이 아니라 기판 표면의 일이라 계약 축 이음새가 그 자리를 갖는다
 *  (client-wire.ts ClientWireIO.listSessions). 좌표를 옮긴 임베더는 자기 저장소를 열거하고
 *  슬롯 이름만 넘긴다(recoverDanglingTurns 는 io 를 받는다) */
export function listSessionSlots(pkg: string): string[] {
  const root = path.join(RELAY_HOME, "sessions", pkg);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

/**
 * 끊긴 턴 줍기 — 기판이 죽으면 그 턴의 답은 저장 시점에 닿지 못하고 사라진다.
 * 물음만 남고 답이 없는 마지막 기록을 찾아, 그 턴의 이벤트 장부에 흘러 있던
 * 중간 텍스트로 답을 복구한다. 흐른 말이 없으면 끊겼다는 사실이라도 남긴다.
 * 데몬이 뜰 때 한 번만 돈다 — 도는 중인 턴을 죽은 것으로 오인하지 않기 위해서다.
 */
/** 복구가 이력에 남기는 표식의 머리 — 미결 배달 sweep 이 "완료"와 "중단"을 가르는 근거다.
 *  두 자리가 같은 상수를 봐야 한 쪽만 고쳐져 판정이 조용히 갈리지 않는다 */
export const INTERRUPTED_MARK = "(작업 도중 기판이 멈춰";

export function recoverDanglingTurns(pkg: string, slot: string, io: SessionIO = localSessionIO(loadLedger)): boolean {
  const msgs = io.readMessages(pkg, slot);
  if (!msgs.length) return false;
  if (msgs[msgs.length - 1]?.role !== "user") return false;

  const text = deltaText(latestTurnLedger(io, pkg, slot));
  appendBot(
    io,
    pkg,
    slot,
    text
      ? `${text}\n\n${INTERRUPTED_MARK} 답변이 끝까지 저장되지 못했습니다. 여기까지 오간 내용입니다.)`
      : `${INTERRUPTED_MARK} 답변이 저장되지 못했습니다. 남은 내용이 없습니다.)`,
  );
  return true;
}

// ── 원격 제어 상주(remote) — 로그인된 자격으로 상주하는 프로세스 ─────────────────────
// `login`(자격은 도구 소유, pty 중계)과 `serve`(상주, 데몬이 수명을 쥠)의 합성이다: 어댑터가
// verb `remote` 를 선언하면 그 도구의 원격 조종 클라이언트(claude remote-control 류)를 이 패키지의
// 작업 무대(cwd=workspace) 위에 상주시킨다. 턴이 아니므로 번들·슬롯이 없고, 봉투도 없다 —
// stdout/stderr 는 진단용 꼬리만 남긴다. 무인 기판(org pod)에서 "누가 이 프로세스를 띄우는가"
// 의 답이 이 파일이 되면서 기판별 투영(별도 Deployment)이 필요 없어진다.
// 상태는 장부(PkgRecord.remote)에 남아 데몬 재기동을 넘긴다(resumeRemotes).
interface Remote {
  child: ChildProcess;
  variant: string;
  startedAt: number;
  stderrTail: string;
}
const remotes = new Map<string, Remote>();

export function remoteStatus(pkg: string): { running: boolean; pid: number | null; variant: string | null; since: string | null } {
  const r = remotes.get(pkg);
  if (!r || r.child.exitCode !== null) return { running: false, pid: null, variant: null, since: null };
  return { running: true, pid: r.child.pid ?? null, variant: r.variant, since: new Date(r.startedAt).toISOString() };
}

/** 원격 제어 상주 기동 — 이미 떠 있으면 은퇴 후 새로 편다(자격·모델 변경의 반영). */
export async function startRemote(authority: Authority, io: SessionIO, pkg: string): Promise<{ pid: number; variant: string }> {
  const l = loadLedger();
  const rec = l.packages[pkg];
  if (!rec) throw new Error(`미설치 패키지: ${pkg}`);
  const m = loadManifest(rec.path);
  const variant = activeHarness(m, rec.harness);
  if (!variant) throw new Error(`하네스 미동봉 패키지: ${pkg}`);
  const workdir = path.join(io.workspaceDir(pkg), m.harness?.workdir ?? "");
  fs.mkdirSync(workdir, { recursive: true });
  const entry = path.join(rec.path, variant.source, variant.entry);
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    RELAY_NAME: pkg,
    RELAY_PRINCIPAL: authority.principal(),
    RELAY_API: io.apiUrl,
    RELAY_TOKEN: authority.packageToken(pkg),
  };
  Object.assign(env, binaryEnv(pkg, env));
  // 스폰 자격 — 세션과 같은 이음새(auth.env 를 선언이 말하면 기판이 댄다, kind 무관)
  if (variant.llm?.auth?.env) {
    const cred = await authority.credential(`llm/${variant.llm.provider}`);
    if (cred) env[variant.llm.auth.env] = cred;
  }
  if (rec.model) env.RELAY_MODEL = rec.model;
  if (rec.effort) env.RELAY_EFFORT = rec.effort;
  stopRemote(pkg);
  const child = spawnEntry(entry, ["remote"], { cwd: workdir, env, stdio: ["ignore", "pipe", "pipe"] });
  const r: Remote = { child, variant: variant.name, startedAt: Date.now(), stderrTail: "" };
  child.stdout?.on("data", () => { /* 원격 클라이언트의 화면 출력 — 봉투가 아니다 */ });
  child.stderr?.on("data", (d) => { r.stderrTail = (r.stderrTail + String(d)).slice(-2000); });
  child.on("close", () => { if (remotes.get(pkg) === r) remotes.delete(pkg); });
  remotes.set(pkg, r);
  rec.remote = true;
  saveLedger(l);
  return { pid: child.pid ?? 0, variant: variant.name };
}

/** 원격 제어 상주 은퇴 — persist 면 장부의 켜짐 표시도 지운다. 떠 있었으면 true */
export function stopRemote(pkg: string, persist = false): boolean {
  const r = remotes.get(pkg);
  if (r) {
    remotes.delete(pkg);
    if (r.child.exitCode === null) r.child.kill();
  }
  if (persist) {
    const l = loadLedger();
    if (l.packages[pkg]?.remote) {
      delete l.packages[pkg].remote;
      saveLedger(l);
    }
  }
  return !!r;
}

/** 데몬 종료 — 상주 하네스와 같은 자리에서 원격 상주도 내린다(장부 표시는 남긴다: 재기동이 잇는다) */
export function stopAllRemotes(): void {
  for (const pkg of [...remotes.keys()]) stopRemote(pkg);
}

/** 데몬 기동 — 장부에 켜짐이 남은 패키지의 원격 상주를 다시 편다. 실패는 그 패키지의 실패다 */
export async function resumeRemotes(authority: Authority, io: SessionIO): Promise<string[]> {
  const notes: string[] = [];
  for (const [pkg, rec] of Object.entries(loadLedger().packages)) {
    if (!rec.remote) continue;
    try {
      const r = await startRemote(authority, io, pkg);
      notes.push(`${pkg}: 원격 제어 상주 재개 (${r.variant}, pid ${r.pid})`);
    } catch (e) {
      notes.push(`${pkg}: 원격 제어 상주 재개 실패 - ${e instanceof Error ? e.message : e}`);
    }
  }
  return notes;
}

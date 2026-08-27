/*!
 * parts.ts — 여러 영역이 함께 쓰는 순수 헬퍼(JSX 없음): 파트 그룹화·도구 판별, 시간/크기/토큰
 * 포맷, 모델·공급자 라벨, 첨부 페이로드, 대기열 영속화, 공용 소형 타입(AnyPart·PendingAtt·QItem·Chip).
 */
import type { Attachment } from "./runtime";
import { modelOptions } from "./runtime";
import { STEER_TOOL } from "./envelope-reducer";

export function resultText(result: unknown): string {
  if (result == null) return "";
  if (typeof result === "string") return result;
  try { return JSON.stringify(result, null, 2); } catch { return String(result); }
}

// ── 파트 그룹화 — 커스텀 assistant 렌더의 심장 ──────────────────────────────
// 연속된 reasoning/tool-call 파트를 하나의 타임라인으로 묶고, text 파트가 run 을 끊는다
// (네이티브 TraceGroupView·renderItems 와 같은 규칙). TodoWrite 는 타임라인에서 빼서 플랜
// 카드로 — 한 턴에 여러 번 오면 마지막 호출만 렌더한다(최신 상태가 곧 계획).
export type AnyPart = any;
export type Group =
  | { kind: "md"; text: string }
  | { kind: "trace"; steps: AnyPart[] }
  | { kind: "plan"; todos: any[] | null }
  | { kind: "ask"; part: AnyPart }
  | { kind: "steer"; part: AnyPart }
  | { kind: "choice"; part: AnyPart }
  | { kind: "files"; part: AnyPart };

/** 질문 카드 도구 — 네이티브 AskUserQuestion(세션 pod 가 stdio can_use_tool 채널에서
 *  답변 회송을 대기). 구 MCP 재구현명(mcp__ask__ask_user)은 은퇴 — 과거 대화 리플레이
 *  렌더용으로만 매칭한다. */
export function isAskTool(name: unknown): boolean {
  return name === "AskUserQuestion" || name === "mcp__ask__ask_user";
}

/** 얹기 카드 — 진짜 도구가 아니라 리듀서가 봉투 `steer` 이벤트로 세운 예약 파트다
 *  (envelope-reducer 의 STEER_TOOL). 이름 문자열은 리듀서가 정본이라 여기서 다시 쓰지 않는다. */
export function isSteerPart(name: unknown): boolean {
  return name === STEER_TOOL;
}

/** @relay/builder ask 스크립트(논블로킹 선택지) — scripts-engine 이 script_ask 로 합성하고
 *  (TOOL_PREFIX='script_'·mcpServers 키 'scripts'), claude 스트림·저장 프레임엔
 *  mcp__scripts__script_ask 로 찍힌다. 정확명과 MCP 프리픽스명(suffix) 둘 다 매칭. */
export function isChoiceTool(name: unknown): boolean {
  return typeof name === "string" && (name === "script_ask" || name.endsWith("__script_ask"));
}

/** deliver_file 파일 카드 도구 — 세션 pod MCP("ask" 서버)라 스트림·저장 프레임엔
 *  mcp__ask__deliver_file 로 찍힌다(정확명은 방어 매칭). */
export function isDeliverTool(name: unknown): boolean {
  return name === "mcp__ask__deliver_file" || name === "deliver_file";
}

export function groupParts(content: readonly AnyPart[]): Group[] {
  let lastPlan = -1;
  content.forEach((p, i) => { if (p?.type === "tool-call" && p.toolName === "TodoWrite") lastPlan = i; });
  const groups: Group[] = [];
  let trace: AnyPart[] = [];
  const flush = () => { if (trace.length) { groups.push({ kind: "trace", steps: trace }); trace = []; } };
  content.forEach((p, i) => {
    if (!p) return;
    if (p.type === "tool-call" && p.toolName === "TodoWrite") {
      // 이전 플랜 호출은 렌더 생략(trace run 도 안 끊음) — 마지막 것만 카드로.
      if (i === lastPlan) {
        flush();
        groups.push({ kind: "plan", todos: Array.isArray(p.args?.todos) ? p.args.todos : null });
      }
      return;
    }
    if (p.type === "tool-call" && isAskTool(p.toolName)) {
      flush();
      groups.push({ kind: "ask", part: p });
      return;
    }
    // 얹기 — 턴이 도는 중에 사용자가 더한 말. 타임라인(trace)에 접어 넣지 않고 흐름을 끊어
    // 제 자리에 세운다: 이 말이 들어간 지점이 곧 이후 도구 호출들이 갈린 이유다.
    if (p.type === "tool-call" && isSteerPart(p.toolName)) {
      flush();
      groups.push({ kind: "steer", part: p });
      return;
    }
    // script_ask 는 턴을 끝내고 답을 다음 사용자 메시지로 받는 논블로킹 카드 —
    // 질문마다 카드 하나, 같은 턴에 여러 번 오면 각각 렌더한다.
    if (p.type === "tool-call" && isChoiceTool(p.toolName)) {
      flush();
      groups.push({ kind: "choice", part: p });
      return;
    }
    // deliver_file — 에이전트가 건넨 파일의 다운로드 카드(호출마다 카드 하나).
    if (p.type === "tool-call" && isDeliverTool(p.toolName)) {
      flush();
      groups.push({ kind: "files", part: p });
      return;
    }
    if (p.type === "reasoning" || p.type === "tool-call") { trace.push(p); return; }
    if (p.type === "text") { flush(); if (p.text) groups.push({ kind: "md", text: p.text }); return; }
    // 그 외 파트(이미지 등)는 assistant 어댑터가 생성하지 않는다 — 무시.
  });
  flush();
  return groups;
}

/** "방금 · n분 전 · n시간 전 · n일 전 · M/D" — 대화 목록의 마지막 활동 시각. */
export function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return "방금";
  if (s < 3600) return Math.floor(s / 60) + "분 전";
  if (s < 86400) return Math.floor(s / 3600) + "시간 전";
  if (s < 7 * 86400) return Math.floor(s / 86400) + "일 전";
  try { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; } catch { return ""; }
}

/** 모델 id → 피커 라벨("Fable 5"). init 프레임 id 는 날짜 접미가 붙을 수 있어(claude-haiku-4-5-2025…)
 *  프리픽스 일치까지 허용한다. 목록 밖 id(BYO·신모델·카탈로그 미로드)는 id 에서 라벨을
 *  파생한다("claude-opus-5" → "Opus 5") — raw id 배지와 라벨 배지가 턴마다 섞이던 표시
 *  불일치(07-29 실측: claude-opus-5 vs Sonnet 5)의 봉합. 파생 불가 형태만 id 그대로. */
export function modelLabelOf(id: string): string {
  const opts = modelOptions();
  const exact = opts.find((m) => m.id === id);
  if (exact) return exact.label;
  const pre = opts.find((m) => id.startsWith(m.id) || m.id.startsWith(id));
  if (pre) return pre.label;
  const m = /^claude-([a-z]+)((?:-\d+)*)$/.exec(id);
  if (m) {
    // 버전 세그먼트만 점 표기로(날짜 접미 8자리는 제외): claude-haiku-4-5-20251001 → "Haiku 4.5".
    const ver = m[2].split("-").filter((s) => s !== "" && s.length < 4).join(".");
    return m[1].charAt(0).toUpperCase() + m[1].slice(1) + (ver ? " " + ver : "");
  }
  return id;
}

/** "오후 3:24" — local time the message was sent. Live messages get createdAt on append;
 *  replayed history carries the stored turn time (runtime.loadHistory). */
export function fmtTime(d?: Date): string {
  if (!d) return "";
  try { return d.toLocaleTimeString("ko-KR", { hour: "numeric", minute: "2-digit" }); } catch { return ""; }
}

export type Chip = { icon: "dot" | "slash"; text: string };

/** 공급자 표시명 — llm.provider 는 소문자 어휘라 화면용으로만 다듬는다. 모르는 값은 그대로. */
const PROVIDER_LABEL: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", vllm: "vLLM", moonshot: "Moonshot", google: "Google" };
export function providerLabelOf(v: { name: string; provider?: string }): string {
  if (!v.provider) return v.name;
  return PROVIDER_LABEL[v.provider] ?? v.provider[0].toUpperCase() + v.provider.slice(1);
}
/** 트리거에 보이는 하네스 짧은 이름 — "claude-code" → "Claude", "codex" → "Codex".
 *  피드백(2026-08-26): 바깥엔 "기본"이란 말 없이 무엇으로 도는지 한 단어면 된다. */
export function harnessShortOf(name: string): string {
  const w = name.split("-")[0] || name;
  return w[0].toUpperCase() + w.slice(1);
}

/** Phosphor Icons(MIT) path — 의존성 없이 인라인. 256 뷰박스, fill=currentColor.
 *  글자 아이콘(↑ ■ +)은 폰트마다 굵기·기준선이 달라 버튼 안에서 비뚤어 보였다(피드백 2026-08-26). */
export const PH = {
  arrowUp: "M208.49,120.49a12,12,0,0,1-17,0L140,69V216a12,12,0,0,1-24,0V69L64.49,120.49a12,12,0,0,1-17-17l72-72a12,12,0,0,1,17,0l72,72A12,12,0,0,1,208.49,120.49Z",
  stop: "M216,56V200a16,16,0,0,1-16,16H56a16,16,0,0,1-16-16V56A16,16,0,0,1,56,40H200A16,16,0,0,1,216,56Z",
  plus: "M228,128a12,12,0,0,1-12,12H140v76a12,12,0,0,1-24,0V140H40a12,12,0,0,1,0-24h76V40a12,12,0,0,1,24,0v76h76A12,12,0,0,1,228,128Z",
};
/** 조사 "(으)로" — 라벨 끝 글자의 받침으로 고른다(숫자는 독음 기준: 1·7·8=ㄹ→로, 0·3·6=받침→으로).
 *  한글·숫자 밖(라틴 등)은 "로". 모델 라벨("Opus 4.8")이 열린 집합이라 안내문이 어색해지지 않게. */
export function withRo(w: string): string {
  const ch = w.charAt(w.length - 1);
  if (/[0-9]/.test(ch)) return w + ("036".includes(ch) ? "으로" : "로"); // 영·삼·육만 ㄹ 아닌 받침
  const code = ch.charCodeAt(0);
  if (code >= 0xac00 && code <= 0xd7a3) {
    const jong = (code - 0xac00) % 28;
    return w + (jong === 0 || jong === 8 ? "로" : "으로"); // 받침 없음·ㄹ 받침 = 로
  }
  return w + "로";
}

/** A staged attachment held in the composer (before send). 소형(인라인)은 dataUrl 이 프리뷰와
 *  바이트 소스를 겸하고, 대용량(사이드밴드)은 dataUrl 없이 업로드 참조(path)만 갖는다 —
 *  uploading/progress 는 사이드밴드 진행 상태(전송은 업로드 완료 후에만). */
export type PendingAtt = {
  id: string; name: string; mime: string; dataUrl: string; size: number;
  path?: string; uploading?: boolean; progress?: number;
};

export function fmtSize(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return Math.round(n / 1024) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
/** 토큰 수 → 컴팩트 표기(256_000 → "256k", 1_000_000 → "1M") — 컨텍스트 미터 툴팁용. */
export function fmtTok(n: number): string {
  if (n >= 1_000_000) { const v = n / 1_000_000; return (n % 1_000_000 ? v.toFixed(1) : String(v)) + "M"; }
  if (n >= 1_000) return Math.round(n / 1_000) + "k";
  return String(n);
}
/** 인라인은 "data:<mime>;base64," 프리픽스를 벗겨 raw base64 로, 사이드밴드는 참조(path)로. */
export function attToPayload(a: PendingAtt): Attachment {
  if (a.path) return { name: a.name, mime: a.mime, path: a.path };
  const comma = a.dataUrl.indexOf(",");
  return { name: a.name, mime: a.mime, data: comma >= 0 ? a.dataUrl.slice(comma + 1) : a.dataUrl };
}
// ── 큐 영속화 ────────────────────────────────────────────────────────────────
// 제출됐지만 앞 턴이 끝나길 기다리는 대기 메시지를 conversationId 단위로 localStorage 에 보존한다.
// 슬롯 전환으로 Composer 가 언마운트되거나(위젯 setConversation·대화 메뉴 onSwitch) 씬클라
// 웹뷰가 파괴돼도 다음 마운트에서 복원된다. 실행 중인 턴은 브레인이 서버에 유지
// (loadActiveTurn 재부착)하지만 큐는 그 대칭짝이 없어 여기서 보존한다. file:// 오리진 등
// localStorage 가 막힌 환경을 대비해 모든 접근을 try/catch — 실패 시 영속화만 포기하고 세션 내
// 동작(기존 인메모리 큐)은 유지한다.
export type QItem = { text: string; atts: PendingAtt[] };
const queueStorageKey = (conv: string) => `relay:chat-queue:${conv}`;

export function loadQueue(conv: string): QItem[] {
  try {
    const raw = window.localStorage.getItem(queueStorageKey(conv));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((it: any) => it && typeof it.text === "string")
      .map((it: any) => ({ text: it.text as string, atts: Array.isArray(it.atts) ? (it.atts as PendingAtt[]) : [] }));
  } catch { return []; }
}

export function saveQueue(conv: string, q: QItem[]): void {
  const key = queueStorageKey(conv);
  try {
    if (q.length === 0) { window.localStorage.removeItem(key); return; }
    window.localStorage.setItem(key, JSON.stringify(q));
  } catch {
    // 첨부 base64 로 쿼터 초과 가능 — 텍스트만이라도 살린다(이미지 미리보기는 유실 감수).
    try { window.localStorage.setItem(key, JSON.stringify(q.map((it) => ({ text: it.text, atts: [] })))); }
    catch { /* localStorage 불가 — 영속화 포기, 세션 내 동작만 유지 */ }
  }
}

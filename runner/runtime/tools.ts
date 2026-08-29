// tools.ts — 세션이 보는 도구 목록과 그 집행. 에이전트가 기판을 **되부르는** 문의 안쪽이다
// (프로토콜 반쪽은 mcp.ts, 문 라우트는 daemon.ts).
//
// 매니페스트 세 선언이 여기서 도구가 된다:
//   agents[].scripts  → 스코프 안의 동사
//   agents[].dispatch → agent_dispatch 하나
//   edges[] (결재분)  → a2a__* · edge__* (edge 도구는 provider 의 동사이고, edges[].agent_access: full
//                        을 선언한 소비자에게만 provider 의 원격 MCP raw 도구도 같은 접두로 선다)
// 선언은 캡이고 결재가 승인이다 — 목록(tools/list)과 집행(tools/call)이 같은 문을 본다.
// 세션이 보는 것은 동사(자기 것과 빌린 것)뿐이다 — 서비스(폴더 포함)는 동사가 감싸서만 소비된다.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { RELAY_HOME, loadLedger, logLine, sessionDir, type Ledger } from "../supply/ledger.ts";
import { loadManifest, listScripts, agentScriptScope, type Manifest, type ServiceDecl } from "../supply/manifest.ts";
import { edgeAgentAccess } from "../supply/install.ts";
import { serviceAuthHeader } from "./oauth.ts";
// edge 소비 집행(callEdgeTool)의 정본은 실행 옆이다 — 세션 문과 동사 문(ctx.edge)이
// 같은 판정을 지나야 하므로 한 벌만 둔다
import { runScript, runScriptFrom, scriptMeta, callEdgeTool, mcpList, type HostBridge } from "./scripts.ts";
import { mcpDispatch, type McpIO, type McpToolInfo } from "./mcp.ts";
import { runSession, isSessionBusy, retireResident, localSessionIO, sessionTreeOf, INTERRUPTED_MARK, type SessionIO } from "./harness.ts";
import { a2aMissionMarker, a2aMissionSlot, a2aToolName, edgeToolName, parseA2aToolName, parseEdgeToolName, sanitizeToolSegment, PARAM_SLUGS_RE, SUB_SLOT_PREFIX } from "../protocol.ts";
import { json } from "../http.ts";
import type { Authority } from "../authority-contract.ts";

// 세션이 부를 수 있는 동사의 유일한 진리 — 목록(tools/list)과 집행(tools/call)이 같은 집합을
// 봐야 한다. 목록에만 스코프를 걸면 이름을 아는 세션이 아무 동사나 부른다 (선언 = 캡 원칙 위반)
// root = 세션이 서는 나무(설치본 또는 작업 사본, harness.ts sessionTreeOf) — 목록과 집행이 같은 나무를 본다
function sessionScriptSet(ledger: Ledger, pkg: string, agent: string, root: string = ledger.packages[pkg].path): Set<string> {
  const m = loadManifest(root);
  const agentsInPlay = [agent, ...((m.agents ?? []).find((a) => a.name === agent)?.dispatch ?? [])];
  const allScripts = listScripts(root, m);
  const inScope = new Set<string>();
  for (const a of agentsInPlay) {
    const scope = agentScriptScope(m, a);
    if (!scope) continue;
    for (const s of allScripts) if (scope(s)) inScope.add(s);
  }
  return inScope;
}

/** 원격 tools/list 의 결과를 목록 한 번 안에서 서버마다 한 번만 읽는다 */
type RemoteLists = Map<string, Promise<McpToolInfo[] | null>>;

/**
 * 빌린 도구 하나의 광고 — 결재된 이름이 provider 에서 무엇인가에 따라 갈린다. null = 목록에 세우지 않는다.
 *  · provider 의 동사 → 자기 동사와 같은 앎(meta 의 서술·입력 스키마)을 싣는다. 이름만 서면 세션은
 *    부를 수는 있되 인자 형을 모른다("가져온 스크립트"가 절반만 성립하던 자리)
 *  · provider 가 services[].url.tools 에 선언한 원격 MCP 도구 → 소비자가 agent_access: full 을
 *    선언했을 때만 raw 로 선다(서술·스키마는 그 서버의 tools/list 에서, 못 읽으면 이름만).
 *    scripts-only 면 세우지 않는다 — 목록과 집행(callEdgeTool 의 E_RAW_ACCESS)이 같은 집합을 본다
 *  · provider 미설치·판정 실패·둘 다 아님 → 이름으로 선다. 소비자의 목록 전체가 남의 판정 실패에
 *    무너지면 안 된다 — 부를 때 fail-loud 로 판정된다(verbLabels 와 같은 결)
 */
async function edgeToolInfo(ledger: Ledger, authority: Authority, consumer: string, provider: string, tool: string, agent: string, remote: RemoteLists): Promise<McpToolInfo | null> {
  const name = edgeToolName(provider, tool);
  const byName: McpToolInfo = { name, description: `edge 소비: ${provider} 의 ${tool}` };
  const rec = ledger.packages[provider];
  if (!rec) return byName;
  let m: Manifest;
  try {
    m = loadManifest(rec.path);
  } catch {
    return byName;
  }
  if (listScripts(rec.path, m).includes(tool)) {
    const meta = await scriptMeta(ledger, provider, tool);
    return {
      name,
      description: meta?.description ? `${meta.description} (${provider} 의 동사 — edge 소비)` : byName.description,
      inputSchema: meta?.input,
    };
  }
  const svc = (m.services ?? []).find((s): s is Extract<ServiceDecl, { url: string }> => "url" in s && s.url != null && (s.tools ?? []).includes(tool));
  if (!svc) return byName;
  if (edgeAgentAccess(ledger, consumer, provider) !== "full") return null;
  if (!remote.has(svc.url)) {
    remote.set(svc.url, (async () => mcpList(svc.url, await serviceAuthHeader(authority, provider, svc.name, svc.auth), { principal: authority.principal(), agent }))());
  }
  const info = (await remote.get(svc.url))?.find((t) => t.name === tool);
  return {
    name,
    description: info?.description ? `${info.description} (${provider} 의 ${svc.name} 서버 raw 도구)` : `raw MCP 도구: ${provider} 의 ${svc.name} 서버 — ${tool}`,
    inputSchema: info?.inputSchema,
  };
}

// 서술·입력 형의 정본은 동사 자신이다 — 기판이 이름으로 문장을 지어내면 tools/list 가 세션에게
// 아무것도 알려주지 못한다(이름을 두 번 읽는 셈). meta 를 수출한 동사는 그 서술과 JSON Schema 를
// 싣고, 수출하지 않은 동사는 현행 그대로 자동 서술 + 개방 스키마(mcp.ts 폴백)로 선다.
async function sessionTools(ledger: Ledger, authority: Authority, pkg: string, agent: string, root: string = ledger.packages[pkg].path): Promise<McpToolInfo[]> {
  const tools: McpToolInfo[] = [];
  for (const s of sessionScriptSet(ledger, pkg, agent, root)) {
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
  const remote: RemoteLists = new Map();
  for (const g of (await authority.grants()).filter((g) => g.consumer === pkg)) {
    if (g.mission) {
      tools.push({
        name: a2aToolName(g.provider, g.mission),
        description: `a2a 위임: ${g.provider} 의 ${g.mission} 미션. 별도 세션에서 돌고, 오래 걸리면 도구가 먼저 돌아오며 완료는 이 대화로 📬 배달된다. arguments: { payload: string }`,
      });
    }
    for (const t of g.tools ?? []) {
      const info = await edgeToolInfo(ledger, authority, pkg, g.provider, t, agent, remote);
      if (info) tools.push(info);
    }
  }
  return tools;
}

// ── 위임의 시한과 배달 ───────────────────────────────────────────────────────
// 위임(서브에이전트·a2a)은 세션 하나가 끝날 때까지 붙드는 장기 툴콜이라, 시한은 도구 자신이
// 가져야 한다. MCP 층(claude-code 어댑터 MCP_TOOL_TIMEOUT 240s)이 먼저 자르면 "timed out"
// 원문만 남고 완주한 위임의 답은 수신 세션 이력에만 앉아 발신 대화에 영영 닿지 않는다
// (실사고 2026-08-20: 240s 초과 위임). 골격은 org 와 같다: 도구는 180s 에 정직하게 물러나고,
// 위임은 계속 돌며, 완료는 발신 대화에 📬 프리픽스 턴으로 배달된다
// (위젯 SYSTEM_PROMPT_PREFIXES · watchServerTurns 계약).

function dispatchDeadlineS(): number {
  const s = Number(process.env.RELAY_DISPATCH_TIMEOUT_S);
  return s > 0 ? s : 180;
}

/** 시한 경주 — 이기면 봉투({reply}), 시한이 이기면 null. 빈 답도 답이므로 봉투로 감싼다
 *  (문자열을 그대로 겨루면 "" 가 시한 승리와 구별되지 않는다). */
async function raceDeadline(run: Promise<string>, s: number): Promise<{ reply: string } | null> {
  return await Promise.race([
    run.then((reply) => ({ reply })),
    new Promise<null>((resolve) => {
      const t = setTimeout(() => resolve(null), s * 1000);
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** 배달 주소 — 위임을 보낸 대화. slot 이 없으면(구 번들) 배달할 곳이 없다 */
interface DeliverTo {
  authority: Authority;
  pkg: string;
  agent: string;
  slot: string;
}

/** 결과가 앉는 자리 — 위임이 도는 대화. sweep 이 여기 이력을 읽어 결과를 찾는다 */
interface DeliverFrom {
  pkg: string;
  slot: string;
}

/** 📬 한 줄을 발신 대화에 턴으로 넣는다. 부모가 다른 턴을 처리 중이면 기다린다(한 슬롯에 턴
 *  하나) — 10초 간격, 최대 1시간. 배달했으면 true */
async function deliverNotice(to: DeliverTo, label: string, head: string, body: string): Promise<boolean> {
  const msg = `📬 위임 완료 — ${label}(${head})\n\n${String(body).slice(0, 4000)}`;
  for (let i = 0; i < 360; i++) {
    try {
      await runSession({ ledger: loadLedger(), pkg: to.pkg, agent: to.agent, authority: to.authority, prompt: msg, slot: to.slot });
      return true;
    } catch (e) {
      if (!String(e).includes("이전 요청을 처리")) return false;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  return false;
}

// ── 미결 배달 장부 ───────────────────────────────────────────────────────────
// 배달 약속이 프로세스 메모리에만 살면(promise 의 .then) 기판이 죽는 순간 통째로 사라진다:
// 위임은 완주했는데 발신 대화는 영영 모르고, 실패 로그조차 그 코드에 닿지 못해 안 남는다
// (실사고 2026-08-25 — 재시작이 진행 중 위임의 배달을 지웠고, 발신 대화의 마지막 말은
// "180초 안에 안 끝났습니다"로 남았다). 그래서 약속을 디스크에 적고 다음 기동이 주워 배달한다.
// 조직 기판의 notify_parent 컬럼 + 재배달 sweep 과 같은 골격의 1인용이다.
//
// 적어도 한 번(at-least-once)이다: 배달 성공과 장부 삭제 사이에 죽으면 다음 기동이 한 번 더
// 배달한다. 조용히 잃는 것보다 두 번 오는 편이 낫다 — 잃으면 사용자가 알 길이 없다.

const PENDING_DIR = path.join(RELAY_HOME, "dispatch-pending");
/** 배달 자체가 계속 실패하는 약속을 영원히 들고 있지 않는다 */
const PENDING_MAX_ATTEMPTS = 3;
/** 이보다 오래된 결과는 배달해도 그 대화의 맥락이 아니다 */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface PendingDelivery {
  id: string;
  to: { pkg: string; slot: string; agent: string };
  from: DeliverFrom;
  label: string;
  /** 이 시각 뒤에 앉은 bot 줄만 이 위임의 답이다 — 앞선 답을 결과로 착각하지 않는 근거 */
  since: number;
  attempts: number;
}

function writePending(rec: PendingDelivery): void {
  try {
    fs.mkdirSync(PENDING_DIR, { recursive: true });
    fs.writeFileSync(path.join(PENDING_DIR, rec.id + ".json"), JSON.stringify(rec));
  } catch { /* 장부를 못 적으면 메모리 사다리만 남는다 — 위임 자체를 막지는 않는다 */ }
}

function clearPending(id: string): void {
  try {
    fs.rmSync(path.join(PENDING_DIR, id + ".json"), { force: true });
  } catch { /* 이미 없음 */ }
}

function readPending(): PendingDelivery[] {
  let names: string[];
  try {
    names = fs.readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PendingDelivery[] = [];
  for (const n of names) {
    try {
      const rec = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, n), "utf8")) as PendingDelivery;
      if (rec?.id && rec.to?.pkg && rec.to?.slot && rec.from?.pkg && rec.from?.slot) out.push(rec);
      else fs.rmSync(path.join(PENDING_DIR, n), { force: true }); // 형이 아닌 파일은 장부가 아니다
    } catch { /* 깨진 줄 하나가 나머지 배달을 막지 않는다 */ }
  }
  return out;
}

/** 시한을 넘긴 위임의 종결 배달 — 발신 대화에 턴 하나로 넣는다. 성공도 실패도 배달한다:
 *  물러난 도구가 마지막 말이면 발신 세션은 위임이 끝났는지조차 모른다.
 *  약속을 먼저 장부에 적는다 — 이 프로세스가 죽어도 다음 기동이 이어받는다. */
function deliverOnSettle(run: Promise<string>, label: string, to: DeliverTo, from: DeliverFrom): void {
  const id = crypto.randomUUID();
  writePending({ id, to: { pkg: to.pkg, slot: to.slot, agent: to.agent }, from, label, since: Date.now(), attempts: 0 });
  const deliver = async (head: string, bodyText: string): Promise<void> => {
    if (await deliverNotice(to, label, head, bodyText)) clearPending(id);
    else logLine("dispatch", { ...from, label, delivered: false }); // 장부는 남는다 — 다음 기동이 다시 든다
  };
  void run.then((reply) => deliver("완료", reply), (e) => deliver("실패", e instanceof Error ? e.message : String(e)));
}

/**
 * 미결 배달 sweep — 기동 때 한 번. 지난 기동이 배달하지 못한 약속을 주워 발신 대화에 앉힌다.
 *
 * **끊긴 턴 복구(recoverDanglingTurns) 뒤에** 돌아야 한다: 중단된 위임의 마지막 줄은 그 복구가
 * 앉히고, 이 sweep 은 그 줄을 결과로 읽는다. 순서가 뒤집히면 아직 답이 없는 것으로 보여
 * 배달이 한 기동씩 밀린다.
 */
export async function sweepPendingDeliveries(
  authority: Authority,
  io: SessionIO = localSessionIO(loadLedger),
): Promise<number> {
  let sent = 0;
  for (const rec of readPending()) {
    if (Date.now() - rec.since > PENDING_TTL_MS || rec.attempts >= PENDING_MAX_ATTEMPTS) {
      clearPending(rec.id);
      logLine("dispatch", { ...rec.from, label: rec.label, delivered: false, dropped: true });
      continue;
    }
    let last;
    try {
      const msgs = io.readMessages(rec.from.pkg, rec.from.slot);
      last = msgs[msgs.length - 1];
    } catch { /* 위임 대화가 지워졌다 — 아래 판정이 건너뛴다 */ }
    // 마지막이 물음이면 아직 종결 전이고, 약속보다 앞선 답이면 이 위임의 것이 아니다.
    // 둘 다 장부를 그대로 둔다 — 다음 기동이 다시 본다
    if (!last || last.role !== "bot" || !(Date.parse(last.t) > rec.since)) continue;
    const head = last.text.includes(INTERRUPTED_MARK) ? "중단" : "완료";
    if (await deliverNotice({ ...rec.to, authority }, rec.label, head, last.text)) {
      clearPending(rec.id);
      sent++;
    } else {
      writePending({ ...rec, attempts: rec.attempts + 1 });
    }
  }
  return sent;
}

// 1인 기판의 문 이음새 구현(mcp.ts McpIO) — 프로토콜 합성은 mcpDispatch 한 벌이고, 여기는
// "무엇이 도구이고 누가 실행하는가"(세션 스코프 게이트·a2a 위임·edge 소비·runScript)만 답한다.
// handleMcp 의 io 기본값이 이 구현이라 1인 기판은 무변이고, 임베더는 같은 형의 자기 구현
// (자기 도구 레지스트리·자기 권위 판정)을 꽂는다 — run.ts RunnerIO 와 같은 결.
function localMcpIO(ledger: Ledger, authority: Authority, host: HostBridge, pkg: string, agent: string, callerSlot?: string | null): McpIO {
  // 작업 사본 위 세션이면 동사도 작업 사본의 것 — 고친 동사를 적용 전에 써보는 자리다. 그때는
  // host 브리지를 주지 않는다(draftRun 과 같은 규율: 시험 삼아 도는 코드에 ring-0 권능을 주지 않는다)
  const root = sessionTreeOf(pkg, callerSlot, ledger.packages[pkg].path);
  const onDraft = root !== ledger.packages[pkg].path;
  return {
    tools: () => sessionTools(ledger, authority, pkg, agent, root),
    call: async (name, args) => {
      const a2a = parseA2aToolName(name);
      const edge = parseEdgeToolName(name);
      if (a2a) {
        const m = loadManifest(ledger.packages[a2a.provider].path);
        const mission = (m.missions ?? []).find((x) => sanitizeToolSegment(x.name) === a2a.rest)?.name ?? a2a.rest;
        const grant = await authority.grantForMission(pkg, a2a.provider, mission);
        if (!grant) throw new Error(`E_NO_GRANT: ${pkg} -> ${a2a.provider}/${mission}`);
        // 진행 중인 같은 위임 위에 얹지 않는다 — runSession 의 슬롯 직렬화가 사람에게 하는
        // 말("끝나면 이어서 말씀해 주세요")로 튕기면 모델은 그것을 재시도 신호로 읽는다.
        // 열쇠는 브리지가 세션을 여는 열쇠와 같은 벌이어야 한다(정본: protocol.ts)
        const slot = a2aMissionSlot(mission, pkg);
        if (isSessionBusy(a2a.provider, slot)) {
          throw new Error(`이미 진행 중인 위임: ⇄ ${a2a.provider} · ${mission} — 완료가 이 대화로 📬 배달된다. 기다렸다가 필요하면 그때 재위임하라.`);
        }
        const run = host.dispatch(a2a.provider, mission, String(args.payload ?? JSON.stringify(args)), pkg);
        const missionDeadlineS = dispatchDeadlineS();
        const done = await raceDeadline(run, missionDeadlineS);
        if (done) return done.reply;
        if (callerSlot) deliverOnSettle(run, `${a2a.provider} · ${mission}`, { authority, pkg, agent, slot: callerSlot }, { pkg: a2a.provider, slot });
        return `위임이 ${missionDeadlineS}초 안에 끝나지 않았습니다 — ${a2a.provider} 의 "${mission}" 미션이 세션 "⇄ ${pkg} → ${mission}" 에서 계속 돌고 있고, 완료되면 이 대화로 📬 배달됩니다. 결과를 기다리거나 재시도하지 말고, 사용자에게 진행 중임을 알리세요.`;
      }
      if (edge) return await callEdgeTool(ledger, authority, pkg, edge.provider, edge.tool, args, host, agent, [pkg]);
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
              ? `${SUB_SLOT_PREFIX}${sub}-${param.replace(/,/g, ".")}`
              : `${SUB_SLOT_PREFIX}${sub}-k${crypto.createHash("sha256").update(param).digest("hex").slice(0, 8)}`
            ).slice(0, 64)
          : `${SUB_SLOT_PREFIX}${sub}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 64);
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
        // 부모 대화 — 이 위임이 어디로 📬 를 보내는지(§5.3-26). 종전엔 이 관계가 아래
        // deliverOnSettle 의 클로저에만 살아서 데몬과 함께 죽었다. 그러면 다시 뜬 화면은
        // 진행 중인 위임을 보고도 "누가 시킨 일인지" 를 말하지 못한다 — 목록이 위임을
        // 부모 대화 아래 세우려면 재기동을 견디는 자리에 있어야 한다
        if (callerSlot) fs.writeFileSync(path.join(sdir, "parent"), callerSlot);
        // 마커는 화면 계약이다 — 위젯 SubAgentDispatchCard(SUBAGENT_RE)가 이 머리를 위임
        // 카드로 렌더한다(org turn.service dispatch 와 같은 형식)
        const prompt = `[서브에이전트 · ${pkg} · ${sub}]\n${instruction}`;
        // 시한과 배달은 위임 두 형의 공통 사다리다(위 dispatchDeadlineS·raceDeadline·deliverOnSettle)
        const run = runSession({ ledger, pkg, agent: sub, authority, prompt, slot }).then((r) => r.reply);
        const timeoutS = dispatchDeadlineS();
        const winner = await raceDeadline(run, timeoutS);
        if (winner) return winner.reply;
        if (callerSlot) deliverOnSettle(run, sub, { authority, pkg, agent, slot: callerSlot }, { pkg, slot });
        return `위임이 ${timeoutS}초 안에 끝나지 않았습니다 — 서브에이전트는 세션 "↳ ${sub}" 에서 계속 돌고 있고, 완료되면 이 대화로 📬 배달됩니다. 결과를 기다리거나 재시도하지 말고, 사용자에게 진행 중임을 알리세요.`;
      }
      // 집행도 목록과 같은 스코프를 본다 — 이름을 아는 세션이 선언 밖 동사를 부르는 구멍의 답
      if (!sessionScriptSet(ledger, pkg, agent, root).has(name)) throw new Error(`E_SCOPE: ${agent} 세션 스코프 밖 동사: ${name}`);
      if (onDraft) return await runScriptFrom(ledger, pkg, root, name, args, { principal: authority.principal(), agent }, null, authority);
      return await runScript(ledger, pkg, name, args, { principal: authority.principal(), agent }, host, authority);
    },
  };
}

export async function handleMcp(
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

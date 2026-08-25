// tools.ts — 세션이 보는 도구 목록과 그 집행. 에이전트가 기판을 **되부르는** 문의 안쪽이다
// (프로토콜 반쪽은 mcp.ts, 문 라우트는 daemon.ts).
//
// 매니페스트 세 선언이 여기서 도구가 된다:
//   agents[].scripts  → 스코프 안의 동사
//   agents[].dispatch → agent_dispatch 하나
//   edges[] (결재분)  → a2a__* · edge__*
// 선언은 캡이고 결재가 승인이다 — 목록(tools/list)과 집행(tools/call)이 같은 문을 본다.
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadLedger, logLine, sessionDir, type Ledger } from "../supply/ledger.ts";
import { loadManifest, listScripts, agentScriptScope, type Manifest } from "../supply/manifest.ts";
// edge 소비 집행(callEdgeTool)의 정본은 실행 옆이다 — 세션 문과 동사 문(ctx.edge)이
// 같은 판정을 지나야 하므로 한 벌만 둔다
import { runScript, scriptMeta, callEdgeTool, type HostBridge } from "./scripts.ts";
import { mcpDispatch, McpGateError, type McpIO, type McpToolInfo } from "./mcp.ts";
import { runSession, isSessionBusy, retireResident } from "./harness.ts";
import { a2aMissionMarker, a2aToolName, edgeToolName, parseA2aToolName, parseEdgeToolName, sanitizeToolSegment, PARAM_SLUGS_RE } from "../protocol.ts";
import { json } from "../http.ts";
import type { Authority } from "../authority-contract.ts";

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

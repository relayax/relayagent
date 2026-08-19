// MCP 문 합성 — 세션(하네스)이 기판 동사를 부르는 문의 프로토콜 반쪽.
// 권위 이음새(authority-contract.ts)·실행 이음새(run.ts RunnerIO)의 문(門)측 자매다: 저 둘이
// "누구로서·어떤 자격으로"와 "그 답을 스폰 env 로 나르는 손"이라면, 이 파일은 "세션이 보는
// 도구 목록과 그 집행"을 한 프로토콜(initialize·ping·tools/list·tools/call)로 굽는 입이다.
// 의존성 0 — 임베더(조직 기판)가 벤더링해 소비하는 아티팩트라 runner 내부 형(state.ts
// Ledger 등)을 끌어오지 않는다(익명의 제3자 임베더 테스트 — authority-contract.ts 와 동급).
//
// 이음새(McpIO): 도구 목록(tools)과 도구 실행(call)을 모듈 좌표가 아니라 인자로 받는다.
// 1인 기판은 api.ts 의 localMcpIO(세션 스코프·a2a·edge·runScript)가 꽂히고, 임베더는 같은
// 형의 자기 구현을 꽂는다. 어느 답도 특정 기판의 형상을 요구하지 않는다 — 도구가
// (이름·설명·스키마) 목록이고 실행이 (이름, 인자) → 값 인 것뿐이다.
// 직렬화 방언(text·errorText)만 선택 주입이다: 프로토콜(무엇이 목록이고 무엇이 실패인가)은
// 여기 한 벌이고, 표기(결과·실패를 한 줄로 어떻게 쓰는가)만 기판이 고른다.

export interface McpToolInfo {
  name: string;
  description?: string;
  /** 미지정이면 관용 스키마({type:"object", additionalProperties:true})로 합성된다 */
  inputSchema?: Record<string, unknown>;
}

/** 게이트 위반(미지 도구·스코프 밖) — JSON-RPC error 봉투로 나간다. 실행 실패(throw 일반)는
 *  isError 결과로 나간다: 전자는 "부를 수 없는 문", 후자는 "부른 문이 안에서 실패"다. */
export class McpGateError extends Error {
  readonly rpcCode: number;
  constructor(message: string, rpcCode = -32602) {
    super(message);
    this.rpcCode = rpcCode;
  }
}

export interface McpIO {
  /** initialize serverInfo 에 뜨는 이름 (기본 "relay") */
  serverName?: string;
  /** 클라이언트가 protocolVersion 을 안 밝힐 때의 기본값 (기본 MCP_PROTOCOL_VERSION) */
  protocolVersion?: string;
  /** 세션이 부를 수 있는 도구의 목록 — 목록(tools/list)과 집행(tools/call)이 같은 집합을
   *  봐야 한다(선언 = 캡): 목록에만 스코프를 걸면 이름을 아는 세션이 아무 동사나 부른다 */
  tools(): McpToolInfo[] | Promise<McpToolInfo[]>;
  /** 도구 실행 — 반환값이 MCP result 형(content[])이면 그대로, 아니면 text 로 직렬화.
   *  throw = isError 결과, McpGateError throw = JSON-RPC error 봉투 */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** 결과 → content[0].text 표기 (기본: string 원문, 그 외 JSON.stringify(_, null, 2)) */
  text?(result: unknown): string;
  /** 실행 실패 → content[0].text 표기 (기본: String(e)) */
  errorText?(e: unknown): string;
}

export const MCP_PROTOCOL_VERSION = "2025-03-26";

/** 이 문이 말할 수 있는 판들. 쓰는 축이 도구 넷(initialize·ping·tools/list·tools/call)뿐이라
 *  이 판들 사이에서 봉투가 같다 — 목록 밖 판은 협상 대상이 아니다 */
const MCP_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);

export interface McpReply {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/** 메시지 하나의 판정 — null = 응답 없음(notification: 전송측이 202 로 수렴).
 *  전송(HTTP·배치)은 부르는 쪽 소관이다 — 이 함수는 봉투만 안다. */
export async function mcpDispatch(
  io: McpIO,
  msg: { id?: unknown; method?: unknown; params?: Record<string, unknown> },
): Promise<McpReply | null> {
  const id = msg?.id;
  const method = String(msg?.method ?? "");
  const reply = (result: unknown): McpReply => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): McpReply => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (method === "initialize") {
    const want = msg?.params?.protocolVersion;
    const mine = io.protocolVersion ?? MCP_PROTOCOL_VERSION;
    // 협상은 서버 몫이다: 청한 판을 무조건 에코하면 모르는 방언을 이해한다고 답하는 셈이고,
    // 클라이언트는 그 판의 규칙으로 말하기 시작한다. 말할 수 있는 판이면 맞추고 아니면 내 판을 낸다
    const agreed = typeof want === "string" && (want === mine || MCP_PROTOCOL_VERSIONS.has(want)) ? want : mine;
    return reply({
      protocolVersion: agreed,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: io.serverName ?? "relay", version: "0.1.0" },
    });
  }
  if (method.startsWith("notifications/")) return null;
  if (method === "ping") return reply({});
  if (method === "tools/list") {
    const tools = await io.tools();
    return reply({
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? "",
        inputSchema: t.inputSchema ?? { type: "object", additionalProperties: true },
      })),
    });
  }
  if (method === "tools/call") {
    const name = String(msg?.params?.name ?? "");
    const args = (msg?.params?.arguments ?? {}) as Record<string, unknown>;
    try {
      const result = await io.call(name, args);
      // 이미 MCP result 형(content[])이면 그대로 — 도구가 봉투까지 만든 경우(커넥터류)를 존중
      if (result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)) {
        return reply(result);
      }
      const text = io.text
        ? io.text(result)
        : typeof result === "string"
          ? result
          : JSON.stringify(result, null, 2);
      return reply({ content: [{ type: "text", text }], isError: false });
    } catch (e) {
      if (e instanceof McpGateError) return fail(e.rpcCode, e.message);
      return reply({ content: [{ type: "text", text: io.errorText ? io.errorText(e) : String(e) }], isError: true });
    }
  }
  // id 없는 미지 메서드는 notification 취급(응답 없음) — 있으면 JSON-RPC 표준 미지 메서드
  return id === undefined ? null : fail(-32601, `지원하지 않는 메서드: ${method}`);
}

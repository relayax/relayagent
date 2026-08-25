import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { workspaceDir, type Grant, type Ledger } from "../supply/ledger.ts";
import { serviceAuthHeader } from "./oauth.ts";
import { localAuthority } from "../authority.ts";
import type { Authority } from "../authority-contract.ts";
import { loadManifest, listScripts, agentScriptScope, type Manifest, type ServiceDecl } from "../supply/manifest.ts";
import { resolveProvider } from "../supply/install.ts";
// dir 문의 집행 정본 — 세션 도구(dir__*)와 여기가 같은 감금·같은 연산을 지난다
import { dirCall, ensureDirRoot, resolveDirService } from "./dirs.ts";

export interface HostBridge {
  registry(): unknown;
  install(dir: string, opts?: { ring0?: boolean; workspace?: string; bindings?: Record<string, string> }): unknown;
  build(name: string): unknown;
  remove(name: string): unknown;
  grants(): Promise<Grant[]>;
  /** 결재는 권위 이음새의 단일 문(authority.recordGrant)을 지난다 — 비동기 계약 */
  grant(g: Grant): Promise<unknown>;
  validate(dir: string): unknown;
  /** consumer = 발신 패키지 — 수신 대화의 위임 마커·라벨에 발신자의 얼굴을 남긴다 */
  dispatch(provider: string, mission: string, payload: string, consumer?: string): Promise<string>;
  // 수정 레이어 (draft.ts). 설치본은 실행 중이라 직접 만지지 않는다 — 편집은 draft, 반영은 publish
  draftOpen(name: string, opts?: { files?: Record<string, string>; seedHarness?: { source: string; entry: string }[] }): unknown;
  draftRead(name: string, file?: string): unknown;
  /** base = 파일별 마지막 읽기 지문(draft-read 의 hash) — 실으면 그 사이 다른 손의 수정을
   *  E_CONFLICT 로 판정한다(동시 편집 방어, opt-in). null = 없는 파일로 알고 있다 */
  draftWrite(name: string, files?: Record<string, string>, deletes?: string[], base?: Record<string, string | null>): unknown;
  draftDiff(name: string): unknown;
  draftCommit(name: string, message: string): unknown;
  draftValidate(name: string): unknown;
  draftPublish(name: string, opts?: { version?: string }): unknown;
  draftDiscard(name: string): unknown;
  draftList(): unknown;
  /** 봉투 굽기 — 설치본을 선반에 앉힌다. 스토어 등재의 재료가 여기서 나온다.
   *  deliverTo = 건네받을 패키지(부르는 쪽) — 그 파일 교환 무대에 사본을 놓아 대화에서
   *  그대로 내려받게 한다. 선반은 기판 장기라 세션이 닿지 못한다 */
  pack(name: string, deliverTo?: string): unknown;
  releaseList(name: string): unknown;
  releaseRollback(name: string, version: string): unknown;
}

/** 누구로서 — 이 실행을 감싸는 신원. principal 은 권위 이음새의 답, agent 는 그 안의 세션 얼굴 */
export interface CallerIdentity {
  principal: string;
  agent?: string;
}

/**
 * 동사가 선택적으로 수출하는 메타. 실행 계약(기본 수출 async 함수)의 상위 호환이다 —
 * meta 없는 동사는 무변이고, 있으면 세션 문(MCP tools/list)이 그 서술과 입력 형을 싣는다.
 * 이름은 여기 없다: 파일명이 이름의 정본이라 두 곳에 적으면 어긋날 자리가 생긴다.
 * input/output 은 JSON Schema 리터럴이고 기판은 형을 광고만 한다 — 검증기는 의존이고
 * 의존성 0 규율이 형 광고보다 먼저다. 입력 판정은 동사 본문의 몫으로 남는다.
 */
export interface ScriptMeta {
  description?: string;
  input?: Record<string, unknown>;
  /** tools/list 에는 아직 싣지 않는다 — MCP 2025-03-26 에 outputSchema 자리가 없다 */
  output?: Record<string, unknown>;
  /** 기판이 모르는 키 — 판정도 삭제도 하지 않고 그대로 통과시킨다(임베더 게이트의 어휘 자리) */
  [key: string]: unknown;
}

/**
 * 서비스 손잡이 — 형이 넷이어도 접근자는 하나라서 두 문을 다 싣는다. 자기 형이 아닌 문은
 * 사유를 실어 되돌린다(fail-loud): 형마다 다른 손잡이를 주면 저작자가 "몸이 무엇이냐"를 먼저
 * 외워야 하고, 그 순간 자격·신원이 한 문으로 모이지 않는다.
 *
 * dir 형도 이 손잡이를 지난다(2026-08-25). 종전에는 "폴더는 문이 아니다"라며 되돌렸는데,
 * 폴더를 세션에 도구로 세우고 나니 문이 맞다 — 전송만 다르다(기판이 프로세스 안에서 직접
 * 선다). 예외가 하나 사라져 네 형이 한 접근자로 모인다.
 */
export interface ServiceHandle {
  url: string;
  /** url·source 형 — MCP over HTTP. dir 형 — 기판이 세우는 파일 문(list·read·write·remove) */
  call(tool: string, args: unknown): Promise<unknown>;
  /** api 형 — 선언된 base 접두 안쪽으로만 나가는 REST 요청. Authorization 은 기판이 붙인다 */
  fetch(path: string, init?: RequestInit): Promise<Response>;
}

/** 결재된 provider 하나로 열린 문 — edges[] 선언 × grants 결재를 지난 것만 부를 수 있다 */
export interface EdgeHandle {
  /** 설치 이름으로 해석된 provider */
  provider: string;
  /** provider 의 동사 하나. 결재 밖이면 E_NO_GRANT 로 막힌다(선언 = 캡, 결재 = 승인) */
  call(verb: string, args?: unknown): Promise<unknown>;
}

export interface ScriptCtx {
  pkg: string;
  caller: CallerIdentity;
  /**
   * 이 패키지의 바닥 — 세션이 딛는 그 폴더(규율 6: "세션은 결재된 workspace 폴더 하나를 딛고,
   * 그 밖의 폴더가 dir 서비스다"). 작업 산출물의 거처이고, 없으면 여는 시점에 생긴다.
   *
   * 이 접근자가 없던 동안 저작자에게 남은 길은 자기 바닥을 `dir: ~/Relay/<자기이름>` 으로
   * **다시 선언**하는 것뿐이었다(세션은 cwd 로 딛지만 동사는 기판 안에서 돈다). 그 재선언은
   * 문법상 "남의 폴더 신청"과 같은 모양이라, 지도에서 자기 데이터와 남의 데이터가 구별되지
   * 않았다 — 구멍을 메우는 자리다.
   */
  workspace: string;
  /**
   * 선언한 dir 서비스의 **절대경로**. `~` 형은 설치 결재로 바인딩된 신청이다(자기 바닥은 workspace).
   * 동사는 기판 안에서 도므로 경로를 직접 받는다 — 감금이 필요하면 ctx.service(이름) 쪽 파일
   * 문을 쓴다(세션이 보는 dir__* 도구와 같은 판정 한 벌). 세션에는 이 경로를 넘기지 않는다.
   */
  dir(name: string): string;
  service(name: string): ServiceHandle;
  /**
   * 남의 패키지의 동사 — edges[] 로 선언하고 결재된 것만. 자기 데이터는 dir·service 로 갖고
   * **남의 데이터는 이 문으로만** 닿는다: 남의 폴더를 dir 로 가리키면 캡이 폴더 전체가 되고,
   * 저쪽의 저장 형식이 이쪽 소스로 복제되어 선언에 없는 결합이 생긴다(지도·권한 화면·판정
   * 어디에도 안 걸리는 결합이다). relayos 의 ctx.binding(…).callTool(…) 과 같은 축이다.
   */
  edge(provider: string): EdgeHandle;
  dispatch(provider: string, mission: string, payload: string): Promise<string>;
  host?: HostBridge;
}

/**
 * api 요청 좌표 — 선언 base 의 접두 밖은 거부한다. 집행이 없으면 매니페스트의 base 선언과
 * 고지서의 "이 주소로 나갑니다"가 지킬 수 없는 약속이 된다: 자격이 붙은 요청이 어디로든
 * 갈 수 있으면 선언은 광고지 사실이 아니다. 다른 호스트의 절대 URL 도, 상대 경로의 ../ 도,
 * base 가 경로를 가질 때의 루트 탈출(/foo)도 이 판정 하나로 같이 막힌다.
 */
export function apiTarget(base: string, p: string, name: string): string {
  const root = base.endsWith("/") ? base : base + "/";
  const u = new URL(p, root);
  if (u.href !== base && !u.href.startsWith(root)) {
    throw new Error(`api 서비스 base 밖 요청: ${name} — ${u.href} 는 ${base} 접두 밖입니다`);
  }
  return u.href;
}

// 몸 주소 이음새 — "이 패키지의 이 source 서비스가 어디서 듣는가"의 답 하나.
// RunnerIO(run.ts)·McpIO(mcp.ts)와 같은 결의 주입점이다: 주소 해석이 모듈 좌표에 박히면
// 조직 기판(몸이 loopback 이 아니라 클러스터 좌표에 사는 기판)이 소스를 패치해야 한다.
// 익명의 제3자 임베더 테스트 — 이 형은 특정 조직 기판을 모른다: 답이 (패키지, 서비스, 선언 port)
// → (주소, 그 문이 요구하는 자격 헤더) 인 것뿐이고, 어느 쪽도 밖의 형상을 요구하지 않는다.
// 자격 헤더가 이음새에 있는 이유: source 형에는 문법상 auth 자리가 없어서(선언 없음) 기판이
// 지어낼 수 없다. 메시(mesh) 토큰 같은 인프라 자격은 그 인프라를 아는 임베더만 답할 수 있다.
export interface ServiceIO {
  /** null = 세울 수 있는 문이 없음 → 부르는 쪽이 fail-loud */
  body(pkg: string, service: string, port: number | null): { url: string; authorization?: string } | null;
}

// 1인 기판의 기본 이음새 — 선언 port 의 loopback. 프로세스 형은 env.PORT 로 그 포트를 받고,
// 컨테이너 형은 -p <port>:<port> 로 같은 좌표에 매핑된다(run.ts startSourceService) —
// 두 형이 기판 쪽에서 같은 주소로 보이는 것이 요점이다. MCP 문은 그 포트의 루트다:
// 선언이 고정하는 것은 포트뿐이라 경로를 덧붙이면 없는 문법을 지어내는 셈이 된다.
export const localServiceIO: ServiceIO = {
  body: (_pkg, _service, port) => (port ? { url: `http://127.0.0.1:${port}` } : null),
};

export async function mcpCall(url: string, tool: string, args: unknown, authHeader?: string, identity?: CallerIdentity): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (authHeader) headers.authorization = authHeader;
  // 신원 축 — authorization 이 "어떤 자격으로"라면 이 둘은 "누구로서"다. 원격 몸(예: RLS 를
  // 세션 변수로 거는 postgres 몸)은 자격만으로 행을 좁힐 수 없어 호출자의 신원을 따로 봐야 한다.
  // 저작자 코드가 신원을 나르면 잊거나 위조할 수 있으므로 기판이 넣는다 — 동사는 이 헤더에 손이 없다
  if (identity?.principal) headers["x-relay-principal"] = identity.principal;
  if (identity?.agent) headers["x-relay-agent"] = identity.agent;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name: tool, arguments: args ?? {} } }),
  });
  const text = await res.text();
  const jsonLine = text.startsWith("event:") || text.includes("\ndata:") ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5) : text;
  const parsed = JSON.parse(jsonLine ?? "{}");
  if (parsed.error) throw new Error(`MCP 오류: ${JSON.stringify(parsed.error)}`);
  return parsed.result;
}

// host_methods 선언 = ring-0 브리지의 캡. 미선언이면 전체(ring-0 결재가 유일한 경계 — 현행 호환),
// 선언하면 목록 밖 메서드는 거부한다. 메서드 이름 좌표는 host.<동사_스네이크> (draftPublish → host.draft_publish)
const hostKey = (prefix: string, method: string): string => prefix + "." + method.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

function capHost(bridge: HostBridge, declared: string[] | undefined): HostBridge {
  if (!declared || !declared.length) return bridge;
  return capNode(bridge, "host", new Set(declared)) as HostBridge;
}

/** 캡 집행의 한 마디. 함수가 아닌 값을 그대로 통과시키면 중첩 브리지(org 표기
 *  host.<도메인>.<동사> — 문법이 허용한다)에서 캡이 조용히 무력해진다: host.members 는
 *  함수가 아니므로 그냥 나가고, 그 위의 list 는 아무 판정도 지나지 않는다. 마디마다 같은
 *  규칙을 물려 내려가 선언과 집행의 좌표를 하나로 둔다 */
function capNode(target: object, prefix: string, allowed: Set<string>): object {
  return new Proxy(target, {
    get(t, prop) {
      const v = (t as Record<string | symbol, unknown>)[prop];
      if (typeof prop !== "string") return v;
      const key = hostKey(prefix, prop);
      if (typeof v === "function") {
        if (!allowed.has(key)) {
          return () => {
            throw new Error(`host_methods 미선언 메서드: ${key}`);
          };
        }
        return (v as (...a: unknown[]) => unknown).bind(t);
      }
      return v && typeof v === "object" ? capNode(v as object, key, allowed) : v;
    },
  });
}

export function makeCtx(
  ledger: Ledger,
  pkg: string,
  caller: CallerIdentity,
  hostBridge: HostBridge | null,
  authority: Authority,
  io: ServiceIO = localServiceIO,
  chain: string[] = [],
): ScriptCtx {
  const rec = ledger.packages[pkg];
  const m = loadManifest(rec.path);
  return {
    pkg,
    caller,
    get workspace() {
      return workspaceDir(ledger, pkg);
    },
    dir: (name) => resolveDirService(ledger, pkg, m, name),
    // 서비스 선언 네 형이 한 접근자를 지난다 — 저작자가 "몸이 url 이냐 api 냐 source 냐"를
    // 외우지 않아야 자격·신원이 한 문으로 모인다. 형마다 다른 접근자를 두면 그 문을 안 지나는
    // 몸이 생기고, 신원 없이 불리는 비대칭이 바로 거기서 난다.
    service: (name) => {
      const svc = (m.services ?? []).find((s) => s.name === name);
      if (!svc) throw new Error(`미선언 서비스: ${name}`);
      // dir 형 = 폴더 문. 기판이 프로세스 안에서 직접 세우므로 네트워크 홉이 없고, 감금·연산은
      // 세션 도구(dir__*)와 같은 한 벌(dirs.ts)을 지난다 — 두 입구가 다른 답을 내면 캡이 아니라
      // 우연이다(edge 소비와 같은 규율). 자격·신원 축은 없다: 나가는 요청이 아니다.
      if ("dir" in svc && svc.dir != null) {
        const root = ensureDirRoot(resolveDirService(ledger, pkg, m, name));
        return {
          url: `dir://${name}`,
          call: (op, args) => dirCall(root, op, (args ?? {}) as Record<string, unknown>),
          fetch: async () => {
            throw new Error(`폴더 문에는 fetch 가 없습니다: ${name} — 파일 연산은 ctx.service("${name}").call("read"|"list"|"write"|"remove", 인자)`);
          },
        };
      }
      // api 형 = REST 몸. 자격이 동사의 손을 지나지 않는 유일한 형이다: 기판이 호출 시점에
      // 풀어 헤더로 붙이고(oauth 번들은 만료 60초 전 자동 회전, oauth.ts) 목적지는 apiTarget 이
      // 선언 base 안으로 묶는다. 신원 헤더(x-relay-*)는 싣지 않는다 — 남의 REST API 에 우리
      // principal 을 흘리는 축이 되고, 저쪽은 그 어휘를 모른다.
      if ("api" in svc && svc.api != null) {
        const a = svc as Extract<ServiceDecl, { api: string }>;
        return {
          url: a.api,
          call: () => {
            throw new Error(`api 서비스는 MCP 문이 아닙니다: ${name} — REST 요청은 ctx.service("${name}").fetch(경로, init)`);
          },
          fetch: async (p, init) => {
            const target = apiTarget(a.api, p, name);
            const headers = new Headers(init?.headers);
            const authHeader = await serviceAuthHeader(authority, pkg, name, a.auth);
            if (authHeader) headers.set("authorization", authHeader);
            return await fetch(target, { ...init, headers });
          },
        };
      }
      // 신원(caller)은 남은 두 형에서 같은 규칙으로 실린다: 원격 몸이 "누구로서"를 모르면
      // 자격 하나로 모든 행을 본다. 자격만 형마다 출처가 다르다 —
      // url 형은 선언된 auth 의 해석(호출 시점 — oauth 번들은 만료 60초 전 자동 회전, oauth.ts),
      // source 형은 문법에 auth 자리가 없어 이음새가 주는 것뿐이다(없으면 없는 대로).
      const noFetch = (): never => {
        throw new Error(`MCP 문에는 fetch 가 없습니다: ${name} — 도구 호출은 ctx.service("${name}").call(도구, 인자)`);
      };
      if ("url" in svc && svc.url != null) {
        const u = svc as Extract<ServiceDecl, { url: string }>;
        return { url: u.url, call: async (tool, args) => mcpCall(u.url, tool, args, await serviceAuthHeader(authority, pkg, name, u.auth), caller), fetch: noFetch };
      }
      const src = svc as Extract<ServiceDecl, { source: string }>;
      const body = io.body(pkg, name, src.port ?? null);
      if (!body) throw new Error(`몸 주소 없음: ${name} — source 서비스는 port 를 선언해야 기판이 문을 세웁니다`);
      return { url: body.url, call: (tool, args) => mcpCall(body.url, tool, args, body.authorization, caller), fetch: noFetch };
    },
    // 남의 동사 — 선언(edges[])이 캡이고 결재(grants)가 승인이다. 판정은 세션 문과 같은
    // 한 벌(callEdgeTool)을 지난다. provider 는 edges[].provider 에 적은 참조 그대로 쓰면 된다
    // (설치 이름·매니페스트 이름·버전 꼬리표 셋 다 해석한다 — 저작자가 설치 이름을 외울 필요가 없다)
    edge: (ref) => {
      const provider = resolveProvider(ledger, ref);
      if (!provider) throw new Error(`E_NO_PROVIDER: edge provider 미설치 — ${ref} (edges[] 선언의 provider 가 장부에 없습니다)`);
      return {
        provider,
        call: (verb, args) => callEdgeTool(ledger, authority, pkg, provider, verb, args ?? {}, hostBridge, caller.agent, chain),
      };
    },
    dispatch: (provider, mission, payload) => {
      if (!hostBridge) throw new Error("dispatch 불가: host 브리지 없음");
      return hostBridge.dispatch(provider, mission, payload, pkg);
    },
    host: rec.ring === 0 && hostBridge ? capHost(hostBridge, m.host_methods) : undefined,
  };
}

/**
 * edge 소비의 집행 — **한 벌뿐이다**. 세션 문(tools.ts edge__* 도구)과 동사 문(ctx.edge)이
 * 같은 판정·같은 신원 규칙을 지나야 한다: 두 입구가 다른 답을 내면 "에이전트로는 되는데
 * 스크립트로는 안 된다"(또는 그 반대)가 되고, 그건 캡이 아니라 우연이다.
 *
 * chain 은 호출 스택(자기 포함) — A→B→A 순환을 여기서 끊는다. 없으면 서로를 부르는 두
 * 패키지가 스택을 태우고 죽는데, 그 실패에는 원인이 남지 않는다.
 */
export async function callEdgeTool(
  ledger: Ledger,
  authority: Authority,
  consumer: string,
  provider: string,
  tool: string,
  args: unknown,
  host: HostBridge | null,
  agent?: string,
  chain: string[] = [],
): Promise<unknown> {
  if (chain.includes(provider)) {
    throw new Error(`E_EDGE_CYCLE: 순환 소비 — ${[...chain, provider].join(" -> ")}`);
  }
  // 인가 판정은 권위 이음새를 지난다 — "누구로서(consumer), 무엇을(provider/tool), 어떤 자격으로"
  const grant = await authority.grantForTool(consumer, provider, tool);
  if (!grant) throw new Error(`E_NO_GRANT: ${consumer} -> ${provider}/${tool}`);
  const rec = ledger.packages[provider];
  // 결재는 남았는데 설치가 사라진 자리 — 조용히 TypeError 로 죽으면 원인이 결재인지 설치인지 모른다
  if (!rec) throw new Error(`E_NO_PROVIDER: 미설치 provider — ${provider} (결재는 남아 있습니다)`);
  const m = loadManifest(rec.path);
  const urlSvc = (m.services ?? []).find((s): s is Extract<ServiceDecl, { url: string }> => "url" in s && s.url != null && (s.tools ?? []).includes(tool));
  // 소비의 두 축은 여기서 갈라진다 — 자격은 provider, 신원은 원 호출자.
  // 자격: provider 의 것으로 나간다(몸과의 연결은 provider 가 소유한다 — ctx.service 와 같은
  //   해석: token·oauth 회전). 무자격 호출이던 구멍의 답.
  // 신원: 소비를 발화한 쪽의 것으로 나간다(principal = 그 사람, agent = 그 세션의 얼굴).
  //   신원까지 provider 로 바꾸면 principal 로 RLS 를 거는 몸이 소비자 사용자를 못 보고
  //   provider 하나로 뭉뚱그린다 — 인가가 consumer→provider 로 기록되는 것과 같은 결이다.
  //   agent 이름은 consumer 패키지의 어휘다: provider 는 이것을 자기 에이전트로 읽으면 안 된다.
  //   ctx.service 와 같은 규칙을 쓴다 — 같은 질문에 두 경로가 다른 답을 내면 안 된다.
  const identity = { principal: authority.principal(), agent };
  if (urlSvc) return await mcpCall(urlSvc.url, tool, args, await serviceAuthHeader(authority, provider, urlSvc.name, urlSvc.auth), identity);
  if (listScripts(rec.path, m).includes(tool)) return await runScript(ledger, provider, tool, args, identity, host, authority, localServiceIO, chain);
  throw new Error(`provider 에 해당 동사 없음: ${provider}/${tool}`);
}

export async function runScript(
  ledger: Ledger,
  pkg: string,
  name: string,
  input: unknown,
  caller: CallerIdentity,
  hostBridge: HostBridge | null,
  authority: Authority = localAuthority(() => ledger),
  io: ServiceIO = localServiceIO,
  /** 호출 스택 — edge 소비가 겹칠 때 순환을 끊는 축(callEdgeTool 이 검사한다) */
  chain: string[] = [],
): Promise<unknown> {
  const rec = ledger.packages[pkg];
  if (!rec) throw new Error(`미설치 패키지: ${pkg}`);
  const m = loadManifest(rec.path);
  if (!m.scripts) throw new Error(`scripts 미선언 패키지: ${pkg}`);
  const file = path.join(rec.path, m.scripts.source, name + ".ts");
  if (!fs.existsSync(file)) throw new Error(`script 없음: ${name}`);
  const mtime = fs.statSync(file).mtimeMs;
  const mod = await import(pathToFileURL(file).href + "?t=" + mtime);
  if (typeof mod.default !== "function") throw new Error(`script 계약 위반(기본 수출 함수 아님): ${name}`);
  const ctx = makeCtx(ledger, pkg, caller, hostBridge, authority, io, [...chain, pkg]);
  return await mod.default(input ?? {}, ctx);
}

/**
 * 이 세션이 부를 수 있는 동사의 **짧은 이름** — 화면이 원문 슬러그 대신 이것을 그린다.
 *
 * 뜻을 아는 쪽이 기판이라서 여기 산다. 어댑터는 도구 이름만 알고 그것이 무엇을 하는 동사인지
 * 모른다(제 CLI 의 도구가 아니라 우리 문의 도구다). 그래서 화면은 `orders-sync` 를 원문 그대로
 * 그렸는데, 기판은 같은 시각에 tools/list 로 그 서술을 세션에 서고 있었다 — 아는 것을 안 보내고
 * 있던 자리다. 접두가 붙는 문(dir·edge·a2a·mcp)은 이름 자체가 분해되므로 여기 담지 않는다.
 *
 * 턴마다 한 번 짓는다: 봉투 이벤트마다 모듈을 import 하면 표시 하나가 실행 비용을 낳는다.
 */
export async function verbLabels(ledger: Ledger, pkg: string, agent: string): Promise<Record<string, string>> {
  const rec = ledger.packages[pkg];
  if (!rec) return {};
  let m: Manifest;
  try {
    m = loadManifest(rec.path);
  } catch {
    return {};
  }
  const inPlay = [agent, ...((m.agents ?? []).find((a) => a.name === agent)?.dispatch ?? [])];
  const all = listScripts(rec.path, m);
  const names = new Set<string>();
  for (const a of inPlay) {
    const scope = agentScriptScope(m, a);
    if (!scope) continue;
    for (const v of all) if (scope(v)) names.add(v);
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    const meta = await scriptMeta(ledger, pkg, name);
    const short = shortLabel(meta?.description);
    if (short) out[name] = short;
  }
  return out;
}

/** 서술의 첫 마디 — 카드 한 줄에 서는 길이로 자른다. 문장 전체는 대상 자리를 밀어낸다 */
function shortLabel(description?: string): string | null {
  const d = (description ?? "").trim();
  if (!d) return null;
  const head = d.split(/\s+—\s+|\n|(?<=[.。])\s/)[0].trim();
  const one = (head || d).replace(/\s+/g, " ");
  return one.length > 24 ? one.slice(0, 23) + "…" : one;
}

/**
 * 동사 메타 읽기 — 모듈을 import 만 하고 기본 수출은 부르지 않는다. 목록 조회(tools/list)는
 * "무엇을 부를 수 있는가"의 질문이지 실행이 아니다: 목록이 동사 본문을 돌리면 화면 한 번 여는
 * 것이 부수효과를 낳는다. mtime 결은 runScript 와 같다 — 고친 동사의 메타가 다음 조회에 선다.
 * meta 부재·import 실패 = null → 부르는 쪽이 현행 자동 서술로 떨어진다. 못 읽었다고 동사를
 * 목록에서 빼지는 않는다: 파일의 성함은 실행(runScript)이 fail-loud 로 판정하는 축이다.
 */
export async function scriptMeta(ledger: Ledger, pkg: string, name: string): Promise<ScriptMeta | null> {
  const rec = ledger.packages[pkg];
  if (!rec) return null;
  const m = loadManifest(rec.path);
  if (!m.scripts) return null;
  const file = path.join(rec.path, m.scripts.source, name + ".ts");
  if (!fs.existsSync(file)) return null;
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(file).href + "?t=" + fs.statSync(file).mtimeMs);
  } catch {
    return null;
  }
  const raw = mod.meta;
  if (!raw || typeof raw !== "object") return null;
  const meta = raw as Record<string, unknown>;
  // 미지 키는 무시하되 지우지는 않는다 — 무시는 "판정하지 않는다"이지 "없앤다"가 아니다.
  // meta 는 코드지 manifest 라서(선언-실체 판정 대상이 아니라 광고다) 기판이 모르는 키를
  // 임베더의 게이트가 자기 어휘로 읽을 수 있어야 한다. 여기서 걸러 버리면 같은 로더를
  // 재사용하는 위층이 자기 키를 조용히 잃는다 — 이 리포가 싫어하는 바로 그 유실이다.
  const out = { ...meta } as ScriptMeta;
  // 기판이 실제로 읽는 세 키만 형을 좁힌다: 형이 어긋나면 없는 것으로 친다(광고는 판정이 아니다)
  if (typeof meta.description !== "string") delete out.description;
  if (!meta.input || typeof meta.input !== "object") delete out.input;
  if (!meta.output || typeof meta.output !== "object") delete out.output;
  // meta.name 은 통과하되 아무도 읽지 않는다 — 이름의 정본은 파일명 하나다
  return out;
}

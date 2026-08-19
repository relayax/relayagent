import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expandHome, type Grant, type Ledger } from "./state.ts";
import { credKey } from "./vault.ts";
import { serviceAuthHeader } from "./oauth.ts";
import { localAuthority } from "./authority.ts";
import type { Authority } from "./authority-contract.ts";
import { loadManifest, shortName, type Manifest, type ServiceDecl } from "./manifest.ts";

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
  draftWrite(name: string, files?: Record<string, string>, deletes?: string[]): unknown;
  draftDiff(name: string): unknown;
  draftCommit(name: string, message: string): unknown;
  draftValidate(name: string): unknown;
  draftPublish(name: string, opts?: { version?: string }): unknown;
  draftDiscard(name: string): unknown;
  draftList(): unknown;
  /** 봉투 굽기 — 설치본을 선반에 앉힌다. 스토어 등재의 재료가 여기서 나온다 */
  pack(name: string): unknown;
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

export interface ScriptCtx {
  pkg: string;
  caller: CallerIdentity;
  dir(name: string): string;
  service(name: string): { call(tool: string, args: unknown): Promise<unknown>; url: string };
  /** 커넥터 계약(최상위 auth)의 자격 — vault 의 패키지 짧은 이름 슬롯을 요청 시점에 읽는다. 미연결·미선언 = null */
  credential(): string | null;
  dispatch(provider: string, mission: string, payload: string): Promise<string>;
  host?: HostBridge;
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

export function resolveDirService(ledger: Ledger, pkg: string, m: Manifest, name: string): string {
  const svc = (m.services ?? []).find((s) => s.name === name);
  if (!svc || !("dir" in svc) || svc.dir == null) throw new Error(`dir 서비스 아님: ${name}`);
  const bound = ledger.packages[pkg]?.dirBindings?.[name] ?? svc.dir;
  const expanded = expandHome(bound);
  return expanded.startsWith("/") ? expanded : path.join(ledger.packages[pkg].path, expanded);
}

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
  /** runScript 가 authority.credential 로 선발급한 커넥터 자격 — ctx.credential 의 동기 계약(verb-contract) 유지용 */
  connectorCred: string | null,
  io: ServiceIO = localServiceIO,
): ScriptCtx {
  const rec = ledger.packages[pkg];
  const m = loadManifest(rec.path);
  return {
    pkg,
    caller,
    dir: (name) => resolveDirService(ledger, pkg, m, name),
    // 서비스 선언 세 형이 한 접근자를 지난다 — 저작자가 "몸이 url 이냐 source 냐"를 외우지
    // 않아야 자격·신원이 한 문으로 모인다. 형마다 다른 접근자를 두면 그 문을 안 지나는 몸이
    // 생기고, 신원 없이 불리는 비대칭이 바로 거기서 난다.
    service: (name) => {
      const svc = (m.services ?? []).find((s) => s.name === name);
      if (!svc) throw new Error(`미선언 서비스: ${name}`);
      // dir 형은 파일 경로지 MCP 문이 아니다 — 사유를 실어 되돌린다(조용한 해석 금지)
      if ("dir" in svc && svc.dir != null) {
        throw new Error(`dir 서비스는 ctx.service 대상이 아닙니다: ${name} — 경로는 ctx.dir("${name}"), MCP 호출은 url·source 형`);
      }
      // 신원(caller)은 두 형에서 같은 규칙으로 실린다: 원격 몸이 "누구로서"를 모르면
      // 자격 하나로 모든 행을 본다. 자격만 형마다 출처가 다르다 —
      // url 형은 선언된 auth 의 해석(호출 시점 — oauth 번들은 만료 60초 전 자동 회전, oauth.ts),
      // source 형은 문법에 auth 자리가 없어 이음새가 주는 것뿐이다(없으면 없는 대로).
      if ("url" in svc && svc.url != null) {
        const u = svc as Extract<ServiceDecl, { url: string }>;
        return { url: u.url, call: async (tool, args) => mcpCall(u.url, tool, args, await serviceAuthHeader(authority, pkg, name, u.auth), caller) };
      }
      const src = svc as Extract<ServiceDecl, { source: string }>;
      const body = io.body(pkg, name, src.port ?? null);
      if (!body) throw new Error(`몸 주소 없음: ${name} — source 서비스는 port 를 선언해야 기판이 문을 세웁니다`);
      return { url: body.url, call: (tool, args) => mcpCall(body.url, tool, args, body.authorization, caller) };
    },
    // 커넥터 계약 자격 — env 상주 없이 동사 실행 시점에 authority 를 지나 선발급된 값이다.
    // ctx.credential 의 동기 계약(verb-contract)과 권위 이음새의 비동기 계약이 여기서 만난다:
    // 회전·revoke 는 다음 동사 실행부터 선다 (RunnerIO.credential 의 "스폰 전 선발급"과 같은 결)
    credential: () => connectorCred,
    dispatch: (provider, mission, payload) => {
      if (!hostBridge) throw new Error("dispatch 불가: host 브리지 없음");
      return hostBridge.dispatch(provider, mission, payload, pkg);
    },
    host: rec.ring === 0 && hostBridge ? capHost(hostBridge, m.host_methods) : undefined,
  };
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
  // 커넥터 자격 선발급 — ctx.credential 이 동기 계약이라 여기(비동기 문맥)서 이음새를 지난다
  const connectorCred = m.auth && m.auth.kind !== "none" ? await authority.credential(credKey(pkg, shortName(pkg))) : null;
  const ctx = makeCtx(ledger, pkg, caller, hostBridge, authority, connectorCred, io);
  return await mod.default(input ?? {}, ctx);
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

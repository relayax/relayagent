import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expandHome, type Grant, type Ledger } from "./state.ts";
import { vaultGet, credKey } from "./vault.ts";
import { serviceAuthHeader } from "./oauth.ts";
import { loadManifest, shortName, type Manifest, type ServiceDecl } from "./manifest.ts";

export interface HostBridge {
  registry(): unknown;
  install(dir: string, opts?: { ring0?: boolean; workspace?: string }): unknown;
  build(name: string): unknown;
  remove(name: string): unknown;
  grants(): Grant[];
  grant(g: Grant): unknown;
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

export interface ScriptCtx {
  pkg: string;
  caller: { principal: string; agent?: string };
  dir(name: string): string;
  service(name: string): { call(tool: string, args: unknown): Promise<unknown>; url: string };
  /** 커넥터 계약(최상위 auth)의 자격 — vault 의 패키지 짧은 이름 슬롯을 요청 시점에 읽는다. 미연결·미선언 = null */
  credential(): string | null;
  dispatch(provider: string, mission: string, payload: string): Promise<string>;
  host?: HostBridge;
}

export function resolveDirService(ledger: Ledger, pkg: string, m: Manifest, name: string): string {
  const svc = (m.services ?? []).find((s) => s.name === name);
  if (!svc || !("dir" in svc) || svc.dir == null) throw new Error(`dir 서비스 아님: ${name}`);
  const bound = ledger.packages[pkg]?.dirBindings?.[name] ?? svc.dir;
  const expanded = expandHome(bound);
  return expanded.startsWith("/") ? expanded : path.join(ledger.packages[pkg].path, expanded);
}

export async function mcpCall(url: string, tool: string, args: unknown, authHeader?: string): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (authHeader) headers.authorization = authHeader;
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
const hostKey = (method: string): string => "host." + method.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());

function capHost(bridge: HostBridge, declared: string[] | undefined): HostBridge {
  if (!declared || !declared.length) return bridge;
  const allowed = new Set(declared);
  return new Proxy(bridge, {
    get(target, prop) {
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof v !== "function" || typeof prop !== "string") return v;
      if (!allowed.has(hostKey(prop))) {
        return () => {
          throw new Error(`host_methods 미선언 메서드: ${hostKey(prop)}`);
        };
      }
      return (v as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

export function makeCtx(
  ledger: Ledger,
  pkg: string,
  caller: { principal: string; agent?: string },
  hostBridge: HostBridge | null,
): ScriptCtx {
  const rec = ledger.packages[pkg];
  const m = loadManifest(rec.path);
  return {
    pkg,
    caller,
    dir: (name) => resolveDirService(ledger, pkg, m, name),
    service: (name) => {
      const svc = (m.services ?? []).find((s) => s.name === name);
      if (!svc || !("url" in svc) || svc.url == null) throw new Error(`url 서비스 아님: ${name}`);
      const u = svc as Extract<ServiceDecl, { url: string }>;
      // 자격은 호출 시점 해석 — oauth 번들은 만료 60초 전 자동 회전한다(oauth.ts)
      return { url: u.url, call: async (tool, args) => mcpCall(u.url, tool, args, await serviceAuthHeader(pkg, name, u.auth)) };
    },
    // 커넥터 계약 자격은 요청 시점 pull 이다 — env 상주가 없어야 회전·revoke 가 다음 호출부터 즉시 선다
    credential: () => (m.auth && m.auth.kind !== "none" ? vaultGet(credKey(pkg, shortName(pkg))) : null),
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
  caller: { principal: string; agent?: string },
  hostBridge: HostBridge | null,
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
  const ctx = makeCtx(ledger, pkg, caller, hostBridge);
  return await mod.default(input ?? {}, ctx);
}

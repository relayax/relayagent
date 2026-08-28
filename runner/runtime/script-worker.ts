// script-worker.ts — 동사가 도는 자리. 데몬 프로세스가 아니라 패키지마다 하나씩 뜨는 워커 스레드다.
//
// 동사는 저작자의 코드다. 데몬 프로세스 안에서 돌면 그 안의 spawnSync·sleep·긴 계산 하나가 기판
// 전체(콘솔·위젯 SSE·세션 도구 호출·트리거)를 멈춘다 — 실측 2026-08-28: 발행 빌드와 동사 안의
// 동기 자식 프로세스가 데몬을 붙들어 사용자에게 "기판이 주기적으로 재기동된다"로 보였다. 격리하면
// 동사 하나가 붙드는 것은 자기 패키지의 워커뿐이다.
//
// 워커에는 문이 없다. ctx 의 문(service·edge·dispatch·host)은 전부 메시지로 기판(main)에 되돌아가
// 거기서 판정·자격·신원이 붙는다(script-pool.ts). 워커가 아는 것은 이름과 좌표(workspace·dir 경로·
// 서비스 주소)뿐이고 자격은 한 번도 이 스레드에 오지 않는다 — "동사는 자격을 쥐지 않는다"가
// 스레드 경계로 선다. 조직 기판이 동사를 다른 곳에서 돌리려면 이 메시지 계약을 원격으로 잇는다.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { ScriptCtx, ServiceHandle, HostBridge } from "./scripts.ts";
import type { CtxSeed, DoorRequest, ToWorker, ToMain, WireError, WireResponse } from "./script-wire.ts";

if (!parentPort) throw new Error("script-worker 는 워커 스레드로만 뜬다");
const port = parentPort;
const label: string = String(workerData?.root ?? "");

let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** 기판에 문을 두드린다 — 답이 올 때까지 이 동사의 await 만 선다(워커의 다른 동사는 돈다) */
function door(runId: string, req: DoorRequest): Promise<unknown> {
  const rid = `${runId}:${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(rid, { resolve, reject });
    port.postMessage({ t: "door", rid, id: runId, req } satisfies ToMain);
  });
}

function toError(e: WireError): Error {
  const err = new Error(e.message);
  if (e.name) err.name = e.name;
  return err;
}

function wireError(e: unknown): WireError {
  if (e instanceof Error) return { message: e.message, name: e.name === "Error" ? undefined : e.name, stack: e.stack };
  return { message: String(e) };
}

/** fetch 의 init 을 메시지로 — 본문은 문자열·바이트로 나른다. FormData 는 여기서 multipart 로 굽는다 */
async function initToWire(init: RequestInit | undefined): Promise<{ method?: string; headers: [string, string][]; body?: string | Uint8Array }> {
  const headers = [...new Headers(init?.headers ?? {})];
  let body: string | Uint8Array | undefined;
  const b = init?.body;
  if (b == null) body = undefined;
  else if (typeof b === "string") body = b;
  else if (b instanceof URLSearchParams) {
    body = b.toString();
    if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["content-type", "application/x-www-form-urlencoded;charset=UTF-8"]);
  } else if (b instanceof ArrayBuffer) body = new Uint8Array(b);
  else if (ArrayBuffer.isView(b)) body = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  else if (b instanceof Blob) body = new Uint8Array(await b.arrayBuffer());
  else if (b instanceof FormData) {
    // 표준 multipart/form-data — 문자열 칸과 파일 칸(Blob: 파일명·타입 보존). 스레드 경계를 못 넘는 형이라
    // 굽는 자리가 여기뿐이다. Response 로 굽고 boundary 가 든 content-type 을 함께 보낸다
    const baked = new Response(b);
    body = new Uint8Array(await baked.arrayBuffer());
    const ct = baked.headers.get("content-type");
    if (ct) headers.push(["content-type", ct]);
  } else throw new Error("격리 문은 이 본문 형을 나르지 않습니다 — 문자열·바이트·URLSearchParams·Blob·FormData 로 보내세요");
  return { method: init?.method, headers, body };
}

function responseFromWire(w: WireResponse): Response {
  const nobody = w.status === 101 || w.status === 204 || w.status === 205 || w.status === 304;
  // TS 의 BodyInit 은 제네릭 Uint8Array 를 아직 모른다 — 런타임은 바이트를 그대로 받는다
  return new Response(nobody ? null : (w.body as unknown as BodyInit), { status: w.status, statusText: w.statusText, headers: w.headers });
}

/** host 브리지의 거울 — 메서드 경로를 모아 기판으로 보낸다. 캡(host_methods)은 기판이 집행한다 */
function hostMirror(runId: string, path: string[]): HostBridge {
  return new Proxy(function () {} as unknown as HostBridge, {
    get: (_t, prop) => (typeof prop === "string" ? hostMirror(runId, [...path, prop]) : undefined),
    apply: (_t, _this, args) => door(runId, { kind: "host", path, args }),
  });
}

function mirrorCtx(runId: string, seed: CtxSeed): ScriptCtx {
  const service = (name: string, account: string | null = null): ServiceHandle => {
    const s = seed.services[name];
    if (!s) throw new Error(`미선언 서비스: ${name}`);
    if (s.fault) throw new Error(s.fault);
    const at = account ? { account } : {};
    return {
      url: s.url,
      call: (tool, args) => door(runId, { kind: "service.call", name, ...at, tool, args }),
      fetch: async (p, init) => responseFromWire((await door(runId, { kind: "service.fetch", name, ...at, path: p, init: await initToWire(init) })) as WireResponse),
      connected: () => door(runId, { kind: "service.connected", name, ...at }) as Promise<boolean>,
      fields: () => door(runId, { kind: "service.fields", name, ...at }) as Promise<Record<string, string | string[]>>,
      // 계정 축의 유무는 씨앗이 답한다(동기 — 거울이 손잡이를 바로 돌려줘야 한다). 이름 판정과 자격은 문 너머 기판의 몫
      account: (label) => {
        if (!s.accounts) throw new Error(`계정 축이 없는 서비스입니다: ${name} — services[].auth.accounts: true 를 선언해야 계정을 고를 수 있습니다`);
        return service(name, String(label));
      },
      accounts: () => door(runId, { kind: "service.accounts", name }) as Promise<string[]>,
    };
  };
  return {
    pkg: seed.pkg,
    caller: seed.caller,
    workspace: seed.workspace,
    dir: (name) => {
      const p = seed.dirs[name];
      if (!p) throw new Error(`dir 서비스 아님: ${name}`);
      return p;
    },
    service,
    // provider 해석(설치 이름·혈통·버전 꼬리표)은 기판의 판정이다 — 선언된 참조는 씨앗에 미리 풀려 오고,
    // 그 밖의 참조는 부를 때 기판이 E_NO_PROVIDER 로 답한다
    edge: (ref) => ({
      provider: seed.edges[ref] ?? ref,
      call: (verb, args) => door(runId, { kind: "edge.call", ref, verb, args }),
    }),
    dispatch: (provider, mission, payload) => door(runId, { kind: "dispatch", provider, mission, payload }) as Promise<string>,
    host: seed.host ? hostMirror(runId, []) : undefined,
  };
}

async function load(file: string, mtime: number): Promise<Record<string, unknown>> {
  return (await import(pathToFileURL(file).href + "?t=" + mtime)) as Record<string, unknown>;
}

port.on("message", (msg: ToWorker) => {
  if (msg.t === "reply") {
    const p = pending.get(msg.rid);
    if (!p) return;
    pending.delete(msg.rid);
    if (msg.ok) p.resolve(msg.value);
    else p.reject(toError(msg.error));
    return;
  }
  if (msg.t === "meta") {
    void (async () => {
      try {
        const mod = await load(msg.file, msg.mtime);
        const raw = mod.meta;
        port.postMessage({ t: "done", id: msg.id, ok: true, value: raw && typeof raw === "object" ? raw : null } satisfies ToMain);
      } catch (e) {
        port.postMessage({ t: "done", id: msg.id, ok: false, error: wireError(e) } satisfies ToMain);
      }
    })();
    return;
  }
  if (msg.t === "run") {
    void (async () => {
      try {
        const mod = await load(msg.file, msg.mtime);
        if (typeof mod.default !== "function") throw new Error(`script 계약 위반(기본 수출 함수 아님): ${msg.verb}`);
        const value = await (mod.default as (input: unknown, ctx: ScriptCtx) => unknown)(msg.input ?? {}, mirrorCtx(msg.id, msg.seed));
        try {
          port.postMessage({ t: "done", id: msg.id, ok: true, value } satisfies ToMain);
        } catch (e) {
          // 구조 복제가 안 되는 결과(함수·클래스 인스턴스) — 동사 계약은 JSON 직렬화 가능한 값이다
          port.postMessage({ t: "done", id: msg.id, ok: false, error: { message: `동사 결과를 나를 수 없습니다(JSON 직렬화 가능한 값이어야 합니다): ${msg.verb} — ${e instanceof Error ? e.message : String(e)}` } } satisfies ToMain);
        }
      } catch (e) {
        port.postMessage({ t: "done", id: msg.id, ok: false, error: wireError(e) } satisfies ToMain);
      }
    })();
  }
});

port.postMessage({ t: "ready", root: label } satisfies ToMain);

// script-wire.ts — 기판(main)과 동사 워커 사이의 메시지 어휘. 형만 있고 코드는 없다.
// 워커(script-worker.ts)와 풀(script-pool.ts)이 같은 형을 보므로 한 파일에 둔다.
import type { CallerIdentity } from "./scripts.ts";

/** 한 번의 실행에 워커가 받는 좌표 전부 — 자격은 없다(문은 전부 기판으로 되돌아온다) */
export interface CtxSeed {
  pkg: string;
  caller: CallerIdentity;
  workspace: string;
  /** 선언된 dir 서비스 이름 → 절대경로(ctx.dir 의 답. 기판이 풀었다) */
  dirs: Record<string, string>;
  /** 선언된 서비스 이름 → 손잡이가 동기로 알아야 하는 것(url). fault = 손잡이를 만들 때 던질 사유.
   *  accounts = 계정 축(auth.accounts) 선언 여부 — 거울이 account() 를 동기로 판정한다 */
  services: Record<string, { url: string; fault?: string; accounts?: boolean }>;
  /** 선언된 edge 참조 → 설치 이름(기판이 풀었다). 없는 참조는 부를 때 기판이 답한다 */
  edges: Record<string, string>;
  /** ring-0 이고 브리지가 있는가 — 있으면 워커가 host 거울을 세운다 */
  host: boolean;
}

/** account = 계정 축의 좌표(ctx.service(이름).account(계정)) — 없으면 바탕 손잡이 */
export type DoorRequest =
  | { kind: "service.call"; name: string; account?: string; tool: string; args: unknown }
  | { kind: "service.fetch"; name: string; account?: string; path: string; init: { method?: string; headers: [string, string][]; body?: string | Uint8Array } }
  | { kind: "service.connected"; name: string; account?: string }
  | { kind: "service.fields"; name: string; account?: string }
  | { kind: "service.accounts"; name: string }
  | { kind: "edge.call"; ref: string; verb: string; args: unknown }
  | { kind: "dispatch"; provider: string; mission: string; payload: string }
  | { kind: "host"; path: string[]; args: unknown[] };

export interface WireError {
  message: string;
  name?: string;
  stack?: string;
}

export interface WireResponse {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: Uint8Array;
}

export type ToWorker =
  | { t: "run"; id: string; verb: string; file: string; mtime: number; input: unknown; seed: CtxSeed }
  | { t: "meta"; id: string; file: string; mtime: number }
  | { t: "reply"; rid: string; ok: true; value: unknown }
  | { t: "reply"; rid: string; ok: false; error: WireError };

export type ToMain =
  | { t: "ready"; root: string }
  | { t: "done"; id: string; ok: true; value: unknown }
  | { t: "done"; id: string; ok: false; error: WireError }
  | { t: "door"; rid: string; id: string; req: DoorRequest };

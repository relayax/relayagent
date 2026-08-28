// script-pool.ts — 동사 워커의 풀과 문 서빙. 기판(main) 쪽 절반이다(워커 쪽은 script-worker.ts).
//
// 패키지 트리(root)마다 워커 하나가 게으르게 뜬다. 설치본과 작업 사본은 뿌리가 다르므로 워커도
// 다르다(미리보기가 도는 판의 모듈 캐시를 오염시키지 않는다). 워커는 쉬면 unref — 데몬은 서버로만
// 살고, 테스트는 워커 때문에 끝나지 못하는 일이 없다.
//
// 문(door)은 여기서 열린다: 워커가 보낸 요청을 그 실행의 ctx(makeCtx — 판정·자격·신원의 정본)로
// 집행하고 답을 돌려준다. 두 구현이 아니라 한 벌이다 — 워커의 ctx 는 거울이고, 판단은 전부 여기 있다.
//
// 반환 뒤의 문: 동사가 값을 돌려준 뒤에도 백그라운드로 문을 두드릴 수 있다(material-fetch 처럼
// "시작만 알리고 끝맺음은 뒤에서" 하는 동사). 실행 기록은 반환 뒤에도 잠시 산다 — 한 워커에
// 최근 256건·1시간. 그 뒤의 문은 사유를 실어 거절된다(조용히 삼키지 않는다).
import path from "node:path";
import { Worker } from "node:worker_threads";
import { logLine } from "../supply/ledger.ts";
import type { ScriptCtx, HostBridge } from "./scripts.ts";
import type { CtxSeed, DoorRequest, ToMain, ToWorker, WireError, WireResponse } from "./script-wire.ts";

/** 한 실행의 시한 — 넘기면 그 워커를 죽인다(동사가 걸린 채 영원히 사는 것보다 fail-loud 가 낫다) */
function runDeadlineMs(): number {
  const s = Number(process.env.RELAY_SCRIPT_TIMEOUT_S);
  return (s > 0 ? s : 1800) * 1000;
}
const KEEP_RUNS = 256;
const KEEP_RUN_MS = 60 * 60_000;
/** 옛 워커 은퇴 유예 — 반환 뒤 백그라운드로 끝맺는 동사(예: 12분짜리 소재 수집)가 문을 잃지 않게 */
const RETIRE_GRACE_MS = 15 * 60_000;

interface Run {
  ctx: ScriptCtx;
  verb: string;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** 반환 시각 — 반환 뒤의 문이 언제까지 열리는가의 기준 */
  done: number | null;
}

// strip-only 규율: 매개변수 프로퍼티 없음 — 필드는 본문에서 대입한다
class PkgWorker {
  readonly root: string;
  readonly pkg: string;
  readonly worker: Worker;
  readonly runs = new Map<string, Run>();
  readonly metas = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly onGone: () => void;
  private live = 0;
  private seq = 0;
  private dead: Error | null = null;

  /** 은퇴 예약 — 발행·재설치로 뿌리가 바뀐 옛 워커. 조용해지면(진행 중 실행 없음·최근 반환 없음) 내린다 */
  retiring = false;
  lastDone = 0;

  constructor(root: string, pkg: string, onGone: () => void) {
    this.root = root;
    this.pkg = pkg;
    this.onGone = onGone;
    this.worker = new Worker(new URL("./script-worker.ts", import.meta.url), {
      workerData: { root },
      // 형 벗김은 이 플래그로만 켜진다 — 상위 프로세스의 execArgv(--test 등)를 물려받지 않는다
      execArgv: ["--experimental-strip-types", "--no-warnings"],
      name: `verbs:${path.basename(root)}`,
    });
    this.worker.on("message", (m: ToMain) => this.receive(m));
    this.worker.on("error", (e) => this.collapse(e instanceof Error ? e : new Error(String(e))));
    this.worker.on("exit", (code) => this.collapse(new Error(`동사 워커가 내려갔습니다(exit ${code}): ${root}`)));
    this.worker.unref();
  }

  private id(): string {
    return `${++this.seq}`;
  }

  private hold(): void {
    if (this.live++ === 0) this.worker.ref();
  }

  private release(): void {
    if (--this.live === 0) this.worker.unref();
    if (this.retiring) this.retireIfQuiet();
  }

  /** 조용한가 — 진행 중 실행이 없고 마지막 반환 뒤 유예가 지났다. 반환 뒤의 문(백그라운드 마무리)이
   *  끊기지 않도록 유예를 둔다 */
  retireIfQuiet(graceMs = RETIRE_GRACE_MS): boolean {
    if (this.live > 0 || Date.now() - this.lastDone < graceMs) return false;
    this.terminate();
    return true;
  }

  run(verb: string, file: string, mtime: number, input: unknown, ctx: ScriptCtx, seed: CtxSeed): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.id();
    this.sweep();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.collapse(new Error(`동사 시한 초과(${runDeadlineMs() / 60_000}분) — 워커를 죽였습니다: ${seed.pkg}/${verb}`));
      }, runDeadlineMs());
      (timer as { unref?: () => void }).unref?.();
      this.runs.set(id, { ctx, verb, resolve, reject, timer, done: null });
      this.hold();
      this.worker.postMessage({ t: "run", id, verb, file, mtime, input, seed } satisfies ToWorker);
    });
  }

  meta(file: string, mtime: number): Promise<unknown> {
    if (this.dead) return Promise.reject(this.dead);
    const id = `m${this.id()}`;
    return new Promise<unknown>((resolve, reject) => {
      this.metas.set(id, { resolve, reject });
      this.hold();
      this.worker.postMessage({ t: "meta", id, file, mtime } satisfies ToWorker);
    });
  }

  private receive(m: ToMain): void {
    if (m.t === "ready") return;
    if (m.t === "done") {
      const meta = this.metas.get(m.id);
      if (meta) {
        this.metas.delete(m.id);
        this.release();
        if (m.ok) meta.resolve(m.value);
        else meta.reject(toError(m.error));
        return;
      }
      const run = this.runs.get(m.id);
      if (!run || run.done != null) return;
      if (run.timer) clearTimeout(run.timer);
      run.done = Date.now();
      this.lastDone = run.done;
      this.release();
      if (m.ok) run.resolve(m.value);
      else run.reject(toError(m.error));
      return;
    }
    if (m.t === "door") {
      const run = this.runs.get(m.id);
      void this.serve(run, m.req).then(
        (value) => this.worker.postMessage({ t: "reply", rid: m.rid, ok: true, value } satisfies ToWorker),
        (e) => this.worker.postMessage({ t: "reply", rid: m.rid, ok: false, error: wireError(e) } satisfies ToWorker),
      );
    }
  }

  /** 문 하나의 집행 — 이 실행의 ctx(기판의 판정·자격·신원)로. 워커에는 판단이 없다 */
  private async serve(run: Run | undefined, req: DoorRequest): Promise<unknown> {
    if (!run) throw new Error("동사 실행 기록이 만료됐습니다 — 반환 뒤 1시간·최근 256건까지만 문이 열립니다");
    const ctx = run.ctx;
    // 계정 축 — 거울이 고른 계정을 여기서 기판의 손잡이로 다시 고른다(이름 판정은 account() 안에서 fail-loud)
    const svc = (name: string, account?: string) => (account ? ctx.service(name).account(account) : ctx.service(name));
    switch (req.kind) {
      case "service.call":
        return await svc(req.name, req.account).call(req.tool, req.args);
      case "service.connected":
        return await svc(req.name, req.account).connected();
      case "service.fields":
        return await svc(req.name, req.account).fields();
      case "service.accounts":
        return await ctx.service(req.name).accounts();
      case "service.fetch": {
        const res = await svc(req.name, req.account).fetch(req.path, {
          ...(req.init.method ? { method: req.init.method } : {}),
          headers: req.init.headers,
          ...(req.init.body != null ? { body: req.init.body as unknown as BodyInit } : {}),
        });
        const body = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, statusText: res.statusText, headers: [...res.headers], body } satisfies WireResponse;
      }
      case "edge.call":
        return await ctx.edge(req.ref).call(req.verb, req.args);
      case "dispatch":
        return await ctx.dispatch(req.provider, req.mission, req.payload);
      case "host": {
        if (!ctx.host) throw new Error("host 브리지 없음 — ring-0 설치가 아니거나 미리보기 실행입니다");
        let node: unknown = ctx.host;
        for (const k of req.path.slice(0, -1)) node = (node as Record<string, unknown>)[k];
        const last = req.path[req.path.length - 1];
        const fn = (node as Record<string, unknown> | undefined)?.[last];
        if (typeof fn !== "function") throw new Error(`host 메서드 아님: host.${req.path.join(".")}`);
        return await (fn as (...a: unknown[]) => unknown).apply(node, req.args);
      }
    }
  }

  /** 끝난 실행 기록을 걷는다 — 반환 뒤의 문을 위해 잠시 두되 무한히 쌓지 않는다 */
  private sweep(): void {
    const now = Date.now();
    const done = [...this.runs.entries()].filter(([, r]) => r.done != null);
    for (const [id, r] of done) if (now - (r.done as number) > KEEP_RUN_MS) this.runs.delete(id);
    const still = done.filter(([id]) => this.runs.has(id));
    for (const [id] of still.slice(0, Math.max(0, still.length - KEEP_RUNS))) this.runs.delete(id);
  }

  /** 워커가 죽었다(예외·exit·시한) — 진행 중인 실행 전부를 사유와 함께 거절하고 풀에서 빠진다 */
  private collapse(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    for (const [id, r] of this.runs) {
      if (r.done == null) {
        if (r.timer) clearTimeout(r.timer);
        r.reject(e);
      }
      this.runs.delete(id);
    }
    for (const [id, m] of this.metas) {
      m.reject(e);
      this.metas.delete(id);
    }
    this.live = 0;
    this.onGone();
    logLine("scripts", { root: this.root, gone: e.message });
    void this.worker.terminate().catch(() => undefined);
  }

  terminate(): void {
    this.collapse(new Error(`동사 워커 은퇴: ${this.root}`));
  }
}

function toError(e: WireError): Error {
  const err = new Error(e.message);
  if (e.name) err.name = e.name;
  return err;
}

function wireError(e: unknown): WireError {
  if (e instanceof Error) return { message: e.message, name: e.name === "Error" ? undefined : e.name };
  return { message: String(e) };
}

const pool = new Map<string, PkgWorker>();

function workerFor(root: string, pkg: string): PkgWorker {
  let w = pool.get(root);
  if (!w || w.retiring) {
    // 은퇴 예약된 워커는 새 실행을 받지 않는다 — 같은 뿌리로 다시 오면(롤백) 새 워커가 선다
    if (w) pool.delete(root);
    const fresh = new PkgWorker(root, pkg, () => {
      if (pool.get(root) === fresh) pool.delete(root);
    });
    pool.set(root, fresh);
    w = fresh;
  }
  return w;
}

/** 동사 하나를 그 트리의 워커에서 돌린다. 문은 ctx 로 되돌아온다 */
export function runInWorker(root: string, pkg: string, verb: string, file: string, mtime: number, input: unknown, ctx: ScriptCtx, seed: CtxSeed): Promise<unknown> {
  return workerFor(root, pkg).run(verb, file, mtime, input, ctx, seed);
}

/** 동사 모듈의 meta 수출을 워커가 읽는다 — 모듈 최상위가 데몬에서 도는 일이 없도록 */
export function metaInWorker(root: string, file: string, mtime: number): Promise<unknown> {
  return workerFor(root, path.basename(root)).meta(file, mtime);
}

/**
 * 한 패키지의 워커들을 은퇴시킨다 — 발행·재설치·롤백으로 뿌리가 바뀐 뒤(상주 은퇴 retireResidents 와
 * 같은 자리). 당장 죽이지 않는다: 반환 뒤 백그라운드로 끝맺는 동사가 문을 잃지 않도록 조용해질 때까지
 * 유예하고(15분), 그래도 살아 있으면 1시간 뒤 내린다. 은퇴 예약된 워커는 새 실행을 받지 않는다
 */
export function retireScriptWorkers(pkg: string): number {
  let n = 0;
  for (const w of [...pool.values()]) {
    if (w.pkg !== pkg || w.retiring) continue;
    w.retiring = true;
    n++;
    if (w.retireIfQuiet()) continue;
    const poll = setInterval(() => {
      if (w.retireIfQuiet()) clearInterval(poll);
    }, 60_000);
    (poll as { unref?: () => void }).unref?.();
    const cap = setTimeout(() => {
      clearInterval(poll);
      w.terminate();
    }, KEEP_RUN_MS);
    (cap as { unref?: () => void }).unref?.();
  }
  return n;
}

/** 전부 내린다 — 데몬 종료 */
export function retireAllScriptWorkers(): void {
  for (const w of [...pool.values()]) w.terminate();
}

export type { HostBridge };

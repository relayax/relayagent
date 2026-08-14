import fs from "node:fs";
import path from "node:path";
import { RELAY_HOME, logLine, type Ledger } from "./state.ts";
import { loadManifest, type Manifest, type TriggerDecl } from "./manifest.ts";
import { postToChannel } from "./run.ts";
import { runSession } from "./session.ts";
import { runScript, type HostBridge } from "./scripts.ts";
import { PRINCIPAL } from "./state.ts";

function fieldMatch(expr: string, value: number): boolean {
  return expr.split(",").some((part) => {
    if (part === "*") return true;
    const step = part.match(/^\*\/(\d+)$/);
    if (step) return value % Number(step[1]) === 0;
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) return value >= Number(range[1]) && value <= Number(range[2]);
    return Number(part) === value;
  });
}

export function cronMatch(expr: string, d: Date, tz?: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const local = tz ? new Date(d.toLocaleString("en-US", { timeZone: tz })) : d;
  const [min, hour, dom, mon, dow] = parts;
  return (
    fieldMatch(min, local.getMinutes()) &&
    fieldMatch(hour, local.getHours()) &&
    fieldMatch(dom, local.getDate()) &&
    fieldMatch(mon, local.getMonth() + 1) &&
    fieldMatch(dow, local.getDay())
  );
}

export class Ticker {
  private fired = new Map<string, string>();
  private debouncing = new Map<string, ReturnType<typeof setTimeout>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private getLedger: () => Ledger;
  private hostBridge: HostBridge;
  // 발화 장부의 디스크 사본 — 같은 분(minute) 안의 데몬 재시작이 이중 발화하지 않고,
  // 데몬이 꺼져 있던 동안의 미발화(misfire)가 침묵하지 않게 한다. 트리거가 안 울리는 것은
  // 에러를 내지 않는 실패라 장부 없이는 아무도 모른다.
  private stateFile = path.join(RELAY_HOME, "triggers.json");

  constructor(getLedger: () => Ledger, hostBridge: HostBridge) {
    this.getLedger = getLedger;
    this.hostBridge = hostBridge;
  }

  start(): void {
    this.recover();
    this.timer = setInterval(() => this.sweep(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const [, t] of this.debouncing) clearTimeout(t);
  }

  private loadState(): { fired: Record<string, string>; last_sweep?: string } {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
    } catch {
      return { fired: {} };
    }
  }

  private saveState(now: Date): void {
    try {
      fs.writeFileSync(this.stateFile, JSON.stringify({ fired: Object.fromEntries(this.fired), last_sweep: now.toISOString() }));
    } catch (e) {
      logLine("triggers", { error: `발화 장부 저장 실패: ${e}` });
    }
  }

  /** 부팅 복구 — 발화 장부 복원 + 꺼져 있던 동안의 cron 미발화를 기록한다(따라잡기 실행은
   *  하지 않는다: 몰아치는 지각 발화는 놀람이다 — 유실을 침묵시키지 않는 것까지가 기판 몫). */
  private recover(): void {
    const s = this.loadState();
    for (const [k, v] of Object.entries(s.fired ?? {})) this.fired.set(k, v);
    if (!s.last_sweep) return;
    const from = new Date(s.last_sweep);
    const now = new Date();
    // 분 단위 스캔 — 상한 3일(그 이상 꺼져 있던 기판의 미발화 전수는 의미가 없다)
    const MAX_MIN = 3 * 24 * 60;
    const gapMin = Math.floor((now.getTime() - from.getTime()) / 60_000);
    if (gapMin <= 1) return;
    const ledger = this.getLedger();
    for (const [pkg, rec] of Object.entries(ledger.packages)) {
      let m: Manifest;
      try {
        m = loadManifest(rec.path);
      } catch {
        continue;
      }
      for (const t of m.triggers ?? []) {
        if (!t.when.cron) continue;
        let missed = 0;
        for (let i = 1; i <= Math.min(gapMin, MAX_MIN); i++) {
          const d = new Date(from.getTime() + i * 60_000);
          if (cronMatch(t.when.cron, d, t.when.tz) && this.fired.get(`${pkg}/${t.id}`) !== d.toISOString().slice(0, 16)) missed++;
        }
        if (missed > 0) {
          logLine("triggers", { pkg, trigger: t.id, missed, note: `데몬 미기동 구간(${s.last_sweep} ~) 미발화 — 따라잡기 실행 없음` });
        }
      }
    }
  }

  private sweep(): void {
    const now = new Date();
    const ledger = this.getLedger();
    for (const [pkg, rec] of Object.entries(ledger.packages)) {
      let m: Manifest;
      try {
        m = loadManifest(rec.path);
      } catch {
        continue;
      }
      for (const t of m.triggers ?? []) {
        if (!t.when.cron) continue;
        const minuteKey = now.toISOString().slice(0, 16);
        const fireKey = `${pkg}/${t.id}`;
        if (this.fired.get(fireKey) === minuteKey) continue;
        if (!cronMatch(t.when.cron, now, t.when.tz)) continue;
        this.fired.set(fireKey, minuteKey);
        this.fire(pkg, t);
      }
    }
    this.saveState(now);
  }

  emit(event: string, payload: Record<string, unknown> = {}): void {
    const ledger = this.getLedger();
    for (const [pkg, rec] of Object.entries(ledger.packages)) {
      let m: Manifest;
      try {
        m = loadManifest(rec.path);
      } catch {
        continue;
      }
      for (const t of m.triggers ?? []) {
        if (t.when.event !== event) continue;
        const filter = t.when.filter ?? {};
        if (!Object.entries(filter).every(([k, v]) => payload[k] === v)) continue;
        const key = `${pkg}/${t.id}`;
        const delay = t.when.debounce_ms ?? 0;
        const prev = this.debouncing.get(key);
        if (prev) clearTimeout(prev);
        this.debouncing.set(
          key,
          setTimeout(() => {
            this.debouncing.delete(key);
            this.fire(pkg, t);
          }, delay),
        );
      }
    }
  }

  private fire(pkg: string, t: TriggerDecl): void {
    logLine("triggers", { pkg, trigger: t.id });
    const ledger = this.getLedger();
    if (t.then.script) {
      runScript(ledger, pkg, t.then.script, { trigger: t.id }, { principal: PRINCIPAL }, this.hostBridge).catch((e) =>
        logLine("triggers", { pkg, trigger: t.id, error: String(e) }),
      );
      return;
    }
    if (t.then.agent && t.then.prompt) {
      // delivery = 선톡 좌표 '<채널>:<대화키>'. 그 대화의 slot 에서 턴을 돌려야 사용자의
      // 후속 발화가 같은 slot 에 착신되어 대화가 이어진다 (채널 계약 '발신' 절)
      const dm = t.then.delivery ? /^([a-z0-9][a-z0-9-]{0,39}):(.+)$/.exec(t.then.delivery) : null;
      const slot = dm ? `${dm[1]}-${dm[2]}`.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 64) : `trigger-${t.id}`;
      runSession({ ledger, pkg, agent: t.then.agent, prompt: t.then.prompt, slot })
        .then((r) => {
          if (!dm) return;
          if (!postToChannel(pkg, dm[1], { conversation: dm[2], text: r.reply, files: r.files?.map((f) => f.path) })) {
            logLine("triggers", { pkg, trigger: t.id, error: `발신 실패 — 채널 미기동: ${dm[1]}` });
          }
        })
        .catch((e) => logLine("triggers", { pkg, trigger: t.id, error: String(e) }));
    }
  }
}

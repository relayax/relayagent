import { logLine, type Ledger } from "./state.ts";
import { loadManifest, type Manifest, type TriggerDecl } from "./manifest.ts";
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

  constructor(getLedger: () => Ledger, hostBridge: HostBridge) {
    this.getLedger = getLedger;
    this.hostBridge = hostBridge;
  }

  start(): void {
    this.timer = setInterval(() => this.sweep(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    for (const [, t] of this.debouncing) clearTimeout(t);
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
      runSession({ ledger, pkg, agent: t.then.agent, prompt: t.then.prompt, slot: `trigger-${t.id}` }).catch((e) =>
        logLine("triggers", { pkg, trigger: t.id, error: String(e) }),
      );
    }
  }
}

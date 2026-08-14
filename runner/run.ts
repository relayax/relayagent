import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { API_PORT, API_URL, expandHome, logLine, pkgToken, type Ledger } from "./state.ts";
import { vaultGet, credKey } from "./vault.ts";
import type { Manifest, ServiceDecl } from "./manifest.ts";

const children = new Map<string, ChildProcess>();

function baseEnv(l: Ledger, pkg: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    RELAY_NAME: pkg,
    RELAY_API: API_URL,
    RELAY_TOKEN: pkgToken(l, pkg),
  };
}

function dockerAvailable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

export function startServices(l: Ledger, pkg: string, pkgPath: string, m: Manifest): string[] {
  const notes: string[] = [];
  for (const s of m.services ?? []) {
    if ("dir" in s && s.dir != null) {
      const target = l.packages[pkg]?.dirBindings?.[s.name] ?? s.dir;
      fs.mkdirSync(expandHome(target).startsWith("/") ? expandHome(target) : path.join(pkgPath, target), { recursive: true });
      continue;
    }
    if ("url" in s && s.url != null) continue;
    if (!("source" in s) || s.source == null) continue;
    notes.push(startSourceService(l, pkg, pkgPath, s));
  }
  return notes.filter(Boolean);
}

function startSourceService(
  l: Ledger,
  pkg: string,
  pkgPath: string,
  s: Extract<ServiceDecl, { source: string }>,
): string {
  const key = `${pkg}/${s.name}`;
  if (children.has(key)) return "";
  const env = baseEnv(l, pkg);
  if (s.port) env.PORT = String(s.port);
  const authEnv = serviceAuthEnv(pkg, s.name);
  Object.assign(env, authEnv);

  if (s.entry) {
    const entry = path.join(pkgPath, s.source, s.entry);
    const child = spawn("node", ["--experimental-strip-types", entry], {
      cwd: path.join(pkgPath, s.source),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => logLine("services", { pkg, service: s.name, out: String(d).trim() }));
    child.stderr?.on("data", (d) => logLine("services", { pkg, service: s.name, err: String(d).trim() }));
    child.on("exit", (code) => {
      children.delete(key);
      logLine("services", { pkg, service: s.name, exit: code });
    });
    children.set(key, child);
    return `${key}: 프로세스 기동 (pid ${child.pid})`;
  }

  if (s.dockerfile) {
    if (!dockerAvailable()) return `${key}: docker 미가용 — 컨테이너 서비스 건너뜀`;
    const tag = `relay/${pkg}-${s.name}`.toLowerCase();
    const ctx = path.join(pkgPath, s.source);
    const build = spawnSync("docker", ["build", "-t", tag, "-f", path.join(ctx, s.dockerfile), ctx], { encoding: "utf8" });
    if (build.status !== 0) return `${key}: docker build 실패 — ${build.stderr?.slice(-300)}`;
    const name = `relay-${pkg}-${s.name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    spawnSync("docker", ["rm", "-f", name], { stdio: "ignore" });
    const args = ["run", "-d", "--name", name];
    if (s.port) args.push("-p", `${s.port}:${s.port}`);
    for (const [k, v] of Object.entries({ RELAY_NAME: pkg, RELAY_API: `http://host.docker.internal:${API_PORT}`, RELAY_TOKEN: pkgToken(l, pkg), ...serviceAuthEnv(pkg, s.name) })) {
      args.push("-e", `${k}=${v}`);
    }
    if (s.disk) {
      const vol = `relay-${pkg}-${s.name}-data`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      args.push("-v", `${vol}:/data`);
    }
    args.push(tag);
    const run = spawnSync("docker", args, { encoding: "utf8" });
    if (run.status !== 0) return `${key}: docker run 실패 — ${run.stderr?.slice(-300)}`;
    return `${key}: 컨테이너 기동 (${name})`;
  }
  return "";
}

// 채널 어댑터(surfaces.channels) — 외부 대화 표면을 잇는 상주 글루. 서비스와 같은
// children 테이블에 앉으므로 stopServices/stopAll/runningServices 가 함께 덮는다.
// 자격도 서비스와 같은 이름공간(credKey)을 공유한다 — 이름 충돌은 판정이 막는다.
// 재접속·게이트·직렬화는 어댑터 소유(relay.manifest.yaml surfaces.channels 계약),
// 기판은 스폰과 기록만 한다. 종료를 되살리지 않는 것도 계약이다: 프로세스 종료 = 실패.
export function startChannels(l: Ledger, pkg: string, pkgPath: string, m: Manifest): string[] {
  const notes: string[] = [];
  for (const c of m.surfaces?.channels ?? []) {
    const key = `${pkg}/${c.name}`;
    if (children.has(key)) continue;
    const env = baseEnv(l, pkg);
    env.RELAY_CHANNEL = c.name;
    Object.assign(env, serviceAuthEnv(pkg, c.name));
    const entry = path.join(pkgPath, c.source, c.entry);
    // stdin 은 기판의 발신 제어 채널이다 (계약 '발신' 절) — 트리거 선톡(then.delivery)이 이 길로 온다
    const child = spawn("node", ["--experimental-strip-types", entry], {
      cwd: path.join(pkgPath, c.source),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => logLine("channels", { pkg, channel: c.name, out: String(d).trim() }));
    child.stderr?.on("data", (d) => logLine("channels", { pkg, channel: c.name, err: String(d).trim() }));
    child.on("exit", (code) => {
      children.delete(key);
      logLine("channels", { pkg, channel: c.name, exit: code });
    });
    children.set(key, child);
    notes.push(`${key}: 채널 어댑터 기동 (pid ${child.pid})`);
  }
  return notes;
}

/** 발신 — 어댑터 stdin 에 줄 단위 JSON post 를 쓴다. 채널이 안 떠 있으면 false: 부르는 쪽이 로그로 남긴다 */
export function postToChannel(pkg: string, channel: string, msg: { conversation: string; text: string; files?: string[] }): boolean {
  const child = children.get(`${pkg}/${channel}`);
  if (!child?.stdin?.writable) return false;
  child.stdin.write(JSON.stringify({ type: "post", ...msg }) + "\n");
  return true;
}

function serviceAuthEnv(pkg: string, service: string): Record<string, string> {
  const out: Record<string, string> = {};
  const cred = vaultGet(credKey(pkg, service));
  if (cred) out[`RELAY_CRED_${service.toUpperCase().replace(/-/g, "_")}`] = cred;
  return out;
}

export function stopAll(): void {
  for (const [, child] of children) child.kill();
  children.clear();
}

// 재발행·롤백의 서비스 갈아타기용. 프로세스 형만 여기서 죽는다 — 컨테이너 형은 children 에
// 없고 startSourceService 가 docker rm -f 로 매번 갈아 끼우므로 start 재호출이 곧 재기동이다
export function stopServices(pkg: string): void {
  for (const [key, child] of children) {
    if (key.startsWith(pkg + "/")) {
      child.kill();
      children.delete(key);
    }
  }
}

export function runningServices(): string[] {
  return [...children.keys()];
}

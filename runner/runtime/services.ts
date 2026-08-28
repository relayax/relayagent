import { runCommand } from "../spawn.ts";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { API_URL, expandHome, type Ledger } from "../supply/ledger.ts";
import { vaultGet, credKey } from "../vault.ts";
import { localAuthority } from "../authority.ts";
import type { Manifest, ServiceDecl } from "../supply/manifest.ts";

const children = new Map<string, ChildProcess>();

// 실행 이음새 — 스폰의 권위·환경 반쪽을 모듈 좌표(./state.ts·./vault.ts)가 아니라 인자로
// 받는 주입점. 권위 이음새(authority-contract.ts)의 실행측 자매다: 저 계약이 "누구로서,
// 무엇을, 어떤 자격으로"에 답한다면, 이 이음새는 그 답을 스폰 자식의 env 로 나르는 손이다.
// 1인 기판은 localIO(장부·vault·홈 로그)가 기본값으로 꽂히고, 임베더(조직 기판)는 같은 형의
// 자기 구현을 넘긴다 — 소스 패치·번들 좌표 치환 없이. 익명의 제3자 임베더 테스트: 이 형은
// 특정 조직 기판을 모른다. 토큰이 문자열 하나, 자격이 (스코프→값), 로그가 (스트림, 한 줄)
// 인 것 — 어느 답도 밖의 형상을 요구하지 않는다.
export interface RunnerIO {
  /** 실행 단위(패키지)의 신원 토큰 — 자식 env RELAY_TOKEN */
  token(pkg: string): string;
  /** 스코프 좌표(credKey 형상 `<pkg>/<이름>`)의 자격 값. 없으면 null. 동기 계약 —
   *  원격 권위(자격이 네트워크 왕복)는 스폰 전 선발급을 임베더가 소유한다 */
  credential(scope: string): string | null;
  /** 실행 기록 한 줄 — stream 은 장부 축(services|channels) */
  log(stream: string, data: unknown): void;
  /** 자식이 보는 기판 문 주소 — 자식 env RELAY_API */
  apiUrl: string;
}

/** 1인 기판의 기본 이음새 — 장부 HMAC 토큰·vault·RELAY_HOME 파일 로그.
 *  신원·감사는 권위 이음새(localAuthority)를 지난다 */
export function localIO(l: Ledger): RunnerIO {
  const authority = localAuthority(() => l);
  return {
    token: (pkg) => authority.packageToken(pkg),
    // §8-2 잔여: RunnerIO.credential 은 동기 계약(원격 권위는 스폰 전 선발급을 임베더가 소유)이라
    // 비동기 authority.credential 로 감쌀 수 없다 — 로컬 기본값은 vault 직독으로 남는다
    credential: vaultGet,
    // 소비 계열 감사 — 스폰 콜백(동기 문맥)의 기록이라 fire-and-forget. 실패는 미처리 거부로
    // 표면화된다(조용히 삼키지 않는다)
    log: (stream, data) => void authority.audit(stream, data as Record<string, unknown>),
    apiUrl: API_URL,
  };
}

function baseEnv(io: RunnerIO, pkg: string): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    RELAY_NAME: pkg,
    RELAY_API: io.apiUrl,
    RELAY_TOKEN: io.token(pkg),
  };
}

/** 컨테이너 자식의 기판 문 주소 — loopback 좌표만 host.docker.internal 로 번역한다. */
function containerApiUrl(io: RunnerIO): string {
  try {
    const u = new URL(io.apiUrl);
    if (u.hostname === "127.0.0.1" || u.hostname === "localhost") u.hostname = "host.docker.internal";
    return u.origin;
  } catch {
    return io.apiUrl;
  }
}

async function dockerAvailable(): Promise<boolean> {
  return (await runCommand("docker", ["info"], { timeout: 30_000 })).status === 0;
}

/** 컨테이너 몸의 build·run 이 비동기라 Promise 다 — 발행·설치·기동이 그 시간만큼 데몬을 붙들던 자리 */
export async function startServices(l: Ledger, pkg: string, pkgPath: string, m: Manifest, io: RunnerIO = localIO(l)): Promise<string[]> {
  const notes: string[] = [];
  for (const s of m.services ?? []) {
    if ("dir" in s && s.dir != null) {
      const target = l.packages[pkg]?.dirBindings?.[s.name] ?? s.dir;
      fs.mkdirSync(expandHome(target).startsWith("/") ? expandHome(target) : path.join(pkgPath, target), { recursive: true });
      continue;
    }
    if ("url" in s && s.url != null) continue;
    if (!("source" in s) || s.source == null) continue;
    notes.push(await startSourceService(io, pkg, pkgPath, s));
  }
  return notes.filter(Boolean);
}

async function startSourceService(
  io: RunnerIO,
  pkg: string,
  pkgPath: string,
  s: Extract<ServiceDecl, { source: string }>,
): Promise<string> {
  const key = `${pkg}/${s.name}`;
  if (children.has(key)) return "";
  const env = baseEnv(io, pkg);
  if (s.port) env.PORT = String(s.port);
  const authEnv = serviceAuthEnv(io, pkg, s.name);
  Object.assign(env, authEnv);

  if (s.entry) {
    const entry = path.join(pkgPath, s.source, s.entry);
    const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
      cwd: path.join(pkgPath, s.source),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => io.log("services", { pkg, service: s.name, out: String(d).trim() }));
    child.stderr?.on("data", (d) => io.log("services", { pkg, service: s.name, err: String(d).trim() }));
    child.on("exit", (code) => {
      children.delete(key);
      io.log("services", { pkg, service: s.name, exit: code });
    });
    children.set(key, child);
    return `${key}: 프로세스 기동 (pid ${child.pid})`;
  }

  if (s.dockerfile) {
    if (!(await dockerAvailable())) return `${key}: docker 미가용 — 컨테이너 서비스 건너뜀`;
    const tag = `relay/${pkg}-${s.name}`.toLowerCase();
    const ctx = path.join(pkgPath, s.source);
    const build = await runCommand("docker", ["build", "-t", tag, "-f", path.join(ctx, s.dockerfile), ctx], { timeout: 30 * 60_000 });
    if (build.status !== 0) return `${key}: docker build 실패 — ${build.stderr.slice(-300)}`;
    const name = `relay-${pkg}-${s.name}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    await runCommand("docker", ["rm", "-f", name], { timeout: 60_000 });
    const args = ["run", "-d", "--name", name];
    if (s.port) args.push("-p", `${s.port}:${s.port}`);
    // resources 집행 — 선언이 판정만 되고 조용히 무시되면 "같은 문법 다른 뜻"이 된다.
    // manifest 표기(Mi/Gi)를 docker 표기(m/g)로 번역한다
    if (s.resources?.memory) args.push("--memory", s.resources.memory.replace(/Mi$/, "m").replace(/Gi$/, "g"));
    if (s.resources?.cpu) args.push("--cpus", String(s.resources.cpu));
    for (const [k, v] of Object.entries({ RELAY_NAME: pkg, RELAY_API: containerApiUrl(io), RELAY_TOKEN: io.token(pkg), ...serviceAuthEnv(io, pkg, s.name) })) {
      args.push("-e", `${k}=${v}`);
    }
    if (s.disk) {
      const vol = `relay-${pkg}-${s.name}-data`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      args.push("-v", `${vol}:/data`);
    }
    args.push(tag);
    const run = await runCommand("docker", args, { timeout: 5 * 60_000 });
    if (run.status !== 0) return `${key}: docker run 실패 — ${run.stderr.slice(-300)}`;
    return `${key}: 컨테이너 기동 (${name})`;
  }
  return "";
}

// 채널 어댑터(surfaces.channels) — 외부 대화 표면을 잇는 상주 글루. 서비스와 같은
// children 테이블에 앉으므로 stopServices/stopAll/runningServices 가 함께 덮는다.
// 자격도 서비스와 같은 이름공간(credKey)을 공유한다 — 이름 충돌은 판정이 막는다.
// 재접속·게이트·직렬화는 어댑터 소유(relay.manifest.yaml surfaces.channels 계약),
// 기판은 스폰과 기록만 한다. 종료를 되살리지 않는 것도 계약이다: 프로세스 종료 = 실패.
export function startChannels(l: Ledger, pkg: string, pkgPath: string, m: Manifest, io: RunnerIO = localIO(l)): string[] {
  const notes: string[] = [];
  for (const c of m.surfaces?.channels ?? []) {
    const note = startOneChannel(pkg, pkgPath, c, io);
    if (note) notes.push(note);
  }
  return notes;
}

/** 채널 어댑터 하나를 스폰한다. 이미 떠 있으면 빈 문자열(중복 스폰 금지). GUI 의 채널 단위
 *  재기동(stopChannel 뒤 이 함수)과 startChannels 의 루프가 같은 스폰을 공유한다. */
export function startOneChannel(
  pkg: string,
  pkgPath: string,
  c: { name: string; source: string; entry: string },
  io: RunnerIO,
): string {
  const key = `${pkg}/${c.name}`;
  if (children.has(key)) return "";
  const env = baseEnv(io, pkg);
  env.RELAY_CHANNEL = c.name;
  Object.assign(env, serviceAuthEnv(io, pkg, c.name));
  const entry = path.join(pkgPath, c.source, c.entry);
  // stdin 은 기판의 발신 제어 채널이다 (계약 '발신' 절) — 트리거 선톡(then.delivery)이 이 길로 온다.
  // 실행기는 PATH 의 node 가 아니라 데몬 자신이다(process.execPath) — conform.ts 의 검사 스폰과
  // 같은 실행기여야 게이트를 지난 어댑터가 런타임에 문법으로 죽지 않는다
  const child = spawn(process.execPath, ["--experimental-strip-types", entry], {
    cwd: path.join(pkgPath, c.source),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => io.log("channels", { pkg, channel: c.name, out: String(d).trim() }));
  child.stderr?.on("data", (d) => io.log("channels", { pkg, channel: c.name, err: String(d).trim() }));
  child.on("exit", (code) => {
    // 정체 가드 — 재기동(stop→start)이 겹치면 죽는 옛 프로세스의 exit 이 새 child 를
    // 맵에서 지울 수 있다. 지금 맵이 가리키는 게 나일 때만 지운다 (session.ts residents 관용구)
    if (children.get(key) === child) children.delete(key);
    io.log("channels", { pkg, channel: c.name, exit: code });
  });
  children.set(key, child);
  return `${key}: 채널 어댑터 기동 (pid ${child.pid})`;
}

/** 채널 하나만 죽인다 (GUI 재기동·자격 교체의 앞단). 프로세스 형만 — 채널은 컨테이너가 없다 */
export function stopChannel(pkg: string, channel: string): void {
  const key = `${pkg}/${channel}`;
  const child = children.get(key);
  if (child) {
    child.kill();
    children.delete(key);
  }
}

/** 상주 pid — 떠 있으면 pid, 아니면 null. GUI 상태 표시의 running 근거 */
export function channelPid(pkg: string, channel: string): number | null {
  return children.get(`${pkg}/${channel}`)?.pid ?? null;
}

/** 발신 — 어댑터 stdin 에 줄 단위 JSON post 를 쓴다. 채널이 안 떠 있으면 false: 부르는 쪽이 로그로 남긴다 */
export function postToChannel(pkg: string, channel: string, msg: { conversation: string; text: string; files?: string[] }): boolean {
  const child = children.get(`${pkg}/${channel}`);
  if (!child?.stdin?.writable) return false;
  child.stdin.write(JSON.stringify({ type: "post", ...msg }) + "\n");
  return true;
}

function serviceAuthEnv(io: RunnerIO, pkg: string, service: string): Record<string, string> {
  const out: Record<string, string> = {};
  const cred = io.credential(credKey(pkg, service));
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

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { spawnEntrySync } from "./entry.ts";
import { loadManifest, type HarnessVariant } from "./manifest.ts";
import type { Ledger } from "./state.ts";

export interface ConformResult {
  variant: string;
  ok: boolean;
  checks: { verb: string; ok: boolean; note: string }[];
}

const REQUIRED_VERBS = ["session", "setup", "models", "commands", "info"];
const KNOWN_CAPS = new Set(["cancel", "vision", "effort", "resume", "ask", "tasks"]);

/**
 * 하네스 계약 적합성 판정 — 어댑터가 동사 프로토콜을 지키는지 기계로 검사한다.
 * setup 은 실패해도(도구 미설치) 계약 위반이 아니다: 실패 시 사유를 내는지만 본다.
 * 세션 봉투 자체는 LLM 자격이 필요해 여기서 돌리지 않는다 — 조건부 검사는 추후 세션 스모크가 맡는다.
 */
export function conformHarness(pkgPath: string, v: HarnessVariant): ConformResult {
  // cwd 를 임시 무대로 옮기므로 entry 는 절대경로여야 한다
  const entry = path.resolve(pkgPath, v.source, v.entry);
  const checks: ConformResult["checks"] = [];
  // 오염 검사의 무대: 모든 동사를 임시 cwd 에서 돌리고 마지막에 잔여물을 본다
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conform-"));
  const run = (args: string[], env?: NodeJS.ProcessEnv) =>
    spawnEntrySync(entry, args, { encoding: "utf8", timeout: 20_000, cwd: tmp, ...(env ? { env } : {}) });

  const info = run(["info"]);
  let verbs: string[] = [];
  try {
    const j = JSON.parse(info.stdout || "");
    verbs = Array.isArray(j.verbs) ? j.verbs : [];
    const missing = REQUIRED_VERBS.filter((x) => !verbs.includes(x));
    const bad = !j.name || !j.provider;
    // protocol·capabilities 는 선택이지만, 선언했으면 형태를 지켜야 한다.
    // capabilities 는 물리적 능력의 닫힌 어휘다 — 오타가 조용히 무시되면 UI 가 능력을 못 켠다
    const badProto = j.protocol !== undefined && !Number.isInteger(j.protocol);
    const caps: unknown[] = Array.isArray(j.capabilities) ? j.capabilities : [];
    const badCaps =
      (j.capabilities !== undefined && !Array.isArray(j.capabilities)) ||
      caps.some((c) => typeof c !== "string" || !KNOWN_CAPS.has(c));
    checks.push({
      verb: "info",
      ok: info.status === 0 && !bad && missing.length === 0 && !badProto && !badCaps,
      note: info.status !== 0 ? `exit ${info.status}`
        : bad ? "name 또는 provider 누락"
        : missing.length ? `verbs 에 필수 동사 누락: ${missing.join(", ")}`
        : badProto ? `protocol 은 정수여야 합니다: ${JSON.stringify(j.protocol)}`
        : badCaps ? `capabilities 형식 위반 (닫힌 어휘 ${[...KNOWN_CAPS].join("|")}): ${JSON.stringify(j.capabilities)}`
        : `${j.name} (${j.provider})${j.protocol ? ` · protocol ${j.protocol}` : ""}${caps.length ? ` · ${caps.join(",")}` : ""}${verbs.includes("login") ? " · login 지원" : ""}`,
    });
  } catch {
    checks.push({ verb: "info", ok: false, note: "JSON 아님 — {name, provider, verbs} 를 내야 합니다" });
  }

  const setup = run(["setup"]);
  const setupOut = ((setup.stdout ?? "") + (setup.stderr ?? "")).trim();
  checks.push({
    verb: "setup",
    ok: setup.status === 0 || setupOut.length > 0,
    note: setup.status === 0 ? "준비됨" : setupOut ? `미준비 사유를 냄: ${setupOut.split("\n")[0]}` : "실패했는데 사유가 없습니다 — 조용한 실패 금지",
  });

  const models = run(["models"]);
  try {
    const arr = JSON.parse(models.stdout || "");
    const ok = Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "string");
    checks.push({
      verb: "models",
      ok,
      note: !Array.isArray(arr) ? "배열이 아님"
        : arr.length === 0 ? "빈 목록 — 자격 미도달이어도 폴백을 내야 합니다"
        : `${arr.length}개 (${arr.slice(0, 3).join(", ")}…)`,
    });
  } catch {
    checks.push({ verb: "models", ok: false, note: "JSON 배열이 아님" });
  }

  // 자격 스크럽: 자격 없는 환경에서도 빈 목록 금지이되, 날짜 박힌 모델 id 를 내면
  // 낡은 하드코딩 목록이 정본 행세를 하는 것이다 — 강등은 별칭 수준까지만 (2026-08-06 실증)
  const scrubbedEnv: NodeJS.ProcessEnv = {};
  for (const [k, val] of Object.entries(process.env)) {
    if (val == null || /(API_KEY|_TOKEN|SECRET|AUTHORIZATION|CREDENTIAL)/i.test(k)) continue;
    scrubbedEnv[k] = val;
  }
  const scrub = run(["models"], scrubbedEnv);
  try {
    const arr = JSON.parse(scrub.stdout || "");
    const dated = Array.isArray(arr) ? arr.filter((x) => typeof x === "string" && /\d{8}/.test(x)) : [];
    const ok = Array.isArray(arr) && arr.length > 0 && dated.length === 0;
    checks.push({
      verb: "models(자격 스크럽)",
      ok,
      note: !Array.isArray(arr) || arr.length === 0 ? "자격 없이 빈 목록/비배열 — 별칭 폴백을 내야 합니다"
        : dated.length ? `자격 없이 날짜 박힌 id — 낡은 목록의 정본 행세: ${dated[0]}`
        : `강등 정상 (${arr.length}개)`,
    });
  } catch {
    checks.push({ verb: "models(자격 스크럽)", ok: false, note: "자격 없이 JSON 배열이 아님" });
  }

  const cmds = run(["commands"]);
  try {
    const arr = JSON.parse(cmds.stdout || "");
    const ok = Array.isArray(arr) && arr.every((x) => x && typeof x.name === "string");
    checks.push({ verb: "commands", ok, note: ok ? `${arr.length}개` : "각 항목은 {name, description?, tty?} 여야 합니다" });
  } catch {
    checks.push({ verb: "commands", ok: false, note: "JSON 배열이 아님 (없으면 [])" });
  }

  const bogus = run(["__no_such_verb__"]);
  checks.push({
    verb: "미지 동사",
    ok: bogus.status !== 0,
    note: bogus.status !== 0 ? `거부(exit ${bogus.status})` : "미지 동사를 exit 0 으로 통과시킵니다 — 오타가 조용히 세션으로 흐릅니다",
  });

  // 오염 금지 불변식 ①: 위 동사들이 cwd 에 아무것도 남기지 않아야 한다.
  // 세션 동사의 오염(번들 밖 쓰기)은 자격이 필요해 여기서 못 본다 — 리뷰와 스모크가 맡는다
  let leftover: string[] = [];
  try {
    leftover = fs.readdirSync(tmp);
  } catch { /* 이미 제거됨 */ }
  checks.push({
    verb: "오염",
    ok: leftover.length === 0,
    note: leftover.length ? `동사 실행이 cwd 에 파일을 남김: ${leftover.join(", ")}` : "cwd 깨끗",
  });
  fs.rmSync(tmp, { recursive: true, force: true });

  if (verbs.includes("login")) {
    checks.push({ verb: "login", ok: true, note: "선언됨 — 대화형이라 자동 검사는 하지 않습니다" });
  }
  if (verbs.includes("serve")) {
    checks.push({ verb: "serve", ok: true, note: "선언됨 — 상주 세션(stdin 턴 주입). LLM 자격이 필요해 자동 검사는 하지 않습니다" });
  }

  return { variant: v.name, ok: checks.every((c) => c.ok), checks };
}

/**
 * 채널 어댑터 계약 적합성 — RELAY_CONFORM=1 스폰 문(schema surfaces.channels '검사' 절).
 * 어댑터는 외부 연결 없이 자기 서술 JSON 한 줄을 내고 0 으로 종료해야 한다.
 * 자격·네트워크가 필요한 착신·발신 왕복은 여기서 못 본다 — 리뷰와 스모크가 맡는다.
 */
export function conformChannel(pkgPath: string, c: { name: string; source: string; entry: string }): ConformResult {
  const entry = path.resolve(pkgPath, c.source, c.entry);
  const checks: ConformResult["checks"] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-conform-"));
  // 채널 entry 는 하네스(실행 파일)와 달리 기판이 node 로 스폰하는 계약이다 — run.ts startChannels 와 동일 스폰
  const r = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
    encoding: "utf8",
    timeout: 15_000,
    cwd: tmp,
    env: { ...process.env, RELAY_CONFORM: "1", RELAY_NAME: "conform", RELAY_CHANNEL: c.name, RELAY_API: "http://127.0.0.1:0", RELAY_TOKEN: "conform" },
  });
  try {
    const lines = String(r.stdout ?? "").trim().split("\n").filter(Boolean);
    const j = JSON.parse(lines[lines.length - 1] ?? "");
    checks.push({
      verb: "conform",
      ok: r.status === 0 && typeof j.name === "string" && j.name.length > 0,
      note: r.status !== 0 ? `exit ${r.status}` : !j.name ? "name 누락" : `${j.name}${j.protocol ? ` · protocol ${j.protocol}` : ""}`,
    });
  } catch {
    checks.push({ verb: "conform", ok: false, note: "RELAY_CONFORM=1 에서 자기 서술 JSON 한 줄을 내고 0 으로 종료해야 합니다" });
  }
  let leftover: string[] = [];
  try {
    leftover = fs.readdirSync(tmp);
  } catch { /* 이미 제거됨 */ }
  checks.push({ verb: "오염", ok: leftover.length === 0, note: leftover.length ? `cwd 에 파일을 남김: ${leftover.join(", ")}` : "cwd 깨끗" });
  fs.rmSync(tmp, { recursive: true, force: true });
  return { variant: `channel:${c.name}`, ok: checks.every((x) => x.ok), checks };
}

/**
 * 채널 자격 검증 — RELAY_VERIFY=1 스폰 문(schema surfaces.channels '검증' 절).
 * "저장됨 ≠ 유효": vault 에 앉은 자격을 주입해 어댑터가 실왕복 한 번(소켓·상주 없이)만
 * 돌려 {ok, note} 를 내는지 본다. 상주 프로세스는 건드리지 않는다 — throwaway 스폰이다.
 * 미구현 어댑터(검증 문 없이 상주로 흐름)는 15초 timeout 으로 판정 없음(null)으로 강등된다.
 */
export function verifyChannel(
  pkgPath: string,
  c: { name: string; source: string; entry: string },
  cred: string | null,
): { ok: boolean; note: string } {
  if (!cred) return { ok: false, note: "자격 없음 — 먼저 연결하세요" };
  const entry = path.resolve(pkgPath, c.source, c.entry);
  const credEnv = `RELAY_CRED_${c.name.toUpperCase().replace(/-/g, "_")}`;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "relay-verify-"));
  try {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", entry], {
      encoding: "utf8",
      timeout: 15_000,
      cwd: tmp,
      env: { ...process.env, RELAY_VERIFY: "1", RELAY_NAME: "verify", RELAY_CHANNEL: c.name, RELAY_API: "http://127.0.0.1:0", RELAY_TOKEN: "verify", [credEnv]: cred },
    });
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      return { ok: false, note: "검증 문(RELAY_VERIFY) 미구현 — 저장은 됐으나 유효 여부를 확인할 수 없습니다" };
    }
    const lines = String(r.stdout ?? "").trim().split("\n").filter(Boolean);
    const j = JSON.parse(lines[lines.length - 1] ?? "");
    return { ok: r.status === 0 && j.ok === true, note: typeof j.note === "string" ? j.note : (j.ok ? "유효" : "검증 실패") };
  } catch {
    return { ok: false, note: "검증 응답을 읽지 못했습니다 (RELAY_VERIFY=1 에서 {\"ok\":…} 한 줄을 내야 합니다)" };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function conformPkg(ledger: Ledger, name: string): ConformResult[] {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  return [
    ...(m.harness?.variants ?? []).map((v) => conformHarness(rec.path, v)),
    ...(m.surfaces?.channels ?? []).map((c) => conformChannel(rec.path, c)),
  ];
}

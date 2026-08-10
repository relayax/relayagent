import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnEntrySync } from "./entry.ts";
import { loadManifest, type HarnessVariant } from "./manifest.ts";
import type { Ledger } from "./state.ts";

export interface ConformResult {
  variant: string;
  ok: boolean;
  checks: { verb: string; ok: boolean; note: string }[];
}

const REQUIRED_VERBS = ["session", "setup", "models", "commands", "info"];
const KNOWN_CAPS = new Set(["cancel", "vision", "effort", "resume"]);

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

  return { variant: v.name, ok: checks.every((c) => c.ok), checks };
}

export function conformPkg(ledger: Ledger, name: string): ConformResult[] {
  const rec = ledger.packages[name];
  if (!rec) throw new Error(`미설치 패키지: ${name}`);
  const m = loadManifest(rec.path);
  return (m.harness?.variants ?? []).map((v) => conformHarness(rec.path, v));
}

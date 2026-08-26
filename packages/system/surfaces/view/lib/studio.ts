import { callScript } from "./api";

// 수정 레이어의 화면 쪽 절반. 모든 호출은 system 패키지의 draft-* 동사를 지난다 —
// 설치본을 직접 만지는 경로는 화면에 존재하지 않는다.

export interface DraftChange {
  file: string;
  /** M 수정, A 추가, D 삭제, ? 미추적, R 이름변경 */
  state: string;
}

export interface DraftStatus {
  name: string;
  path: string;
  manifest: string;
  tree: string[];
  files: string[];
  /** 파일별 내용 지문 — draft-write 의 base 로 되돌려주면 동시 편집을 판정한다 */
  hashes: Record<string, string>;
  changes: DraftChange[];
  lastCommit: { hash: string; message: string; time: number } | null;
  version: { draft: string | null; live: string | null };
  installed: boolean;
}

export interface DraftEntry {
  name: string;
  version: string | null;
  changes: number;
  installed: boolean;
}

export interface Release {
  version: string;
  time: number;
  live: boolean;
}

export interface PublishOutcome {
  published: boolean;
  name: string;
  version?: string;
  path?: string;
  fresh?: boolean;
  setup?: { ok: boolean; out: string } | null;
  build?: { ok: boolean; out: string } | null;
  services?: string[];
  note?: string;
  /** 어디에 앉았는가 — local(이 기판의 장부) | org(임베더의 유통망, Authority.publish) */
  landed?: "local" | "org";
  /** org 착지의 다음 걸음(설치 화면 등) */
  href?: string;
}

export function draftOpen(
  name: string,
  extra?: { manifest?: unknown; personas?: Record<string, string>; seedHarness?: { source: string; entry: string }[] },
): Promise<DraftStatus> {
  return callScript("draft-open", { name, ...(extra ?? {}) });
}

export function draftRead(name: string): Promise<DraftStatus> {
  return callScript("draft-read", { name });
}

export function draftReadFile(name: string, file: string): Promise<{ file: string; content: string; hash: string }> {
  return callScript("draft-read", { name, file });
}

/** base = 파일별 마지막 읽기 지문(opt-in) — 실은 경로가 그 사이 다른 손(빌더·CLI·다른 화면)에
 *  고쳐졌으면 기판이 아무것도 쓰지 않고 E_CONFLICT 로 실패한다. null = 없는 파일로 알고 있다 */
export function draftWrite(
  name: string,
  files: Record<string, string>,
  deletes?: string[],
  base?: Record<string, string | null>,
): Promise<{ written: string[]; deleted: string[]; hashes: Record<string, string> }> {
  return callScript("draft-write", { name, files, delete: deletes, base });
}

export function draftDiff(name: string): Promise<{ changes: DraftChange[]; diff: string }> {
  return callScript("draft-diff", { name });
}

export function draftCommit(name: string, message: string): Promise<{ committed: boolean; hash?: string; note?: string }> {
  return callScript("draft-commit", { name, message });
}

/** 좌표를 실은 판정 한 줄. line/col 은 1-기반이고, 못 짚었으면 null 이다(지어내지 않는다) */
export interface Verdict {
  message: string;
  line: number | null;
  col: number | null;
  /** 선언 경로 — 트리가 그 노드로 뛰는 좌표 (예: "agents.diary") */
  path: string | null;
}

export function draftValidate(name: string): Promise<{ ok: boolean; issues: string[]; verdicts: Verdict[] }> {
  return callScript("draft-validate", { name });
}

/**
 * 미리보기 굽기 — 작업 사본을 /draft/<이름>/ 좌표로 굽는다. 도는 판은 그대로다.
 * out 을 선언한 표면(next 뷰·번들)은 굽지 않으면 미리볼 것이 없고, 그렇다고 발행을 요구하면
 * 그건 미리보기가 아니다.
 */
export function draftBuild(name: string): Promise<{ name: string; built: boolean; out: string }> {
  return callScript("draft-build", { name });
}

/** 작업 사본의 동사 한 번. 코드는 작업 사본, 맥락(작업 폴더·자격·서비스)은 설치본이다 */
export function draftRun(name: string, verb: string, input: unknown): Promise<{ ok: boolean; ms: number; result?: unknown; error?: string }> {
  return callScript("draft-run", { name, verb, input });
}

export function draftPublish(name: string, version?: string): Promise<PublishOutcome> {
  return callScript("draft-publish", { name, version });
}

export interface DraftCommit {
  hash: string;
  message: string;
  time: number;
}

/** 기록 이력 — [기록] 다이얼로그가 "이 지점으로" 를 붙이는 목록. 종전에는 기록만 되고 돌아갈 문이 없었다 */
export function draftHistory(name: string): Promise<{ commits: DraftCommit[] }> {
  return callScript("draft-history", { name });
}

/** 기록 지점으로 되돌리기 — 파일만 그 모습으로, 이력은 그대로. 결과는 "기록하지 않은 변경" 으로 선다 */
export function draftRestore(name: string, hash: string): Promise<{ restored: string; message: string }> {
  return callScript("draft-restore", { name, hash });
}

export function draftDiscard(name: string): Promise<{ removed: string }> {
  return callScript("draft-discard", { name });
}

export function draftList(): Promise<{ drafts: DraftEntry[] }> {
  return callScript("draft-list", {});
}

export interface PackOutcome {
  ref: string;
  version: string;
  file: string;
  size: number;
  digest: string;
  files: number;
  /** 매니페스트 선언 밖이라 봉투에 담기지 않은 파일들 */
  excluded: string[];
  shelf: string;
}

/**
 * 굽기 — 배포된 설치본을 봉투 하나로 만들어 선반에 앉힌다.
 * 파일을 내려받게 하지 않는 것이 요점이다: 봉인과 요구 범위가 함께 계산된 채로 선반에
 * 남고, 스토어 등재 화면이 그 선반을 읽는다.
 */
export function packPkg(name: string): Promise<PackOutcome> {
  return callScript("pkg-pack", { name });
}

export function releaseList(name: string): Promise<{ releases: Release[] }> {
  return callScript("release-list", { name });
}

export function releaseRollback(name: string, version: string): Promise<{ name: string; version: string }> {
  return callScript("release-rollback", { name, version });
}

export async function fetchSchema(): Promise<any> {
  const res = await fetch("/schema.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`schema ${res.status}`);
  return res.json();
}

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

export function draftReadFile(name: string, file: string): Promise<{ file: string; content: string }> {
  return callScript("draft-read", { name, file });
}

export function draftWrite(name: string, files: Record<string, string>, deletes?: string[]): Promise<{ written: string[]; deleted: string[] }> {
  return callScript("draft-write", { name, files, delete: deletes });
}

export function draftDiff(name: string): Promise<{ changes: DraftChange[]; diff: string }> {
  return callScript("draft-diff", { name });
}

export function draftCommit(name: string, message: string): Promise<{ committed: boolean; hash?: string; note?: string }> {
  return callScript("draft-commit", { name, message });
}

export function draftValidate(name: string): Promise<{ ok: boolean; issues: string[] }> {
  return callScript("draft-validate", { name });
}

export function draftPublish(name: string, version?: string): Promise<PublishOutcome> {
  return callScript("draft-publish", { name, version });
}

export function draftDiscard(name: string): Promise<{ removed: string }> {
  return callScript("draft-discard", { name });
}

export function draftList(): Promise<{ drafts: DraftEntry[] }> {
  return callScript("draft-list", {});
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

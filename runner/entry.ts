import fs from "node:fs";
import path from "node:path";
import {
  spawn as nodeSpawn,
  spawnSync as nodeSpawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";

let cachedBash: string | null = null;

function existingFile(candidate: string | undefined): string | null {
  if (!candidate) return null;
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function windowsBash(): string {
  if (cachedBash) return cachedBash;

  const configured = process.env.RELAY_BASH?.trim();
  if (configured) {
    if (!path.isAbsolute(configured) || existingFile(configured)) {
      cachedBash = configured;
      return configured;
    }
    throw new Error(`RELAY_BASH 파일이 없습니다: ${configured}`);
  }

  const where = nodeSpawnSync("where.exe", ["bash.exe"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const fromPath = String(where.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => existingFile(line))
    .find((line): line is string => Boolean(line));
  if (fromPath) {
    cachedBash = fromPath;
    return fromPath;
  }

  const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
  for (const root of roots) {
    const found = existingFile(root ? path.join(root, "Git", "bin", "bash.exe") : undefined)
      ?? existingFile(root ? path.join(root, "Git", "usr", "bin", "bash.exe") : undefined);
    if (found) {
      cachedBash = found;
      return found;
    }
  }

  throw new Error("Windows harness 실행에 Git Bash가 필요합니다. Git for Windows를 설치하거나 RELAY_BASH에 bash.exe 경로를 지정하세요.");
}

function commandForEntry(entry: string): { command: string; prefix: string[] } {
  if (process.platform !== "win32") return { command: entry, prefix: [] };
  return { command: windowsBash(), prefix: [entry] };
}

export function spawnEntry(entry: string, args: readonly string[], options?: SpawnOptions): ChildProcess {
  const { command, prefix } = commandForEntry(entry);
  return nodeSpawn(command, [...prefix, ...args], options ?? {});
}

export function spawnEntrySync(
  entry: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
): SpawnSyncReturns<string>;
export function spawnEntrySync(
  entry: string,
  args: readonly string[],
  options?: SpawnSyncOptions,
): SpawnSyncReturns<Buffer>;
export function spawnEntrySync(
  entry: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<string> | SpawnSyncReturns<Buffer> {
  const { command, prefix } = commandForEntry(entry);
  return nodeSpawnSync(command, [...prefix, ...args], options as never) as SpawnSyncReturns<string> | SpawnSyncReturns<Buffer>;
}

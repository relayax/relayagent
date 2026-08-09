import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { RELAY_HOME } from "./state.ts";

const SERVICE = "relay";
const FALLBACK = path.join(RELAY_HOME, "vault.json");

function hasSecurity(): boolean {
  return spawnSync("which", ["security"]).status === 0;
}

function fileVault(): Record<string, string> {
  if (!fs.existsSync(FALLBACK)) return {};
  return JSON.parse(fs.readFileSync(FALLBACK, "utf8"));
}

function saveFileVault(v: Record<string, string>): void {
  fs.mkdirSync(RELAY_HOME, { recursive: true });
  fs.writeFileSync(FALLBACK, JSON.stringify(v), { mode: 0o600 });
}

export function vaultSet(key: string, value: string): void {
  if (hasSecurity()) {
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", key, "-w", value]);
    if (r.status === 0) return;
  }
  const v = fileVault();
  v[key] = value;
  saveFileVault(v);
}

export function vaultGet(key: string): string | null {
  if (hasSecurity()) {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", key, "-w"], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  return fileVault()[key] ?? null;
}

export function vaultDelete(key: string): void {
  if (hasSecurity()) spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", key]);
  const v = fileVault();
  if (key in v) {
    delete v[key];
    saveFileVault(v);
  }
}

export const credKey = (pkg: string, service: string) => `${pkg}/${service}`;

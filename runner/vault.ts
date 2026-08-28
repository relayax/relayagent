import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELAY_HOME } from "./supply/ledger.ts";

/** 홈이 다르면 자격도 다르다 — Keychain 서비스 이름을 홈으로 가른다.
 *
 *  종전에는 서비스가 "relay" 하나라, RELAY_HOME 을 갈라도 자격만은 모든 인스턴스가 공유했다.
 *  장부·세션은 나뉘는데 자격은 안 나뉘는 절반의 격리였다(데스크톱 앱이 자기 홈 ~/.relay-app
 *  을 쓰기 시작한 2026-08-28 에 드러났다). 기본 홈은 이름을 바꾸지 않는다 — 바꾸면 기존
 *  CLI 사용자의 자격이 통째로 안 보이게 된다. 갈라지는 것은 **기본이 아닌 홈**뿐이다. */
const DEFAULT_HOME = path.join(os.homedir(), ".relay");
const LEGACY_SERVICE = "relay";
const SERVICE = RELAY_HOME === DEFAULT_HOME ? LEGACY_SERVICE : `relay:${RELAY_HOME}`;
const FALLBACK = path.join(RELAY_HOME, "vault.json");

function hasSecurity(): boolean {
  // RELAY_VAULT=file — Keychain 이 있어도 파일 vault 강제(헤드리스 서버·테스트 격리용).
  // 테스트가 사용자 Keychain 을 오염시키는 것은 사고다
  if (process.env.RELAY_VAULT === "file") return false;
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

/** Keychain 한 자리에서 읽는다 — 없으면 null. 실패와 부재를 가르지 않는다(둘 다 "못 읽었다") */
function keychainGet(service: string, key: string): string | null {
  const r = spawnSync("security", ["find-generic-password", "-s", service, "-a", key, "-w"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

export function vaultGet(key: string): string | null {
  if (hasSecurity()) {
    const mine = keychainGet(SERVICE, key);
    if (mine !== null) return mine;
    // 옛 자리 한 번 넘겨보기 — 홈을 가르기 전에 넣어 둔 자격이 여기 있다. 찾으면 내 자리로
    // 옮겨 적고(다음부터는 첫 조회에서 걸린다) 옛 자리는 지우지 않는다: CLI 가 계속 쓴다.
    // 열거 API 가 없어(키가 `<pkg>/<service>` 같은 문자열이다) 일괄 이사는 불가능하고,
    // 이렇게 읽는 김에 옮기는 것이 사람 손을 타지 않는 유일한 길이다.
    if (SERVICE !== LEGACY_SERVICE) {
      const legacy = keychainGet(LEGACY_SERVICE, key);
      if (legacy !== null) {
        vaultSet(key, legacy);
        return legacy;
      }
    }
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

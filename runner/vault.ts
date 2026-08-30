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

/** `which security` 의 답은 이 프로세스가 사는 동안 바뀌지 않는다 — 그런데 이 판정은 자격
 *  조회마다 걸려, 연결 전경 한 번(서비스·채널 수만큼)이 그 수만큼 동기 스폰을 물었다.
 *  사이드바 배지가 15초마다 밟는 자리라 그 값이 그대로 기판의 정지 시간이 된다(2026-08-29) */
let securityOnPath: boolean | null = null;

function hasSecurity(): boolean {
  // RELAY_VAULT=file — Keychain 이 있어도 파일 vault 강제(헤드리스 서버·테스트 격리용).
  // 테스트가 사용자 Keychain 을 오염시키는 것은 사고다. 이 판정은 캐시하지 않는다 —
  // 환경을 바꿔 부르는 호출자가 있고, 캐시해도 아낄 것이 없다
  if (process.env.RELAY_VAULT === "file") return false;
  if (securityOnPath === null) securityOnPath = spawnSync("which", ["security"]).status === 0;
  return securityOnPath;
}

/**
 * **없다고 확인된 좌표** — 그 조회를 잠시 건너뛴다. 캐시하는 것은 부재뿐이고, 값은 절대 담지
 * 않는다(자격을 프로세스 메모리에 두는 것은 vault 의 존재 이유를 지운다).
 *
 * 자격이 안 앉은 좌표 하나가 동기 스폰 둘을 물었다 — 내 자리에서 못 찾고, 옛 자리에서 또 못 찾고.
 * 하필 연결 전경이 세는 것이 바로 그 "빈 자격"들이라(connections.ts attentionOf), 사이드바 배지
 * 한 번이 빈 자격 수만큼 그 두 배를 물었다. 실측 2026-08-29: 빈 좌표 7개에 0.7초, 그동안 데몬은
 * 통째로 멎는다. 15초마다 밟는 자리라 그 값이 그대로 기판의 정지 시간이 된다.
 *
 * 영구가 아니라 시한인 이유: 이 프로세스의 쓰기는 아래에서 즉시 무르지만(vaultSet·vaultDelete)
 * **다른 프로세스**의 쓰기는 알 수 없다 — 기본 홈의 CLI 로 자격을 넣은 사람이 앱에서 그것을
 * 영영 못 보면 안 된다. 한 번쯤 늦게 보이는 것과 영영 안 보이는 것은 다르다.
 */
const ABSENT_TTL_MS = 60_000;
const absent = new Map<string, number>();

function fileVault(): Record<string, string> {
  if (!fs.existsSync(FALLBACK)) return {};
  return JSON.parse(fs.readFileSync(FALLBACK, "utf8"));
}

function saveFileVault(v: Record<string, string>): void {
  fs.mkdirSync(RELAY_HOME, { recursive: true });
  fs.writeFileSync(FALLBACK, JSON.stringify(v), { mode: 0o600 });
}

export function vaultSet(key: string, value: string): void {
  absent.delete(key); // 내 손으로 앉힌 자격은 즉시 보여야 한다
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
  if ((absent.get(key) ?? 0) > Date.now()) return null;
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
  const inFile = fileVault()[key] ?? null;
  if (inFile === null) absent.set(key, Date.now() + ABSENT_TTL_MS);
  return inFile;
}

export function vaultDelete(key: string): void {
  absent.set(key, Date.now() + ABSENT_TTL_MS); // 지운 자격은 즉시 사라져 보여야 한다
  if (hasSecurity()) spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", key]);
  const v = fileVault();
  if (key in v) {
    delete v[key];
    saveFileVault(v);
  }
}

/** 자격 좌표 — <패키지>/<서비스>. 계정 축(services[].auth.accounts)이 있으면 <패키지>/<서비스>@<계정> —
 *  같은 서비스에 자격이 여럿 앉는 유일한 모양이다. 계정 없는 좌표와 겹치지 않는다(서비스 이름은 slug 라 @ 가 없다) */
export const credKey = (pkg: string, service: string, account?: string | null): string =>
  account ? `${pkg}/${service}@${account}` : `${pkg}/${service}`;

/** 계정 축의 색인 좌표 — 그 서비스에 앉은 계정 이름 목록(JSON 배열)이 산다. Keychain 에는 열거 API 가
 *  없어(키는 문자열 하나다) 색인이 없으면 "어느 계정이 연결됐는가" 를 아무도 답하지 못한다. 서비스 이름에
 *  슬래시가 없으므로 자격 좌표와 겹칠 수 없다 */
export const accountsKey = (pkg: string, service: string): string => `${pkg}/${service}/accounts`;

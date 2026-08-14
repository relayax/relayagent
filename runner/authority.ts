// 권위 이음새 — runner 의 두 반쪽(실행/권위) 사이의 유일한 인터페이스 (convergence.md §runner).
// 모든 소비(스크립트·엣지·a2a·채널·도구)는 한 질문으로 환원된다: "누구로서, 무엇을, 어떤
// 자격으로." 1인 기판은 이 파일의 localAuthority(로컬 vault·장부·OS 사용자)가 답하고,
// 조직 기판은 같은 인터페이스의 원격 구현(control-plane 어댑터)을 꽂는다 — "OS 의 runner" 는
// 없고, runner 인접 조직 코드는 이 인터페이스의 구현 하나뿐이어야 한다.
//
// 익명의 제3자 임베더 테스트: 이 인터페이스는 relayos 를 모른다. principal 이 문자열 하나인
// 것, 자격이 (스코프 → 값) 인 것, 인가가 (consumer, provider, 능력) 장부인 것 — 어느 답도
// 특정 조직 기판의 형상을 요구하지 않는다.
//
// 현재 배선: 데몬 문(api.ts — 토큰 해석·principal·grant 판정)이 이 이음새를 지난다.
// scripts/session/run 의 vault 직접 소비는 임베드 트랙에서 같은 이음새로 이사한다.
import { PRINCIPAL, pkgToken, tokenToPkg, type Grant, type Ledger } from "./state.ts";
import { vaultGet, vaultSet } from "./vault.ts";

export type { Authority, AuthorityGrant } from "./authority-contract.ts";
import type { Authority } from "./authority-contract.ts";

/** 1인 기판의 권위 — 로컬 장부(ledger)·vault·OS 사용자가 전부다 */
export function localAuthority(getLedger: () => Ledger): Authority {
  return {
    principal: () => PRINCIPAL,
    packageToken: (pkg) => pkgToken(getLedger(), pkg),
    packageForToken: async (token) => tokenToPkg(getLedger(), token),
    credential: async (scope) => vaultGet(scope),
    setCredential: async (scope, value) => vaultSet(scope, value),
    grants: async () => getLedger().grants,
    grantForTool: async (consumer, provider, tool) =>
      getLedger().grants.find((g) => g.consumer === consumer && g.provider === provider && (g.tools ?? []).includes(tool)) ?? null,
    grantForMission: async (consumer, provider, mission) =>
      getLedger().grants.find((g) => g.consumer === consumer && g.provider === provider && g.mission === mission) ?? null,
  };
}

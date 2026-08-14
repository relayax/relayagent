// 권위 이음새의 계약 반쪽 — 의존성 0 인 독립 파일. 이 파일이 임베더(조직 기판의 권위
// 어댑터)가 벤더링해 구현하는 아티팩트다. runner 내부 형(state.ts Ledger 등)을 여기 끌어오면
// 임베더가 runner 전체를 알아야 하므로, 계약은 자기 완결로 유지한다(익명의 제3자 임베더 테스트).
// 구현 반쪽(localAuthority — 1인 기판)은 runner/authority.ts 에 산다.

/** 인가 한 줄 — grant 는 선언을 초과할 수 없다 */
export interface AuthorityGrant {
  consumer: string;
  provider: string;
  tools?: string[];
  mission?: string;
}

// 비동기 계약 — 원격 권위(조직 control 어댑터)는 판정·자격이 네트워크 왕복이다. 로컬 권위가
// 동기라는 이유로 이음새를 동기로 굳히면 원격 구현이 불가능해져 이음새가 장식이 된다.
// principal/packageToken 만 동기다: 실행 문맥에 이미 앉아 있는 값(env·장부)이라 왕복이 없다.
export interface Authority {
  /** 누구로서 — 이 소비를 감싸는 principal. 1인 기판은 항상 소유자 하나다 */
  principal(): string;
  /** 실행 단위(패키지)의 신원 토큰 발급 */
  packageToken(pkg: string): string;
  /** 신원 토큰 해석 — 실패는 null(fail-closed 는 호출부 소관) */
  packageForToken(token: string): Promise<string | null>;
  /** 어떤 자격으로 — 스코프 좌표의 자격 값(요청 시점 발급). 없으면 null */
  credential(scope: string): Promise<string | null>;
  setCredential(scope: string, value: string): Promise<void>;
  /** 인가 장부 — grant 는 선언을 초과할 수 없다(쓰기는 단일 결재 문 소관) */
  grants(): Promise<AuthorityGrant[]>;
  /** consumer 가 provider 의 tool 을 소비할 인가가 있는가 */
  grantForTool(consumer: string, provider: string, tool: string): Promise<AuthorityGrant | null>;
  /** consumer 가 provider 의 mission 에 위임할 인가가 있는가 */
  grantForMission(consumer: string, provider: string, mission: string): Promise<AuthorityGrant | null>;
}

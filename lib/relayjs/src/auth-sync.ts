/*!
 * auth-sync.ts — 로그아웃 크로스뷰 동기화(BroadcastChannel + storage 신호).
 *
 * 출처(Phase 1-b 절제 추출, 2026-08-17): relayos-claude lib/relayjs/src/auth-sync.ts.
 * 상륙 후 이 사본이 정본이다 — relayos 원본은 손 편집 금지(upstream-first).
 * 소비자는 채팅 위젯(src/chat/Chat.tsx — AccountMenu·useAuthWatch)이다.
 *
 * 인증 표면은 계약 밖·기판 소유다(docs/client-protocol.md §2-5). 이 모듈은 자격을 나르지
 * 않는다 — "어느 뷰가 로그아웃했다"는 신호를 같은 브라우징 컨텍스트에 중계할 뿐이고, 신호의
 * 발신(AccountMenu 로그아웃)은 principal 을 주입한 기판에서만 렌더된다. 무신원 loopback
 * 기판(OSS 기본)에서는 발신자가 없어 감시가 관성적으로 잠잔다.
 *
 * 절제 목록 — 원본에서 가져오지 않은 것과 그 이유:
 *   - focus/visible 시 /api/me 재검사(fetchWithSessionRetry 경유): org deployd 파사드·세션
 *     리프레시 결합(§2-5 기판 소유 어휘). BC 미도달 분리 웹뷰를 커버하던 백업 축인데, 그
 *     표면(Swift thin-client)은 2026-07-21 은퇴 — 웹 단일 표면에서는 BC+storage 로 충분하다.
 *     org 크롬(AuthWatch)의 전면 커버는 relayos 쪽 크롬이 계속 소유한다.
 */

const AUTH_CH = "relay-auth";
const AUTH_LS_KEY = "relay-auth-logout";

/** 로그아웃 발신 — 같은 브라우징 컨텍스트의 다른 뷰(탭·다른 인스턴스)에 즉시 알린다. */
export function broadcastLogout(): void {
  try { const bc = new BroadcastChannel(AUTH_CH); bc.postMessage({ type: "logout" }); bc.close(); } catch { /* 미지원 환경 */ }
  try { localStorage.setItem(AUTH_LS_KEY, String(Date.now())); } catch { /* storage 접근 불가 */ }
}

/** 로그아웃 감시 설치 — 해제 함수를 반환한다(effect cleanup 에 그대로). */
export function installAuthWatch(): () => void {
  let redirected = false;
  const toLogin = () => { if (!redirected) { redirected = true; window.location.href = "/login"; } };
  let bc: BroadcastChannel | null = null;
  try {
    bc = new BroadcastChannel(AUTH_CH);
    bc.onmessage = (e) => { if ((e?.data as any)?.type === "logout") toLogin(); };
  } catch { /* 미지원 환경 — storage 백업 */ }
  const onStorage = (e: StorageEvent) => { if (e.key === AUTH_LS_KEY && e.newValue) toLogin(); };
  window.addEventListener("storage", onStorage);
  return () => {
    try { bc?.close(); } catch { /* noop */ }
    window.removeEventListener("storage", onStorage);
  };
}

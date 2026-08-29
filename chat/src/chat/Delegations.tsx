/*!
 * Delegations.tsx — 이 대화가 맡긴 일의 **상시 현황 줄**.
 *
 * 왜 새 자리가 필요한가: 위임은 이 대화의 도구 호출 하나로 시작하지만 일은 **다른 대화에서**
 * 돈다. 그래서 EnvelopeReducer(턴 하나의 파트 모델)에는 실을 곳이 없다 — 부모 턴이 종결되는
 * 순간 위임 카드는 그냥 이력이 되고, 그 뒤로 30분을 더 도는 서브에이전트를 말할 자리가 화면에
 * 아예 없었다. 사용자가 "진행중인가요?" 를 반복해 물어야 했던 것이 그 공백이다(2026-08-29).
 *
 * 짝지음의 근거는 세션 행의 `parent`(§5.3-26) 다. 종전에 부모↔자식 관계는 위임 배달 클로저의
 * 메모리에만 있어 데몬과 함께 죽었다 — 디스크에 남는 축이 생긴 뒤에야 새로고침·재기동을 건너
 * 이 줄을 세울 수 있다.
 *
 * 갱신 규율(§5.8 — 유휴 폴링 폴백 금지):
 *  · 계기는 push 이벤트·visibility 복귀·창 포커스·사용자 행위. ServerTurnWatch 와 같은 관용구다.
 *  · 경과 시간 글자는 **네트워크 없이** 1초 티커로 다시 그린다 — 시각이 절대값(epoch ms)이라
 *    이미 받아 둔 스냅샷만으로 "3분째"가 자란다. 살아 보이게 하려고 서버를 두드리지 않는다.
 *  · 진행 중인 위임이 화면에 있고 이 페인이 보일 때만 10초 새로고침이 붙는다. §5.8 의 금지는
 *    턴 관찰(turn.stream/push)의 폴링 대체를 겨눈 것이고 이 줄은 다른 자원(세션 목록)이지만,
 *    규칙의 경계에 서 있는 것은 사실이다. 근거를 명시해 둔다: 이 줄의 주장("멈춤")은 스냅샷이
 *    낡으면 곧바로 거짓이 된다 — 낡은 데이터로 "응답 없음"을 말하느니 그때만 다시 읽는다.
 *    진행 중인 위임이 없으면 타이머 자체가 없다.
 */
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import type { RelayCtx, ConversationRow } from "./runtime";
import { loadConversationsOf, wireSessionForId, watchServerTurns, livenessOf, livenessLabel, livenessTitle } from "./runtime";
import { ActivePaneCtx } from "./ctx";

/** 위임 행의 이름 — 기계 라벨("↳ agent-builder · detail-page")의 화살표를 떼고 사람 말로.
 *  ChatTabs.subLabel 의 쌍둥이다. import 하지 않는 이유는 순환이다(ChatTabs → Chat → 여기). */
function nameOf(r: ConversationRow): string {
  const t = (r.title || "").replace(/^↳\s*/, "").trim();
  if (t) return t;
  if (r.agent) return r.param ? `${r.agent} · ${r.param}` : r.agent;
  return r.conversation_id;
}

/** 진행 중인 위임이 화면에 있을 때의 재조회 간격 — 아래 주석의 근거 참조. */
const REFRESH_MS = 10_000;

export function DelegationStrip({ ctx }: { ctx: RelayCtx }) {
  const active = useContext(ActivePaneCtx);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  // 경과 글자를 다시 그리기 위한 지금 — 네트워크와 무관하다
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef(false);
  const lastProbe = useRef(0);

  const mySlot = wireSessionForId(ctx.conversationId);

  const refresh = useCallback(async (force = false) => {
    if (!ctx.instanceId || !mySlot || inflight.current) return;
    const t = Date.now();
    if (!force && t - lastProbe.current < 1500) return; // 행위 연타 흡수 — 계기당 1회면 충분
    lastProbe.current = t;
    inflight.current = true;
    try {
      const info = await loadConversationsOf(ctx.instanceId, ctx.principal).catch(() => null);
      if (!info) return;
      // 내가 판 위임만. origin 판정은 기판 몫이고(§5.3-25) 슬롯 접두 스니핑은 금지다
      setRows(info.conversations.filter((c) => c.origin === "dispatch" && c.parent === mySlot && c.busy));
      setNow(Date.now());
    } finally {
      inflight.current = false;
    }
  }, [ctx.instanceId, ctx.principal, mySlot]);

  // 계기 구독 — ServerTurnWatch 와 같은 관용구(§5.8: 유휴 폴링 폴백 금지)
  useEffect(() => {
    if (!mySlot) return;
    void refresh(true);
    const unwatch = watchServerTurns(ctx, () => void refresh());
    const onVis = () => { if (!document.hidden) void refresh(); };
    const onFocus = () => void refresh();
    const onAct = () => void refresh();
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pointerdown", onAct, true);
    window.addEventListener("keydown", onAct, true);
    return () => {
      unwatch();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pointerdown", onAct, true);
      window.removeEventListener("keydown", onAct, true);
    };
  }, [ctx, mySlot, refresh]);

  // 경과 글자만 자라게 하는 로컬 티커 — 줄이 서 있을 때만 돈다
  useEffect(() => {
    if (rows.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [rows.length]);

  // 진행 중인 위임이 보일 때만 붙는 재조회 — 낡은 스냅샷으로 "멈춤"을 주장하지 않기 위해서다
  useEffect(() => {
    if (rows.length === 0 || !active) return;
    const t = setInterval(() => { if (!document.hidden) void refresh(true); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [rows.length, active, refresh]);

  if (rows.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-0.5 border-t border-border/60 px-3 py-1.5" aria-label="맡긴 일">
      {rows.map((r) => {
        const l = livenessOf(r, now);
        const warn = l.state === "stalled";
        return (
          <button key={r.conversation_id} type="button"
                  title={`${livenessTitle(l)} · 눌러서 이 작업의 대화를 열어요`}
                  className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] hover:bg-muted"
                  onClick={() => {
                    try {
                      window.dispatchEvent(new CustomEvent("relay:chat-open", {
                        detail: { instance: ctx.instanceId, conversation: r.conversation_id },
                      }));
                    } catch { /* 미배선 셸 — 줄은 그대로 정보로 남는다 */ }
                  }}>
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
              {warn
                ? <span className="text-[var(--rc-err)]" aria-hidden>!</span>
                : <Spinner role={undefined} aria-label={undefined} aria-hidden className="text-[var(--rc-accent)] size-3" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/75">{nameOf(r)}</span>
            <span className={cn("shrink-0 tabular-nums text-[11px]", warn ? "text-[var(--rc-err)]" : "text-muted-foreground")}>
              {livenessLabel(l)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

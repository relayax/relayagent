/*!
 * Delegations.tsx — 이 대화가 맡긴 일의 **상시 현황 줄**.
 *
 * 왜 새 자리가 필요한가: 위임은 이 대화의 도구 호출 하나로 시작하지만 일은 **다른 대화에서**
 * 돈다. 그래서 EnvelopeReducer(턴 하나의 파트 모델)에는 실을 곳이 없다 — 부모 턴이 종결되는
 * 순간 위임 카드는 그냥 이력이 되고, 그 뒤로 30분을 더 도는 서브에이전트를 말할 자리가 화면에
 * 아예 없었다. 사용자가 "진행중인가요?" 를 반복해 물어야 했던 것이 그 공백이다(2026-08-29).
 *
 * 위임은 두 형이고 **둘 다 여기 선다**(2026-08-30). 서브에이전트 위임(agent_dispatch)은 같은
 * 인스턴스 안에 대화가 서지만, a2a 미션은 **수신 패키지 쪽에** 선다 — 공장이 조사를 맡기면 그
 * 대화는 조사 앱의 세션이다. 처음 판은 같은 인스턴스만 보고 `origin === "dispatch"` 만 세어서,
 * 미션으로만 일하는 앱(선언이 전부 edges[].mission 인 앱)에서는 이 줄이 켜질 데이터 경로가
 * 아예 없었다: 미션 둘이 도는 동안 화면은 조용했고 사용자는 다시 "안 돌고 있는 건가요"를
 * 물어야 했다(실측 2026-08-30). 짝지음은 runtime.ts `isDelegationOf` 한 벌이고, 열거는
 * 대화함과 같은 관용구다(instances.list × session.list).
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
import type { RelayCtx, DelegationRow } from "./runtime";
import { loadDelegationsOf, wireSessionForId, watchServerTurns, livenessOf, livenessLabel, livenessTitle } from "./runtime";
import { ActivePaneCtx } from "./ctx";

/** 위임 행의 이름 — 기계 라벨의 화살표를 떼고 사람 말로.
 *  ChatTabs.subLabel 의 쌍둥이다. import 하지 않는 이유는 순환이다(ChatTabs → Chat → 여기).
 *  a2a 미션의 라벨은 `⇄ <발신> → <미션>` 인데 발신이 곧 이 대화라 되뇌는 말이다 — 떼고 그
 *  자리에 **일하고 있는 앱**을 세운다: 남의 앱에서 돈다는 것이 이 형에서 사람이 알아야 할
 *  단 하나다(눌러서 열 대화도 그쪽에 있다). */
function nameOf(r: DelegationRow, myInstance: string): string {
  const t = (r.title || "").replace(/^[↳⇄]\s*/, "").trim();
  if (r.origin === "mission") {
    const mission = (t.split("→").pop() ?? "").trim() || t;
    return r.instance && r.instance !== myInstance ? `${r.instance} · ${mission}` : mission;
  }
  if (t) return t;
  if (r.agent) return r.param ? `${r.agent} · ${r.param}` : r.agent;
  return r.conversation_id;
}

/** 진행 중인 위임이 화면에 있을 때의 재조회 간격 — 위 주석의 근거 참조. */
const REFRESH_MS = 10_000;
/** 행위 연타 흡수 창. 한 번의 훑기가 인스턴스 수만큼의 조회라(loadDelegationsOf) 종전 1.5초
 *  보다 넓다 — 글을 쓰는 동안 매 1.5초마다 전 인스턴스를 훑을 이유가 없다. 계기가 분명한
 *  갱신(마운트·턴 이벤트·주기 재조회)은 force 로 이 창을 건너뛴다. */
const COALESCE_MS = 4_000;

export function DelegationStrip({ ctx }: { ctx: RelayCtx }) {
  const active = useContext(ActivePaneCtx);
  const [rows, setRows] = useState<DelegationRow[]>([]);
  // 경과 글자를 다시 그리기 위한 지금 — 네트워크와 무관하다
  const [now, setNow] = useState(() => Date.now());
  const inflight = useRef(false);
  const lastProbe = useRef(0);

  const mySlot = wireSessionForId(ctx.conversationId);

  const refresh = useCallback(async (force = false) => {
    if (!ctx.instanceId || !mySlot || inflight.current) return;
    const t = Date.now();
    if (!force && t - lastProbe.current < COALESCE_MS) return;
    lastProbe.current = t;
    inflight.current = true;
    try {
      // 내가 판 위임만. 짝지음도 origin 판정도 기판이 밝힌 축으로만 한다(§5.3-25/26) —
      // 슬롯 접두 스니핑은 금지다
      setRows(await loadDelegationsOf(ctx, mySlot));
      setNow(Date.now());
    } finally {
      inflight.current = false;
    }
  }, [ctx, mySlot]);

  // 계기 구독 — ServerTurnWatch 와 같은 관용구(§5.8: 유휴 폴링 폴백 금지)
  useEffect(() => {
    if (!mySlot) return;
    void refresh(true);
    // 턴 이벤트는 계기가 분명하다 — 위임을 건 턴이 끝나는 순간이 이 줄이 서야 할 바로 그때라
    // 연타 창을 건너뛴다(그러지 않으면 방금 건 위임이 몇 초 동안 없는 것처럼 보인다)
    const unwatch = watchServerTurns(ctx, () => void refresh(true));
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
          <button key={`${r.instance}/${r.conversation_id}`} type="button"
                  title={`${livenessTitle(l)} · 눌러서 이 작업의 대화를 열어요`}
                  className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-[12px] hover:bg-muted"
                  onClick={() => {
                    try {
                      window.dispatchEvent(new CustomEvent("relay:chat-open", {
                        detail: { instance: r.instance, conversation: r.conversation_id },
                      }));
                    } catch { /* 미배선 셸 — 줄은 그대로 정보로 남는다 */ }
                  }}>
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
              {warn
                ? <span className="text-[var(--rc-err)]" aria-hidden>!</span>
                : <Spinner role={undefined} aria-label={undefined} aria-hidden className="text-[var(--rc-accent)] size-3" />}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground/75">{nameOf(r, ctx.instanceId)}</span>
            <span className={cn("shrink-0 tabular-nums text-[11px]", warn ? "text-[var(--rc-err)]" : "text-muted-foreground")}>
              {livenessLabel(l)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

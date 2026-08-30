/* 컨텍스트 미터 — 이 대화가 얼마나 찼는지, 그리고 누르면 줄인다(/compact).
 *
 * 이 컴포넌트는 **되살린 것**이다. shadcn 재작성(0658cba)에서 컴포저 하단 도구줄이 통째로
 * 사라지면서 같이 지워졌고, CSS(.rc-ctx*)와 데이터(reply.context)는 그대로 남아 있었다.
 * 그래서 `/compact` 는 계속 동작했지만 **언제 눌러야 하는지 알 방법이 없었다** — 사용자가
 * 직접 타이핑해야만 했고, 컨텍스트가 찬 것은 답이 이상해진 뒤에야 알았다.
 *
 * 분모는 봉투 실측이다(reply.context.window). 모델 카탈로그 추정은 은퇴했다 —
 * 하네스마다 창 크기가 다르고, 추정한 분모는 조용히 틀린 퍼센트를 만든다.
 */

import { useRef, useState } from "react";
import { useThread, useThreadRuntime } from "@assistant-ui/react";
import { fmtTok } from "./parts";

/** 점유량 = 마지막 본류 스텝의 프롬프트 크기. 출력 토큰은 생성물이지 점유가 아니라 더하지 않는다 */
function ctxTokensOf(u: unknown): number {
  if (!u || typeof u !== "object") return 0;
  const o = u as Record<string, number | undefined>;
  return (o.input_tokens ?? 0) + (o.cache_read_input_tokens ?? 0) + (o.cache_creation_input_tokens ?? 0);
}

export function ContextMeter() {
  const rt = useThreadRuntime();
  // 터치(hover 없음)에선 툴팁 경고를 볼 수 없다 — 첫 탭은 툴팁만 열고 둘째 탭이 실제 압축
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);

  const gauge = useThread((t) => {
    for (let i = t.messages.length - 1; i >= 0; i--) {
      const m = t.messages[i] as { role?: string; metadata?: { custom?: Record<string, unknown> } };
      if (m.role !== "assistant" || !m.metadata?.custom) continue;
      const c = m.metadata.custom;
      // /compact 턴은 assistant 스텝이 없어 점유 0 짜리 축퇴 usage 만 남는다 — 그것을 잡으면
      // 압축 직후 미터가 사라진다. 0 은 건너뛰고 직전 실 스텝까지 훑는다
      const used = ctxTokensOf(c.contextUsage) || ctxTokensOf(c.usage);
      if (used <= 0) continue;
      const window = typeof c.contextWindow === "number" ? c.contextWindow : 0;
      if (window <= 0) return null; // 분모를 모르면 그리지 않는다 — 추정한 %는 틀린 %다
      return { used, window };
    }
    return null;
  });

  if (!gauge) return null;
  const pct = Math.min(100, Math.round((gauge.used / gauge.window) * 100));
  const remain = Math.max(0, 100 - pct);

  const compact = (): void => {
    if (window.matchMedia("(hover: none)").matches && !armedRef.current) {
      armedRef.current = true;
      setArmed(true);
      window.setTimeout(() => { armedRef.current = false; setArmed(false); }, 3000);
      return;
    }
    armedRef.current = false;
    setArmed(false);
    // 컴포저를 거치지 않고 턴으로 직접 넣는다 — 어댑터의 패스스루 판정(isCompactPrompt)은
    // 프롬프트 본문을 보므로 여기로 넣어도 타이핑한 것과 같은 길을 간다
    rt.append({ role: "user", content: [{ type: "text", text: "/compact" }] });
  };

  return (
    <span className={"rc-ctx-wrap" + (armed ? " rc-armed" : "")}>
      <button
        type="button"
        className={"rc-ctx" + (pct >= 85 ? " hot" : pct >= 60 ? " warm" : "")}
        onClick={compact}
        aria-label={`컨텍스트 ${fmtTok(gauge.used)}/${fmtTok(gauge.window)} (${pct}%) — 누르면 기억을 줄입니다`}
      >
        <span className="rc-ctx-ring" style={{ ["--rc-ctx-pct" as string]: `${pct}%` } as React.CSSProperties} aria-hidden />
        <span className="rc-ctx-lb">{pct}%</span>
      </button>
      <span className="rc-ctx-tip" role="tooltip">
        <span className="rc-ctx-tip-h">자동 압축까지 {remain}% 남았습니다.</span>
        <span className="rc-ctx-tip-sub">지금 눌러 기억을 줄일 수 있어요.</span>
        <span className="rc-ctx-tip-num">{fmtTok(gauge.used)}/{fmtTok(gauge.window)} ({pct}%)</span>
      </span>
    </span>
  );
}

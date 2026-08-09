"use client";

/* Edge 연결 다이얼로그 — monitor 의 add-connection 이식.
   결재는 선언을 넘지 못한다: 계약 후보는 consumer relay.yaml edges 선언에서만 나오고,
   제출 즉시 grant 가 활성화되어 선이 지도에 그려진다 */

import { useMemo, useState } from "react";
import { approveGrant, resolveProvider } from "@/lib/api";
import type { Registry } from "@/lib/types";

export interface EdgePrefill {
  consumer?: string;
  provider?: string;
  tools?: string[];
  mission?: string;
}

export default function AddEdgeDialog({
  reg,
  prefill,
  onClose,
  onDone,
}: {
  reg: Registry;
  prefill: EdgePrefill;
  onClose: () => void;
  onDone: () => void;
}) {
  const [consumer, setConsumer] = useState(prefill.consumer ?? "");
  const [provider, setProvider] = useState(prefill.provider ?? "");
  const [transport, setTransport] = useState<"mcp" | "a2a">(prefill.mission ? "a2a" : "mcp");
  const [pick, setPick] = useState<string>(prefill.mission ?? (prefill.tools ? JSON.stringify(prefill.tools) : ""));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const providerPkg = reg.packages.find((p) => p.name === provider);
  const consumerPkg = reg.packages.find((p) => p.name === consumer);
  const consumerName = consumerPkg?.manifest?.display_name ?? consumer;
  const providerName = providerPkg?.manifest?.display_name ?? provider;

  // 계약 후보 = consumer 선언(edges) 중 이 provider 를 가리키는 것들
  const declared = useMemo(() => {
    const c = reg.packages.find((p) => p.name === consumer);
    return (c?.manifest?.edges ?? []).filter((e) => resolveProvider(reg, e.provider) === provider);
  }, [reg, consumer, provider]);

  const mcpDecls = declared.filter((e) => e.tools?.length);
  const a2aDecls = declared.filter((e) => e.mission);
  const missionDesc = (name: string) =>
    providerPkg?.manifest?.missions?.find((m) => m.name === name)?.description ?? "";

  const alreadyGranted = (tools?: string[], mission?: string) =>
    reg.grants.some(
      (g) => g.consumer === consumer && g.provider === provider &&
        (mission ? g.mission === mission : JSON.stringify(g.tools) === JSON.stringify(tools)),
    );

  async function submit() {
    setErr(null);
    if (!consumer || !provider) return setErr("양쪽 프로그램을 모두 선택해 주세요");
    if (consumer === provider) return setErr("같은 프로그램끼리는 연결할 수 없습니다");
    if (!pick) return setErr(transport === "a2a" ? "맡길 일을 선택해 주세요" : "빌릴 도구를 선택해 주세요");
    setBusy(true);
    try {
      await approveGrant({
        consumer,
        provider,
        ...(transport === "a2a" ? { mission: pick } : { tools: JSON.parse(pick) as string[] }),
      });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const options = reg.packages.map((p) => (
    <option key={p.name} value={p.name}>
      {p.manifest?.display_name ?? p.name} ({p.name})
    </option>
  ));

  return (
    <div className="gx-overlay" onClick={onClose}>
      <div className="gx-modal" onClick={(e) => e.stopPropagation()}>
        <h3>프로그램 연결하기</h3>
        <div className="gx-mbody">
          <label className="gx-field">
            <span>도움을 받는 쪽</span>
            <select value={consumer} onChange={(e) => { setConsumer(e.target.value); setPick(""); }}>
              <option value="">프로그램 선택</option>
              {options}
            </select>
          </label>
          <label className="gx-field">
            <span>도움을 주는 쪽</span>
            <select value={provider} onChange={(e) => { setProvider(e.target.value); setPick(""); }}>
              <option value="">프로그램 선택</option>
              {options}
            </select>
          </label>
          <div className="gx-field">
            <span>연결 방식</span>
            <div className="gx-seg">
              <button className={transport === "mcp" ? "on" : ""} onClick={() => { setTransport("mcp"); setPick(""); }}>
                도구 빌려 쓰기
              </button>
              <button className={transport === "a2a" ? "on" : ""} onClick={() => { setTransport("a2a"); setPick(""); }}>
                일 맡기기
              </button>
            </div>
          </div>
          <div className="gx-field">
            <span>{transport === "a2a" ? "맡길 일" : "빌릴 도구"}</span>
            {!consumer || !provider ? (
              <div className="gx-hint">양쪽 프로그램을 먼저 선택해 주세요.</div>
            ) : transport === "a2a" ? (
              a2aDecls.length ? (
                <div className="lv">
                  {a2aDecls.map((e) => (
                    <div key={e.mission} className={`lv-row${pick === e.mission ? " on" : ""}`} onClick={() => setPick(e.mission!)}>
                      <span className="lv-tx">
                        <span className="lv-t">{e.mission}</span>
                        <span className="lv-s">
                          {missionDesc(e.mission!) || "일 맡기기"}
                          {alreadyGranted(undefined, e.mission) ? " · 이미 연결됨" : ""}
                        </span>
                      </span>
                      <span className="lv-ring" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="gx-hint">
                  {consumerName}가 {providerName}에게 일을 맡기겠다고 아직 신청하지 않았습니다.
                  신청이 없으면 승인할 것도 없어요. 패키지 만들기에서 이 연결을 먼저 신청해 주세요.
                </div>
              )
            ) : mcpDecls.length ? (
              <div className="lv">
                {mcpDecls.map((e, i) => {
                  const v = JSON.stringify(e.tools);
                  return (
                    <div key={i} className={`lv-row${pick === v ? " on" : ""}`} onClick={() => setPick(v)}>
                      <span className="lv-tx">
                        <span className="lv-t">{e.tools!.join(", ")}</span>
                        <span className="lv-s">도구 빌려 쓰기{alreadyGranted(e.tools) ? " · 이미 연결됨" : ""}</span>
                      </span>
                      <span className="lv-ring" />
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="gx-hint">
                {consumerName}가 {providerName}의 도구를 쓰겠다고 아직 신청하지 않았습니다.
                신청이 없으면 승인할 것도 없어요. 패키지 만들기에서 이 연결을 먼저 신청해 주세요.
              </div>
            )}
          </div>
          {err ? <div className="gx-err">{err}</div> : null}
          <div className="gx-hint">연결을 누르면 바로 이어지고, 지도에 선으로 표시됩니다. 해제는 카드 상세 화면에서 할 수 있습니다.</div>
        </div>
        <div className="gx-mfoot">
          <button className="rc-btn" onClick={onClose}>취소</button>
          <button className="rc-btn accent" disabled={busy} onClick={() => void submit()}>
            {busy ? "..." : "연결"}
          </button>
        </div>
      </div>
    </div>
  );
}

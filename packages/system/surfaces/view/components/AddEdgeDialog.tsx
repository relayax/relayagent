"use client";

/* Edge 연결 다이얼로그 — monitor 의 add-connection 이식.
   결재는 선언을 넘지 못한다: 계약 후보는 consumer relay.yaml edges 선언에서만 나오고,
   제출 즉시 grant 가 활성화되어 선이 지도에 그려진다 */

import { useMemo, useState } from "react";
import { approveGrant, resolveProvider } from "@/lib/api";
import type { Registry } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";

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
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>프로그램 연결하기</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edge-consumer">도움을 받는 쪽</Label>
            <select id="edge-consumer" value={consumer} onChange={(e) => { setConsumer(e.target.value); setPick(""); }}>
              <option value="">프로그램 선택</option>
              {options}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="edge-provider">도움을 주는 쪽</Label>
            <select id="edge-provider" value={provider} onChange={(e) => { setProvider(e.target.value); setPick(""); }}>
              <option value="">프로그램 선택</option>
              {options}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>연결 방식</Label>
            <div className="gx-seg">
              <button className={transport === "mcp" ? "on" : ""} onClick={() => { setTransport("mcp"); setPick(""); }}>
                도구 빌려 쓰기
              </button>
              <button className={transport === "a2a" ? "on" : ""} onClick={() => { setTransport("a2a"); setPick(""); }}>
                일 맡기기
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>{transport === "a2a" ? "맡길 일" : "빌릴 도구"}</Label>
            {!consumer || !provider ? (
              <p className="text-xs text-muted-foreground">양쪽 프로그램을 먼저 선택해 주세요.</p>
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
                <p className="text-xs text-muted-foreground">
                  {consumerName}가 {providerName}에게 일을 맡기겠다고 아직 신청하지 않았습니다.
                  신청이 없으면 승인할 것도 없어요. 패키지 만들기에서 이 연결을 먼저 신청해 주세요.
                </p>
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
              <p className="text-xs text-muted-foreground">
                {consumerName}가 {providerName}의 도구를 쓰겠다고 아직 신청하지 않았습니다.
                신청이 없으면 승인할 것도 없어요. 패키지 만들기에서 이 연결을 먼저 신청해 주세요.
              </p>
            )}
          </div>
          {err ? <p className="text-sm text-destructive">{err}</p> : null}
          <p className="text-xs text-muted-foreground">연결을 누르면 바로 이어지고, 지도에 선으로 표시됩니다. 해제는 카드 상세 화면에서 할 수 있습니다.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>취소</Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>
            {busy ? "..." : "연결"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

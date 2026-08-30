"use client";

/* 서비스 연결 다이얼로그 — 채널(ChannelDialog)·하네스(HarnessDialog)의 세 번째 자매. 패키지 하나의
   밖으로 나가는 두 형(services[].url = MCP 문, services[].api = REST 베이스)의 auth 를 잇는다.
   폼 자체는 ServiceConnect 가 그린다 — 전 패키지 연결 화면(app/connections)과 같은 폼이다.
   여기는 그 패키지의 서비스 목록과 펼침만 맡는다 */

import { useCallback, useEffect, useState } from "react";
import ServiceConnect, { serviceStatusOf } from "@/components/ServiceConnect";
import { serviceStatus, type ServiceStatusView, type TlsDoorView } from "@/lib/api";
import type { Pkg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export default function ServiceDialog({
  pkg,
  onClose,
  onChanged,
}: {
  pkg: Pkg;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [services, setServices] = useState<ServiceStatusView[]>([]);
  const [canDisconnect, setCanDisconnect] = useState(false);
  // 문 상태는 이 다이얼로그도 자기 조회로 받는다 — 콘솔 연결 화면과 같은 답이어야 한다
  const [tls, setTls] = useState<TlsDoorView>({ open: false, port: null, error: null, canTrust: false });
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await serviceStatus(pkg.name);
      setServices(r.services);
      setCanDisconnect(r.canDisconnect);
      setTls(r.tls);
      setOpen((cur) => cur ?? (r.services.length === 1 ? r.services[0].name : null));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [pkg.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const changed = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>서비스 연결 · {pkg.manifest?.display_name ?? pkg.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          {err ? <p className="text-sm text-destructive">{err}</p> : null}
          {services.length === 0 ? (
            <p className="text-xs text-muted-foreground">이 패키지에는 자격이 필요한 서비스(services[].url · services[].api)가 없습니다.</p>
          ) : (
            <div className="lv">
              {services.map((s) => {
                const st = serviceStatusOf(s, note[s.name]);
                const expanded = open === s.name;
                return (
                  <div key={s.name}>
                    <div className="lv-row" onClick={() => setOpen(expanded ? null : s.name)}>
                      <span className="lv-ic">{s.name.slice(0, 1).toUpperCase()}</span>
                      <span className="lv-tx">
                        <span className="lv-t">
                          {s.name}
                          <span style={{ color: "var(--rc-faint)", font: "11px var(--rc-ui)" }}>
                            {" "}· {s.form === "api" ? "REST" : "MCP"} · {s.kind}{s.kind !== "none" ? (s.required ? " · 필요" : " · 선택") : ""}
                          </span>
                        </span>
                        <span className="lv-s"><span style={{ color: st.color }}>{st.dot}</span> {st.text}</span>
                      </span>
                    </div>
                    {expanded ? (
                      <ServiceConnect
                        pkg={pkg.name}
                        s={s}
                        tls={tls}
                        canDisconnect={canDisconnect}
                        onChanged={changed}
                        onNote={(msg) => setNote((n) => ({ ...n, [s.name]: msg }))}
                      />
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <Button variant="outline" size="sm" className="self-start" onClick={() => void load()}>
            다시 점검
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

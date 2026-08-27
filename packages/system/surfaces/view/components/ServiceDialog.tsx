"use client";

/* 서비스 연결 다이얼로그 — 채널(ChannelDialog)·하네스(HarnessDialog)의 세 번째 자매.
   다루는 축은 밖으로 나가는 두 형(services[].url = MCP 문, services[].api = REST 베이스)의
   auth 다: 패키지의 동사가 남의 몸(Notion·ERP…)을 부를 때 기판이 붙이는 자격.

   앞의 둘과 결정적으로 다른 점: 이 자격은 **자식 프로세스에 안 나간다**. 동사가
   ctx.service(name).call() 을 부르면 기판이 헤더를 조립한다 — 그래서 화면도 "값을 넣는 곳"이
   아니라 "연결됐는가"를 보는 곳이다.

   두 갈래를 한 화면에서 그린다:
     token  붙여넣기 → 저장 → 검증        (채널과 같은 모양)
     oauth  인가 흐름 → 브라우저 왕복 → 폴링  (하네스 headless 로그인과 같은 모양) */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  serviceStatus,
  connectService,
  verifyService,
  disconnectService,
  startServiceOAuth,
  serviceOAuthStatus,
  type ServiceStatusView,
} from "@/lib/api";
import type { Pkg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 3-상태 점 — 채널과 같은 어휘. 색이 상태의 축이다 */
function statusOf(s: ServiceStatusView, note?: string): { dot: string; color: string; text: string } {
  if (s.kind === "none") return { dot: "○", color: "var(--rc-faint)", text: "자격이 필요 없는 서비스" };
  if (s.oauth?.running) return { dot: "●", color: "#d97706", text: note ?? "브라우저에서 승인을 기다리는 중…" };
  if (!s.hasCred) return { dot: "○", color: "var(--rc-faint)", text: note ?? "연결되지 않음" };
  if (s.oauth?.done && s.oauth.error) return { dot: "●", color: "var(--rc-err)", text: s.oauth.error };
  return { dot: "●", color: "#16a34a", text: note ?? (s.verifiable ? "연결됨 · 검증 가능" : "연결됨 · 기판이 검증할 수 없는 서비스") };
}

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
  const [open, setOpen] = useState<string | null>(null);
  const [token, setToken] = useState<Record<string, string>>({});
  const [clientId, setClientId] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await serviceStatus(pkg.name);
      setServices(r.services);
      setCanDisconnect(r.canDisconnect);
      setOpen((cur) => cur ?? (r.services.length === 1 ? r.services[0].name : null));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [pkg.name]);

  useEffect(() => {
    void load();
  }, [load]);

  // 진행 중인 인가 흐름이 있으면 폴링한다 — 브라우저 왕복은 사람의 속도라 응답을 붙들 수 없다
  useEffect(() => {
    const running = services.find((s) => s.oauth?.running);
    if (!running) {
      if (poll.current) { clearInterval(poll.current); poll.current = null; }
      return;
    }
    if (poll.current) return;
    poll.current = setInterval(() => {
      void (async () => {
        try {
          const st = await serviceOAuthStatus(pkg.name, running.name);
          if (st.done) {
            setNoteFor(running.name, st.ok ? "연결됨" : `인가 실패: ${st.error ?? "사유 없음"}`);
            await load();
            onChanged();
          }
        } catch { /* 폴링 실패는 다음 틱에 다시 본다 */ }
      })();
    }, 1500);
    return () => {
      if (poll.current) { clearInterval(poll.current); poll.current = null; }
    };
  }, [services, pkg.name, load, onChanged]);

  const setNoteFor = (name: string, msg: string) => setNote((n) => ({ ...n, [name]: msg }));

  async function connect(s: ServiceStatusView) {
    const t = (token[s.name] ?? "").trim();
    if (busy || !t) return;
    setBusy(true);
    setErr(null);
    setNoteFor(s.name, "저장 중...");
    try {
      await connectService(pkg.name, s.name, t);
      // 저장 → 검증. 검증 불가 선언이면 저장까지가 기판이 할 수 있는 전부다(정직하게 알린다)
      if (s.verifiable) {
        setNoteFor(s.name, "검증 중...");
        const v = await verifyService(pkg.name, s.name);
        setNoteFor(s.name, v.ok ? `연결됨 · ${v.note}` : `저장은 됐지만 자격이 먹히지 않습니다: ${v.note}`);
      } else {
        setNoteFor(s.name, "저장됨 — 이 서비스는 auth.verify 를 선언하지 않아 기판이 유효를 판정할 수 없습니다");
      }
      setToken((x) => ({ ...x, [s.name]: "" }));
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function authorize(s: ServiceStatusView) {
    if (busy) return;
    const cid = (clientId[s.name] ?? "").trim();
    if (s.client === "registered" && !cid) return;
    setBusy(true);
    setErr(null);
    setNoteFor(s.name, "브라우저를 여는 중...");
    try {
      await startServiceOAuth(pkg.name, s.name, cid || undefined);
      setNoteFor(s.name, "브라우저에서 승인을 기다리는 중…");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setNoteFor(s.name, "");
    }
    setBusy(false);
  }

  async function verify(name: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setNoteFor(name, "검증 중...");
    try {
      const v = await verifyService(pkg.name, name);
      setNoteFor(name, v.ok ? `유효 · ${v.note}` : `무효: ${v.note}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function disconnect(name: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await disconnectService(pkg.name, name);
      setNoteFor(name, "연결 해제됨");
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

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
            <div className={`lv${busy ? " busy" : ""}`}>
              {services.map((s) => {
                const st = statusOf(s, note[s.name]);
                const expanded = open === s.name;
                return (
                  <div key={s.name}>
                    <div className="lv-row" onClick={() => setOpen(expanded ? null : s.name)}>
                      <span className="lv-ic">{s.name.slice(0, 1).toUpperCase()}</span>
                      <span className="lv-tx">
                        <span className="lv-t">
                          {s.name}
                          <span style={{ color: "var(--rc-faint)", font: "11px var(--rc-ui)" }}> · {s.form === "api" ? "REST" : "MCP"} · {s.kind}</span>
                        </span>
                        <span className="lv-s"><span style={{ color: st.color }}>{st.dot}</span> {st.text}</span>
                      </span>
                    </div>
                    {expanded ? (
                      <div className="lv-in" style={{ flexDirection: "column", gap: 8 }}>
                        <p className="text-xs text-muted-foreground font-mono">{s.url}</p>
                        {s.tools.length ? (
                          <p className="text-xs text-muted-foreground">
                            여는 동사: {s.tools.join(" · ")}
                          </p>
                        ) : null}

                        {s.kind === "token" ? (
                          <Input
                            type="password"
                            autoComplete="off"
                            spellCheck={false}
                            placeholder="토큰 붙여넣기"
                            value={token[s.name] ?? ""}
                            onChange={(e) => setToken((x) => ({ ...x, [s.name]: e.target.value }))}
                            className="font-mono text-xs"
                          />
                        ) : null}

                        {s.kind === "oauth" && s.client === "registered" ? (
                          <div className="flex flex-col gap-1.5">
                            <Label htmlFor={`svc-${s.name}-client`} className="text-xs text-muted-foreground">
                              등록된 앱의 client_id<span className="text-destructive"> *</span>
                              <span className="text-muted-foreground"> · 이 서비스는 자동 등록(DCR)을 지원하지 않습니다</span>
                            </Label>
                            <Input
                              id={`svc-${s.name}-client`}
                              autoComplete="off"
                              spellCheck={false}
                              value={clientId[s.name] ?? ""}
                              onChange={(e) => setClientId((x) => ({ ...x, [s.name]: e.target.value }))}
                              className="font-mono text-xs"
                            />
                          </div>
                        ) : null}

                        {s.help ? (
                          <p className="text-xs text-muted-foreground">
                            {s.help.note}
                            {s.help.url ? (
                              <>
                                {" "}
                                <a href={s.help.url} target="_blank" rel="noreferrer">발급처 열기</a>
                              </>
                            ) : null}
                          </p>
                        ) : null}

                        <div className="flex flex-wrap gap-1.5">
                          {s.kind === "token" ? (
                            <Button size="sm" disabled={busy || !(token[s.name] ?? "").trim()} onClick={() => void connect(s)}>
                              연결 (저장·검증)
                            </Button>
                          ) : null}
                          {s.kind === "oauth" ? (
                            <Button
                              size="sm"
                              disabled={busy || s.oauth?.running || (s.client === "registered" && !(clientId[s.name] ?? "").trim())}
                              onClick={() => void authorize(s)}
                              title="브라우저가 열립니다 — 승인하면 자동으로 연결됩니다"
                            >
                              {s.hasCred ? "다시 인가" : "인가 시작"}
                            </Button>
                          ) : null}
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || !s.hasCred || !s.verifiable}
                            onClick={() => void verify(s.name)}
                            title={s.verifiable ? "저장된 자격이 실제로 먹히는지 확인" : "auth.verify 미선언 — 기판이 판정할 수 없습니다"}
                          >
                            검증
                          </Button>
                          {canDisconnect ? (
                            <Button variant="outline" size="sm" disabled={busy || !s.hasCred} onClick={() => void disconnect(s.name)}>
                              연결 해제
                            </Button>
                          ) : null}
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void load()}>
            다시 점검
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

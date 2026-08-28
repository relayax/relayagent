"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import ChannelDialog from "@/components/ChannelDialog";
import ServiceConnect, { serviceStatusOf } from "@/components/ServiceConnect";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fetchConnections, type ChannelStatusView, type ConnectionsOverview, type ServiceStatusView } from "@/lib/api";
import type { Pkg } from "@/lib/types";

// 연결 — 설치된 것 전부의 자격 전경. 어느 앱의 화면도 아니라 콘솔 패키지의 페이지로 서고(기판 셸의
// 사이드바 [연결]·홈 배너·패키지 화면의 /connect 딥링크가 여기로 온다), 본문은 기판의 /connections
// 한 방이다 — 사이드바 배지와 같은 집계라 두 화면이 다른 수를 말하지 않는다.
//
// 채널과 서비스는 성질이 다른 두 문이라 **두 섹션**이다. 바깥 서비스는 내가 나가는 문(기판이 자격을
// 쥐고, "연결됨" = 자격이 먹힌다)이라 이 자리에서 바로 잇는다. 창구(채널)는 사람이 들어오는 문
// (어댑터가 자격을 쥐고, "연결됨" = 듣고 있다)이라 재기동까지 한 흐름인 채널 운영 다이얼로그로 보낸다.
// 서비스 안에서도 필수·선택을 가른다 — 배지에 세어지는 것은 "필요"(필수인데 빈 것)뿐이다.
// ?p=<패키지>&s=<서비스> 는 그 줄을 펼쳐 둔다(딥링크의 착지).
export default function ConnectionsPage() {
  return (
    <Suspense fallback={<div className="console" />}>
      <Connections />
    </Suspense>
  );
}

type Row = { pkg: ConnectionsOverview["packages"][number]; s: ServiceStatusView };

function Connections() {
  const sp = useSearchParams();
  const focusPkg = sp.get("p");
  const focusSvc = sp.get("s");
  const [ov, setOv] = useState<ConnectionsOverview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(focusPkg && focusSvc ? `${focusPkg}/${focusSvc}` : null);
  const [note, setNote] = useState<Record<string, string>>({});
  const [chanDlg, setChanDlg] = useState<Pkg | null>(null);

  const load = useCallback(async () => {
    try {
      setOv(await fetchConnections());
      setErr(null);
    } catch (e) {
      setErr(`기판에 닿지 않습니다: ${e instanceof Error ? e.message : e}`);
    }
  }, []);

  useEffect(() => {
    void load();
    const onVis = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  // 자격이 바뀌면 이 화면도, 사이드바 배지도 다시 읽는다(relay:nav-refresh 는 셸 스크립트가 듣는다)
  const changed = useCallback(() => {
    void load();
    try { window.dispatchEvent(new CustomEvent("relay:nav-refresh")); } catch { /* 무시 */ }
  }, [load]);

  const rows = useMemo(() => {
    const need: Row[] = [];
    const optional: Row[] = [];
    const done: Row[] = [];
    for (const pkg of ov?.packages ?? []) {
      for (const s of pkg.services) {
        if (s.kind === "none" || s.hasCred) done.push({ pkg, s });
        else if (s.required) need.push({ pkg, s });
        else optional.push({ pkg, s });
      }
    }
    return { need, optional, done };
  }, [ov]);
  const channels = useMemo(
    () => (ov?.packages ?? []).flatMap((pkg) => pkg.channels.map((c) => ({ pkg, c }))),
    [ov],
  );
  const broken = (ov?.packages ?? []).filter((p) => p.error);
  const nothing = ov && !rows.need.length && !rows.optional.length && !rows.done.length && !channels.length;

  const chipOf = (c: ChannelStatusView): { label: string; variant: "secondary" | "outline" | "destructive" } =>
    !c.hasCred ? { label: "자격 없음", variant: "destructive" } : c.lastError ? { label: "오류", variant: "destructive" } : c.running ? { label: "듣는 중", variant: "secondary" } : { label: "끊김", variant: "outline" };

  const Section = ({ title, hint, items }: { title: string; hint: string; items: Row[] }) =>
    items.length ? (
      <section className="flex flex-col gap-2">
        <div className="rc-label">{title} · {items.length}</div>
        <p className="hint">{hint}</p>
        <div className="lv">
          {items.map(({ pkg, s }) => {
            const key = `${pkg.pkg}/${s.name}`;
            const st = serviceStatusOf(s, note[key]);
            const expanded = open === key;
            return (
              <div key={key}>
                <div className="lv-row" onClick={() => setOpen(expanded ? null : key)}>
                  <span className="lv-ic">{pkg.icon ? <img src={pkg.icon} alt="" /> : pkg.label.slice(0, 1)}</span>
                  <span className="lv-tx">
                    <span className="lv-t">
                      {pkg.label}
                      <span style={{ color: "var(--rc-faint)", font: "11px var(--rc-ui)" }}> · {s.name} · {s.form === "api" ? "REST" : "MCP"} · {s.kind}</span>
                    </span>
                    <span className="lv-s"><span style={{ color: st.color }}>{st.dot}</span> {st.text}</span>
                  </span>
                  {s.kind !== "none" ? <Badge variant={s.required ? "secondary" : "outline"}>{s.required ? "필수" : "선택"}</Badge> : null}
                </div>
                {expanded ? (
                  <ServiceConnect
                    pkg={pkg.pkg}
                    s={s}
                    canDisconnect
                    onChanged={changed}
                    onNote={(msg) => setNote((n) => ({ ...n, [key]: msg }))}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </section>
    ) : null;

  return (
    <div className="console">
      {err ? <div className="banner">{err}</div> : null}
      <section className="pane">
        <header className="pane-head">
          <h2>연결</h2>
          <span className="meta">바깥 서비스와 창구의 자격 — 한 자리에서 잇습니다. 키 값은 여기서만 넣고, 앱 화면은 이리로 안내만 합니다</span>
          <div className="right">
            <Button variant="outline" size="sm" onClick={() => void load()}>다시 점검</Button>
          </div>
        </header>
        <div className="pane-body">
          {!ov && !err ? <div className="pane-body center"><span className="rc-ring" /></div> : null}
          {nothing ? (
            <div className="rc-card pad">
              <p className="hint">자격이 필요한 바깥 서비스나 창구를 가진 앱이 아직 없습니다. 앱이 바깥 서비스(services[].url · api)나 채널을 선언하면 여기에 섭니다.</p>
            </div>
          ) : null}

          {broken.length ? (
            <div className="rc-card pad">
              {broken.map((p) => (
                <p key={p.pkg} className="hint" style={{ color: "var(--rc-err)" }}>{p.pkg}: 판정 실패 — {p.error}</p>
              ))}
            </div>
          ) : null}

          <Section title="바깥 서비스 — 연결 필요" hint="없으면 그 앱의 주 기능이 서지 않는 자격입니다. 사이드바 배지가 이 수를 셉니다." items={rows.need} />
          <Section title="바깥 서비스 — 선택" hint="없어도 앱은 돕니다. 넣으면 그 기능이 켜집니다 — 무엇이 켜지는지는 각 줄의 안내가 말합니다." items={rows.optional} />
          <Section title="바깥 서비스 — 연결됨" hint="자격이 앉아 있는 것들. 검증으로 실제로 먹히는지 확인하거나, 연결 해제로 지웁니다." items={rows.done} />

          {channels.length ? (
            <section className="flex flex-col gap-2">
              <div className="rc-label">창구(채널) · {channels.length}</div>
              <p className="hint">사람이 들어오는 문(슬랙·디스코드 …). 어댑터가 자격을 쥐고 듣습니다 — 자격을 바꾸면 재기동까지 한 흐름이라 채널 운영 창에서 잇습니다.</p>
              <div className="lv">
                {channels.map(({ pkg, c }) => {
                  const chip = chipOf(c);
                  return (
                    <div key={`${pkg.pkg}/${c.name}`} className="lv-row" onClick={() => setChanDlg({ name: pkg.pkg, path: "", workspace: "", ring: null, model: null, harness: null, manifest: { display_name: pkg.label }, error: null })}>
                      <span className="lv-ic">{c.icon ? <img src={`/pkg/${encodeURIComponent(pkg.pkg)}/asset/${c.icon}`} alt="" /> : c.name.slice(0, 1).toUpperCase()}</span>
                      <span className="lv-tx">
                        <span className="lv-t">
                          {pkg.label}
                          <span style={{ color: "var(--rc-faint)", font: "11px var(--rc-ui)" }}> · {c.name} · 채널</span>
                        </span>
                        <span className="lv-s">{c.lastError ?? (c.hasCred ? (c.running ? `듣는 중${c.pid ? ` · pid ${c.pid}` : ""}` : "자격은 있으나 상주가 떠 있지 않습니다") : "자격 없음 — 눌러서 연결하세요")}</span>
                      </span>
                      <Badge variant={chip.variant}>{chip.label}</Badge>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </section>
      {chanDlg ? <ChannelDialog pkg={chanDlg} onClose={() => setChanDlg(null)} onChanged={changed} /> : null}
    </div>
  );
}

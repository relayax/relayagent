"use client";

/* 채널 운영 다이얼로그 — 하네스 설정(HarnessDialog)의 자매. 저작(스튜디오의 source/entry
   편집)이 아니라 운영이다: 지금 살아있는가, 자격은 먹히는가, 왜 죽었는가.
   자격 수명주기 3동사(relayos connections 축소): connect(저장) · verify(실왕복) · restart. */

import { useCallback, useEffect, useState } from "react";
import { channelStatus, connectChannel, verifyChannel, restartChannel, type ChannelStatusView } from "@/lib/api";
import type { Pkg } from "@/lib/types";

/** 3-상태 점 — 자격 없음(○) / 저장됨·미검증·죽음(●) / 연결됨(●). 색이 상태의 축이다 */
function statusOf(c: ChannelStatusView): { dot: string; color: string; text: string } {
  if (!c.hasCred) return { dot: "○", color: "var(--rc-faint)", text: "자격 없음 — 연결하세요" };
  if (c.lastError) return { dot: "●", color: "var(--rc-err)", text: c.lastError };
  if (c.running) return { dot: "●", color: "#16a34a", text: `연결됨${c.pid ? ` · pid ${c.pid}` : ""}` };
  return { dot: "●", color: "#d97706", text: "저장됨 · 미검증" };
}

export default function ChannelDialog({
  pkg,
  onClose,
  onChanged,
}: {
  pkg: Pkg;
  onClose: () => void;
  onChanged: () => void;
}) {
  const asset = (rel: string) => `/pkg/${encodeURIComponent(pkg.name)}/asset/${rel}`;
  const [channels, setChannels] = useState<ChannelStatusView[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [cred, setCred] = useState("");
  const [note, setNote] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await channelStatus(pkg.name);
      setChannels(r.channels);
      // 채널이 하나뿐이면 자동으로 펼친다 — 흔한 경우의 클릭 하나를 아낀다
      setOpen((cur) => cur ?? (r.channels.length === 1 ? r.channels[0].name : null));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [pkg.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const setNoteFor = (ch: string, msg: string) => setNote((n) => ({ ...n, [ch]: msg }));

  // 연결 = 저장 → 검증 → (유효면) 재기동. "저장됨 ≠ 유효" 를 한 흐름으로 정직히 그린다
  async function connect(ch: string) {
    if (busy || !cred.trim()) return;
    setBusy(true);
    setErr(null);
    setNoteFor(ch, "저장 중...");
    try {
      await connectChannel(pkg.name, ch, cred.trim());
      setNoteFor(ch, "검증 중...");
      const v = await verifyChannel(pkg.name, ch);
      if (v.ok) {
        await restartChannel(pkg.name, ch);
        setNoteFor(ch, `연결됨 · ${v.note}`);
        setCred("");
      } else {
        setNoteFor(ch, `저장은 됐지만 자격이 먹히지 않습니다: ${v.note}`);
      }
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function verify(ch: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setNoteFor(ch, "검증 중...");
    try {
      const v = await verifyChannel(pkg.name, ch);
      setNoteFor(ch, v.ok ? `유효 · ${v.note}` : `무효: ${v.note}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function restart(ch: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setNoteFor(ch, "재기동 중...");
    try {
      const r = await restartChannel(pkg.name, ch);
      setNoteFor(ch, r.running ? "재기동됨" : "재기동했으나 상주가 뜨지 않았습니다 — 로그를 확인하세요");
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  return (
    <div className="gx-overlay" onClick={onClose}>
      <div className="gx-modal" onClick={(e) => e.stopPropagation()}>
        <h3>채널 · {pkg.manifest?.display_name ?? pkg.name}</h3>
        <div className="gx-mbody">
          {err ? <div className="gx-err">{err}</div> : null}
          {channels.length === 0 ? (
            <div className="gx-hint">이 패키지에는 선언된 채널이 없습니다.</div>
          ) : (
            <div className={`lv${busy ? " busy" : ""}`}>
              {channels.map((c) => {
                const s = statusOf(c);
                const expanded = open === c.name;
                return (
                  <div key={c.name}>
                    <div className="lv-row" onClick={() => setOpen(expanded ? null : c.name)}>
                      <span className="lv-ic">{c.icon ? <img src={asset(c.icon)} alt="" /> : c.name.slice(0, 1).toUpperCase()}</span>
                      <span className="lv-tx">
                        <span className="lv-t">{c.name}</span>
                        <span className="lv-s"><span style={{ color: s.color }}>{s.dot}</span> {note[c.name] ?? s.text}</span>
                      </span>
                    </div>
                    {expanded ? (
                      <div className="lv-in" style={{ flexDirection: "column", gap: 8 }}>
                        <textarea
                          rows={3}
                          placeholder={'자격 붙여넣기 — 어댑터가 정한 형태 그대로 (예: {"app_token":"xapp-…","bot_token":"xoxb-…","allow":["U…"]})'}
                          value={cred}
                          onChange={(e) => setCred(e.target.value)}
                          style={{ width: "100%", font: "12px var(--rc-mono)", resize: "vertical" }}
                        />
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <button className="rc-btn accent" disabled={busy || !cred.trim()} onClick={() => void connect(c.name)}>
                            연결 (저장·검증·재기동)
                          </button>
                          <button className="rc-btn" disabled={busy || !c.hasCred} onClick={() => void verify(c.name)} title="저장된 자격이 실제로 먹히는지 확인">
                            검증
                          </button>
                          <button className="rc-btn" disabled={busy || !c.hasCred} onClick={() => void restart(c.name)}>
                            재기동
                          </button>
                        </div>
                        {c.lastError ? <div className="gx-err">{c.lastError}</div> : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <button className="rc-btn" style={{ alignSelf: "flex-start" }} disabled={busy} onClick={() => void load()}>
            다시 점검
          </button>
        </div>
      </div>
    </div>
  );
}

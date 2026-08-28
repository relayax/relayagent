"use client";

/* 서비스 하나의 연결 폼 — 패키지 단위 다이얼로그(ServiceDialog)와 전 패키지 연결 화면(app/connections)이
   **같은 폼**을 쓴다. 두 자리에서 따로 그리면 칸의 조립 규칙이 갈라진다.

   채널(ChannelDialog)과 결정적으로 다른 점: 이 자격은 **자식 프로세스에 안 나간다**. 동사가
   ctx.service(name).fetch() 를 부르면 기판이 헤더를 조립한다 — 그래서 이 폼은 "값을 넣는 곳"이자
   "연결됐는가"를 보는 곳이지, 프로세스를 재기동하는 곳이 아니다. 두 갈래를 한 폼에서 그린다:
     token  칸(auth.fields)대로 입력 → 저장 → 검증        (칸 어휘는 채널과 한 벌)
     oauth  인가 흐름 → 브라우저 왕복 → 폴링                (하네스 headless 로그인과 같은 모양)
   조립은 기판이 한다(runtime/credential.ts) — 화면은 칸별 값을 보내고, 빈 필수 칸은 400 으로 돌아온다 */

import { useEffect, useRef, useState } from "react";
import {
  connectService,
  verifyService,
  disconnectService,
  startServiceOAuth,
  serviceOAuthStatus,
  type ServiceStatusView,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 3-상태 점 — 채널과 같은 어휘. 색이 상태의 축이다. 서비스의 "연결됨" 은 자격이 앉아 있다는 뜻이지
 *  프로세스가 떠 있다는 뜻이 아니다(그건 채널의 말) */
export function serviceStatusOf(s: ServiceStatusView, note?: string): { dot: string; color: string; text: string } {
  if (s.kind === "none") return { dot: "○", color: "var(--rc-faint)", text: "자격이 필요 없는 서비스" };
  if (s.oauth?.running) return { dot: "●", color: "#d97706", text: note ?? "브라우저에서 승인을 기다리는 중…" };
  if (!s.hasCred) {
    return s.required
      ? { dot: "○", color: "var(--rc-err)", text: note ?? "자격 없음 · 필요 — 없으면 이 앱의 주 기능이 서지 않습니다" }
      : { dot: "○", color: "var(--rc-faint)", text: note ?? "자격 없음 · 선택 — 없어도 돌고, 넣으면 그 기능이 켜집니다" };
  }
  if (s.oauth?.done && s.oauth.error) return { dot: "●", color: "var(--rc-err)", text: s.oauth.error };
  return { dot: "●", color: "#16a34a", text: note ?? (s.verifiable ? "연결됨 · 검증 가능" : "연결됨 · 기판이 검증할 수 없는 서비스") };
}

export default function ServiceConnect({
  pkg,
  s,
  canDisconnect,
  onChanged,
  onNote,
}: {
  pkg: string;
  s: ServiceStatusView;
  canDisconnect: boolean;
  /** 자격이 바뀌었다 — 부르는 쪽이 상태를 다시 읽는다 */
  onChanged: () => void;
  /** 진행 문구 — 목록 줄의 상태 자리에 올려 보낸다 */
  onNote: (msg: string) => void;
}) {
  const keyed = !!s.fields?.length && s.fields.every((f) => f.key != null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  // 진행 중인 인가 흐름이 있으면 폴링한다 — 브라우저 왕복은 사람의 속도라 응답을 붙들 수 없다
  useEffect(() => {
    if (!s.oauth?.running) {
      if (poll.current) { clearInterval(poll.current); poll.current = null; }
      return;
    }
    if (poll.current) return;
    poll.current = setInterval(() => {
      void (async () => {
        try {
          const st = await serviceOAuthStatus(pkg, s.name);
          if (st.done) {
            onNote(st.ok ? "연결됨" : `인가 실패: ${st.error ?? "사유 없음"}`);
            onChanged();
          }
        } catch { /* 폴링 실패는 다음 틱에 다시 본다 */ }
      })();
    }, 1500);
    return () => {
      if (poll.current) { clearInterval(poll.current); poll.current = null; }
    };
  }, [s.oauth?.running, pkg, s.name, onChanged, onNote]);

  /** 연결 버튼이 살아 있는 조건 — 선언된 필수 칸(required, 그리고 header 는 언제나)이 다 찼는가 */
  const ready = keyed
    ? s.fields!.every((f) => !(f.required || f.header) || (vals[f.key!] ?? "").trim().length > 0)
    : token.trim().length > 0;

  async function connect() {
    if (busy || !ready) return;
    setBusy(true);
    setErr(null);
    onNote("저장 중...");
    try {
      await connectService(pkg, s.name, keyed ? { fields: vals } : { token: token.trim() });
      // 저장 → 검증. 검증 불가 선언이면 저장까지가 기판이 할 수 있는 전부다(정직하게 알린다)
      if (s.verifiable) {
        onNote("검증 중...");
        const v = await verifyService(pkg, s.name);
        onNote(v.ok ? `연결됨 · ${v.note}` : `저장은 됐지만 자격이 먹히지 않습니다: ${v.note}`);
      } else {
        onNote("저장됨 — 이 서비스는 auth.verify 를 선언하지 않아 기판이 유효를 판정할 수 없습니다");
      }
      setVals({});
      setToken("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function authorize() {
    if (busy) return;
    const cid = clientId.trim();
    if (s.client === "registered" && !cid) return;
    setBusy(true);
    setErr(null);
    onNote("브라우저를 여는 중...");
    try {
      await startServiceOAuth(pkg, s.name, cid || undefined);
      onNote("브라우저에서 승인을 기다리는 중…");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      onNote("");
    }
    setBusy(false);
  }

  async function verify() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    onNote("검증 중...");
    try {
      const v = await verifyService(pkg, s.name);
      onNote(v.ok ? `유효 · ${v.note}` : `무효: ${v.note}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function disconnect() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await disconnectService(pkg, s.name);
      onNote("연결 해제됨");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const fieldId = (k: string) => `svc-${pkg}-${s.name}-${k}`;

  return (
    <div className={`lv-in${busy ? " busy" : ""}`} style={{ flexDirection: "column", gap: 8 }}>
      {err ? <p className="text-sm text-destructive">{err}</p> : null}
      <p className="text-xs text-muted-foreground font-mono">{s.url}</p>
      {s.tools.length ? <p className="text-xs text-muted-foreground">남에게 raw 로 빌려줄 수 있는 도구: {s.tools.join(" · ")}</p> : null}

      {s.kind === "token" && keyed
        ? s.fields!.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId(f.key!)} className="text-xs text-muted-foreground">
                {f.label}
                {f.required || f.header ? <span className="text-destructive"> *</span> : null}
                {f.header ? <span className="text-muted-foreground"> · 인증 헤더로 나가는 칸</span> : null}
                {f.list ? <span className="text-muted-foreground"> · 쉼표로 구분</span> : null}
              </Label>
              <Input
                id={fieldId(f.key!)}
                type={f.secret || f.header ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={f.placeholder}
                value={vals[f.key!] ?? ""}
                onChange={(e) => setVals((x) => ({ ...x, [f.key!]: e.target.value }))}
                className="font-mono text-xs"
              />
            </div>
          ))
        : null}
      {s.kind === "token" && !keyed ? (
        <Input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={s.fields?.[0]?.placeholder ?? `${s.fields?.[0]?.label ?? "토큰"} 붙여넣기`}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="font-mono text-xs"
        />
      ) : null}

      {s.kind === "oauth" && s.client === "registered" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("client")} className="text-xs text-muted-foreground">
            등록된 앱의 client_id<span className="text-destructive"> *</span>
            <span className="text-muted-foreground"> · 이 서비스는 자동 등록(DCR)을 지원하지 않습니다</span>
          </Label>
          <Input id={fieldId("client")} autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-xs" />
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
          <Button size="sm" disabled={busy || !ready} onClick={() => void connect()}>
            연결 (저장·검증)
          </Button>
        ) : null}
        {s.kind === "oauth" ? (
          <Button
            size="sm"
            disabled={busy || s.oauth?.running || (s.client === "registered" && !clientId.trim())}
            onClick={() => void authorize()}
            title="브라우저가 열립니다 — 승인하면 자동으로 연결됩니다"
          >
            {s.hasCred ? "다시 인가" : "인가 시작"}
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !s.hasCred || !s.verifiable}
          onClick={() => void verify()}
          title={s.verifiable ? "저장된 자격이 실제로 먹히는지 확인" : "auth.verify 미선언 — 기판이 판정할 수 없습니다"}
        >
          검증
        </Button>
        {canDisconnect ? (
          <Button variant="outline" size="sm" disabled={busy || !s.hasCred} onClick={() => void disconnect()}>
            연결 해제
          </Button>
        ) : null}
      </div>
    </div>
  );
}

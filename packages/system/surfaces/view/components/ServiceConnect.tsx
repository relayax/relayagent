"use client";

/* 서비스 하나의 연결 폼 — 패키지 단위 다이얼로그(ServiceDialog)와 전 패키지 연결 화면(app/connections)이
   **같은 폼**을 쓴다. 두 자리에서 따로 그리면 칸의 조립 규칙이 갈라진다.

   채널(ChannelDialog)과 결정적으로 다른 점: 이 자격은 **자식 프로세스에 안 나간다**. 동사가
   ctx.service(name).fetch() 를 부르면 기판이 자격을 붙인다 — 그래서 이 폼은 "값을 넣는 곳"이자
   "연결됐는가"를 보는 곳이지, 프로세스를 재기동하는 곳이 아니다. 두 갈래를 한 폼에서 그린다:
     token  칸(auth.fields)대로 입력 → 저장 → 검증        (칸 어휘는 채널과 한 벌)
     oauth  인가 흐름 → 브라우저 왕복 → 폴링                (하네스 headless 로그인과 같은 모양)
   조립은 기판이 한다(runtime/credential.ts) — 화면은 칸별 값을 보내고, 빈 필수 칸은 400 으로 돌아온다.

   계정 축(auth.accounts)이 선언된 서비스는 **자격이 여럿**이다. 그러면 이 폼은 목록이 된다: 앉아 있는
   계정마다 한 줄(검증·해제), 그리고 같은 폼을 다시 여는 "계정 추가" 하나. 축이 없는 서비스는 종전 그대로 —
   화면이 두 벌로 갈리지 않도록 같은 컴포넌트가 두 모양을 그린다 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  connectService,
  verifyService,
  disconnectService,
  startServiceOAuth,
  serviceOAuthStatus,
  openTlsDoor,
  moveTlsDoor,
  trustTlsCert,
  type ServiceStatusView,
  type TlsDoorView,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** 3-상태 점 — 채널과 같은 어휘. 색이 상태의 축이다. 서비스의 "연결됨" 은 자격이 앉아 있다는 뜻이지
 *  프로세스가 떠 있다는 뜻이 아니다(그건 채널의 말). 계정 축이 있으면 "몇 계정이 앉아 있는가"가 그 자리에 온다 */
export function serviceStatusOf(s: ServiceStatusView, note?: string): { dot: string; color: string; text: string } {
  if (s.kind === "none") return { dot: "○", color: "var(--rc-faint)", text: "자격이 필요 없는 서비스" };
  const running = s.oauth?.running || s.accounts?.some((a) => a.oauth?.running);
  if (running) return { dot: "●", color: "var(--rc-warn)", text: note ?? "브라우저에서 승인을 기다리는 중…" };
  if (!s.hasCred) {
    const what = s.accounts ? "연결된 계정 없음" : "자격 없음";
    return s.required
      ? { dot: "○", color: "var(--rc-err)", text: note ?? `${what} · 필요 — 없으면 이 앱의 주 기능이 서지 않습니다` }
      : { dot: "○", color: "var(--rc-faint)", text: note ?? `${what} · 선택 — 없어도 돌고, 넣으면 그 기능이 켜집니다` };
  }
  if (s.oauth?.done && s.oauth.error) return { dot: "●", color: "var(--rc-err)", text: s.oauth.error };
  if (s.accounts) return { dot: "●", color: "var(--rc-ok)", text: note ?? `계정 ${s.accounts.length}개 연결됨 — ${s.accounts.map((a) => a.name).join(" · ")}` };
  return { dot: "●", color: "var(--rc-ok)", text: note ?? (s.verifiable ? "연결됨 · 검증 가능" : "연결됨 · 기판이 검증할 수 없는 서비스") };
}

export default function ServiceConnect({
  pkg,
  s,
  tls,
  canDisconnect,
  onChanged,
  onNote,
}: {
  pkg: string;
  s: ServiceStatusView;
  /** 기판의 TLS 문 — HTTPS 콜백을 요구하는 제공자에게 줄 주소가 여기서 난다.
   *  화면에 스위치는 없다: 문은 조건 없이 열리고, 이 값은 상태와 못 연 사유다 */
  tls: TlsDoorView;
  canDisconnect: boolean;
  /** 자격이 바뀌었다 — 부르는 쪽이 상태를 다시 읽는다 */
  onChanged: () => void;
  /** 진행 문구 — 목록 줄의 상태 자리에 올려 보낸다 */
  onNote: (msg: string) => void;
}) {
  const multi = s.accounts != null;
  const [adding, setAdding] = useState(!multi);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 인가 흐름은 사람의 속도로 흐른다 — 지금 지켜보는 좌표(계정 축이면 그 계정, 아니면 "")를 폴링한다.
  // 새 계정의 인가는 성공해야 색인에 오르므로 전경(s.accounts)만 봐서는 진행을 볼 수 없다
  const [watching, setWatching] = useState<string | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (poll.current) {
      clearInterval(poll.current);
      poll.current = null;
    }
  }, []);

  useEffect(() => {
    if (watching == null) return stop();
    if (poll.current) return;
    poll.current = setInterval(() => {
      void (async () => {
        try {
          const st = await serviceOAuthStatus(pkg, s.name, watching || undefined);
          if (st.done) {
            setWatching(null);
            stop();
            onNote(st.ok ? "연결됨" : `인가 실패: ${st.error ?? "사유 없음"}`);
            if (st.ok) setAdding(!multi);
            onChanged();
          }
        } catch { /* 폴링 실패는 다음 틱에 다시 본다 */ }
      })();
    }, 1500);
    return stop;
  }, [watching, pkg, s.name, multi, onChanged, onNote, stop]);

  async function act(what: string, fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setErr(null);
    if (what) onNote(what);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const verify = (account?: string) =>
    act("검증 중...", async () => {
      const v = await verifyService(pkg, s.name, account);
      onNote(v.ok ? `유효 · ${v.note}` : `무효: ${v.note}`);
    });

  const disconnect = (account?: string) =>
    act("", async () => {
      await disconnectService(pkg, s.name, account);
      onNote(account ? `${account} 연결 해제됨` : "연결 해제됨");
      onChanged();
    });

  return (
    <div className={`lv-in${busy ? " busy" : ""}`} style={{ flexDirection: "column", gap: 8 }}>
      {err ? <p className="text-sm text-destructive">{err}</p> : null}
      <p className="text-xs text-muted-foreground font-mono">{s.url}</p>
      {s.inject !== "header" ? (
        <p className="text-xs text-muted-foreground">
          이 서비스의 자격은 인증 헤더가 아니라 {s.inject === "query" ? "질의 파라미터" : "폼 파라미터"}로 나갑니다 — 기판이 요청마다 붙입니다.
        </p>
      ) : null}
      {s.tools.length ? <p className="text-xs text-muted-foreground">남에게 raw 로 빌려줄 수 있는 도구: {s.tools.join(" · ")}</p> : null}

      {/* 앉아 있는 계정들 — 계정 축이 선언된 서비스만. 자격은 계정마다 하나이고 검증·해제도 계정 단위다 */}
      {multi && s.accounts!.length ? (
        <div className="lv">
          {s.accounts!.map((a) => (
            <div key={a.name} className="lv-row" style={{ cursor: "default" }}>
              <span className="lv-tx">
                <span className="lv-t">{a.name}</span>
                <span className="lv-s">
                  <span style={{ color: a.oauth?.running ? "var(--rc-warn)" : "var(--rc-ok)" }}>●</span>{" "}
                  {a.oauth?.running ? "브라우저에서 승인을 기다리는 중…" : "자격 앉음"}
                </span>
              </span>
              <span className="flex gap-1.5">
                <Button variant="outline" size="sm" disabled={busy || !s.verifiable} onClick={() => void verify(a.name)}>검증</Button>
                {canDisconnect ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void disconnect(a.name)}>해제</Button> : null}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {multi && !adding ? (
        <Button variant="outline" size="sm" className="self-start" onClick={() => { setErr(null); setAdding(true); }}>
          + 계정 {s.accounts!.length ? "추가" : "연결"}
        </Button>
      ) : null}

      {adding ? (
        <CredentialForm
          pkg={pkg}
          s={s}
          tls={tls}
          multi={multi}
          busy={busy}
          onCancel={multi ? () => setAdding(false) : undefined}
          onNote={onNote}
          onChanged={onChanged}
          onError={setErr}
          setBusy={setBusy}
          onWatch={setWatching}
          onDone={() => setAdding(!multi)}
        />
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

      {!multi ? (
        <div className="flex flex-wrap gap-1.5">
          <Button variant="outline" size="sm" disabled={busy || !s.hasCred || !s.verifiable} onClick={() => void verify()} title={s.verifiable ? "저장된 자격이 실제로 먹히는지 확인" : "auth.verify 미선언 — 기판이 판정할 수 없습니다"}>
            검증
          </Button>
          {canDisconnect ? (
            <Button variant="outline" size="sm" disabled={busy || !s.hasCred} onClick={() => void disconnect()}>연결 해제</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 자격 하나를 넣는 폼 — 계정 축이면 "이 계정의 자격", 아니면 "이 서비스의 자격". 두 갈래(token·oauth)가
 *  같은 폼 안에 산다: 넣는 값의 모양만 다르고 넣는 자리는 하나다 */
function CredentialForm({
  pkg,
  s,
  tls,
  multi,
  busy,
  onCancel,
  onNote,
  onChanged,
  onError,
  setBusy,
  onWatch,
  onDone,
}: {
  pkg: string;
  s: ServiceStatusView;
  tls: TlsDoorView;
  multi: boolean;
  busy: boolean;
  onCancel?: () => void;
  onNote: (msg: string) => void;
  onChanged: () => void;
  onError: (msg: string | null) => void;
  setBusy: (v: boolean) => void;
  onWatch: (account: string | null) => void;
  onDone: () => void;
}) {
  const keyed = !!s.fields?.length && s.fields.every((f) => f.key != null);
  const [vals, setVals] = useState<Record<string, string>>({});
  const [token, setToken] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [account, setAccount] = useState("");
  const [copied, setCopied] = useState(false);
  const fieldId = (k: string) => `svc-${pkg}-${s.name}-${k}`;
  // HTTPS 를 요구하는 제공자인데 기판이 줄 주소가 없다 — 문이 안 섰다는 뜻이다(기판은 그 형에
  // http 주소를 대신 주지 않는다: 인가를 시작해 봐야 제공자가 "주소 불일치"로 되돌리고, 그 답에는
  // 사유가 없어 원인이 안 읽힌다). 먼저 말하고, 아래에서 **처방**까지 준다
  const needsTls = s.https && !s.callback;
  const accountOk = !multi || /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(account.trim());

  /** 연결 버튼이 살아 있는 조건 — 선언된 필수 칸(required, 그리고 header 는 언제나)이 다 찼는가 */
  const filled = keyed
    ? s.fields!.every((f) => !(f.required || f.header) || (vals[f.key!] ?? "").trim().length > 0)
    : token.trim().length > 0;
  const ready = accountOk && (s.kind === "oauth" ? (s.fields ?? []).every((f) => !f.required || (vals[f.key!] ?? "").trim().length > 0) : filled);

  async function guard(fn: () => Promise<void>): Promise<void> {
    if (busy || !ready) return;
    setBusy(true);
    onError(null);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const connect = () =>
    guard(async () => {
      onNote("저장 중...");
      await connectService(pkg, s.name, {
        ...(keyed ? { fields: vals } : { token: token.trim() }),
        ...(multi ? { account: account.trim() } : {}),
      });
      // 저장 → 검증. 검증 불가 선언이면 저장까지가 기판이 할 수 있는 전부다(정직하게 알린다)
      if (s.verifiable) {
        onNote("검증 중...");
        const v = await verifyService(pkg, s.name, multi ? account.trim() : undefined);
        onNote(v.ok ? `연결됨 · ${v.note}` : `저장은 됐지만 자격이 먹히지 않습니다: ${v.note}`);
      } else {
        onNote("저장됨 — 이 서비스는 auth.verify 를 선언하지 않아 기판이 유효를 판정할 수 없습니다");
      }
      setVals({});
      setToken("");
      setAccount("");
      onDone();
      onChanged();
    });

  const authorize = () =>
    guard(async () => {
      onNote("브라우저를 여는 중...");
      const at = multi ? account.trim() : "";
      await startServiceOAuth(pkg, s.name, {
        ...(clientId.trim() ? { client_id: clientId.trim() } : {}),
        ...(clientSecret.trim() ? { client_secret: clientSecret.trim() } : {}),
        ...(at ? { account: at } : {}),
        ...(s.fields?.length ? { fields: vals } : {}),
      });
      onNote("브라우저에서 승인을 기다리는 중…");
      onWatch(at);
      onChanged();
    });

  return (
    <div className="flex flex-col gap-2">
      {multi ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={fieldId("account")} className="text-xs text-muted-foreground">
            계정 이름<span className="text-destructive"> *</span>
            <span className="text-muted-foreground"> · 이 자격을 부를 이름입니다 (영문·숫자·._-)</span>
          </Label>
          <Input id={fieldId("account")} autoComplete="off" spellCheck={false} value={account} onChange={(e) => setAccount(e.target.value)} className="font-mono text-xs" placeholder="brand-main" />
        </div>
      ) : null}

      {s.kind === "token" && keyed
        ? s.fields!.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId(f.key!)} className="text-xs text-muted-foreground">
                {f.label}
                {f.required || f.header ? <span className="text-destructive"> *</span> : null}
                {f.header ? <span className="text-muted-foreground"> · 자격으로 나가는 칸</span> : null}
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

      {/* oauth 의 부속 칸 — 로그인이 주지 않는 값(계정 번호·저장소 좌표). 인가와 함께 번들에 앉는다 */}
      {s.kind === "oauth" && s.fields?.length
        ? s.fields.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId(f.key!)} className="text-xs text-muted-foreground">
                {f.label}
                {f.required ? <span className="text-destructive"> *</span> : null}
                <span className="text-muted-foreground"> · 로그인이 주지 않는 값입니다</span>
              </Label>
              <Input
                id={fieldId(f.key!)}
                type={f.secret ? "password" : "text"}
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

      {s.kind === "oauth" && s.client === "registered" ? (
        <>
          {s.callback ? (
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">
                제공자 앱에 적을 콜백 주소(redirect_uri) — 이 주소가 그대로 적혀 있어야 인가가 돌아옵니다
              </Label>
              <div className="bar">
                <Input readOnly value={s.callback} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-none"
                  onClick={() => {
                    void navigator.clipboard?.writeText(s.callback!).then(() => setCopied(true)).catch(() => setCopied(false));
                  }}
                >
                  {copied ? "복사됨" : "복사"}
                </Button>
              </div>
              {s.https ? <SelfSignedNote canTrust={tls.canTrust} /> : null}
            </div>
          ) : needsTls ? (
            <TlsPrescription tls={tls} onOpened={onChanged} />
          ) : null}
          {!s.clientId ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={fieldId("client")} className="text-xs text-muted-foreground">
                등록된 앱의 client_id<span className="text-destructive"> *</span>
                <span className="text-muted-foreground"> · 이 서비스는 자동 등록(DCR)을 지원하지 않습니다</span>
              </Label>
              <Input id={fieldId("client")} autoComplete="off" spellCheck={false} value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-xs" />
            </div>
          ) : null}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fieldId("secret")} className="text-xs text-muted-foreground">
              등록된 앱의 client_secret
              <span className="text-muted-foreground"> · 공개 클라이언트(PKCE 만 쓰는 앱)면 비워 두세요</span>
            </Label>
            <Input id={fieldId("secret")} type="password" autoComplete="off" spellCheck={false} value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} className="font-mono text-xs" />
          </div>
        </>
      ) : null}

      <div className="flex flex-wrap gap-1.5">
        {s.kind === "token" ? (
          <Button size="sm" disabled={busy || !ready} onClick={() => void connect()}>
            {multi ? "이 계정 연결 (저장·검증)" : "연결 (저장·검증)"}
          </Button>
        ) : null}
        {s.kind === "oauth" ? (
          <Button
            size="sm"
            disabled={busy || !ready || needsTls || (s.client === "registered" && !s.clientId && !clientId.trim())}
            onClick={() => void authorize()}
            title={needsTls ? "HTTPS 콜백이 필요합니다" : "브라우저가 열립니다 — 승인하면 자동으로 연결됩니다"}
          >
            {multi ? "이 계정 인가" : s.hasCred ? "다시 인가" : "인가 시작"}
          </Button>
        ) : null}
        {onCancel ? <Button variant="ghost" size="sm" disabled={busy} onClick={onCancel}>취소</Button> : null}
      </div>
    </div>
  );
}

/** 문이 못 섰을 때의 처방 — 여기 있는 것은 **스위치가 아니다**. 문은 기동 때 조건 없이 열리고
 *  (runner/tls.ts 머리 주석: 선언으로 여닫으면 설치·제거가 남의 등록 주소를 갈아친다), 이 자리는
 *  "왜 못 섰는지"와 그것을 되돌릴 두 행위만 든다.
 *
 *  포트 이동을 기판이 스스로 하지 않는 이유가 여기 그대로 적힌다: 포트는 콜백 주소의 일부이고
 *  그 주소는 제공자 앱에 등록된 상수다. 기판이 조용히 옮기면 등록해 둔 인가가 전부 깨진다 —
 *  그래서 옮기는 것은 사람이 누르는 행위이고, 누를 때 그 대가를 함께 읽는다. */
function TlsPrescription({ tls, onOpened }: { tls: TlsDoorView; onOpened: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [port, setPort] = useState("");

  const run = (fn: () => Promise<{ open: boolean; error: string | null }>) => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    void fn()
      .then((d) => { if (!d.open) setErr(d.error ?? "사유 미상"); onOpened(); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-destructive">
        이 제공자는 HTTPS 콜백을 요구하는데 기판의 보안 문이 서지 않았습니다 — {err ?? tls.error ?? "사유 미상"}
      </p>
      <div className="bar">
        <Button variant="outline" size="sm" disabled={busy} onClick={() => run(openTlsDoor)}>
          {busy ? "여는 중…" : "다시 시도"}
        </Button>
        <Input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="다른 포트"
          inputMode="numeric"
          className="font-mono text-xs"
        />
        <Button
          variant="outline"
          size="sm"
          className="flex-none"
          disabled={busy || !/^\d{1,5}$/.test(port.trim())}
          title="등록해 둔 콜백 주소를 전부 이 포트로 고쳐야 합니다"
          onClick={() => run(() => moveTlsDoor(Number(port.trim())))}
        >
          이 포트로 옮기기
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        포트를 옮기면 콜백 주소가 바뀝니다 — 이미 제공자 앱에 등록해 둔 주소가 있으면 그것도 함께 고쳐야 합니다.
      </p>
    </div>
  );
}

/** 자가서명 경고에 대한 미리 알림 — 사용자가 승인 창의 경고에서 "내가 뭘 잘못했나" 하고 멈추는
 *  것을 없애는 것이 이 문장의 일이다. 신뢰 등록은 **선택**이라 버튼은 옆에 서고, 이 기판이 못
 *  하는 판(macOS 아님)에서는 아예 안 그린다 — 못 하는 것을 눌리게 두지 않는다. */
function SelfSignedNote({ canTrust }: { canTrust: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        기판이 스스로 구운 인증서라 승인 창에서 브라우저가 한 번 경고합니다 — <b>계속</b>을 누르면 연결은 정상입니다
        (제공자는 주소만 대조하지 인증서를 검사하지 않습니다).
      </p>
      {canTrust ? (
        <div className="bar">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            title="이 기기의 키체인에 넣습니다 — OS 인증 창이 뜹니다. 안 해도 연결은 됩니다"
            onClick={() => {
              setBusy(true);
              setNote(null);
              void trustTlsCert()
                .then(() => setNote("이 기기에서 신뢰됨 — 다음부터는 경고가 없습니다"))
                .catch((e) => setNote(e instanceof Error ? e.message : String(e)))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "등록 중…" : "이 기기에서 신뢰"}
          </Button>
          {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

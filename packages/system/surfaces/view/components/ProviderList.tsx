"use client";

/* AI 제공사 — 연결 센터의 세 번째 축. 서비스·채널과 달리 **패키지 소속이 아니다**:
 * 자격 좌표가 `llm/<provider>` 라 앱을 가리지 않고 공유된다.
 *
 * 목록의 출처는 기판이 아니라 **어댑터들**이다. 기판은 어떤 provider 가 세상에 있는지 모르고,
 * 알면 안 된다 — 새 하네스가 들어올 때마다 기판을 고쳐야 하는 형이 되고 그것이 하네스 중립을
 * 정확히 뒤집는다. 어댑터가 자기를 말하고(provider·auth 선언) 이 화면은 그것을 모을 뿐이다.
 *
 * 연결 버튼은 자격형에 따라 두 갈래다:
 *  · token  — 금고에 키를 넣는다. 이 화면에서 완결된다.
 *  · oauth  — 도구 자신의 로그인. 기판은 그 대화를 중계할 뿐이다(HarnessLogin).
 */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import HarnessLogin from "@/components/HarnessLogin";
import { connectProvider, disconnectProvider, type ProviderStatusView } from "@/lib/api";

export default function ProviderList({
  providers,
  /** oauth 로그인을 발화할 패키지 — 로그인 동사는 어댑터의 것이고 어댑터는 패키지 좌표로 실행된다.
   *  provider 는 앱을 안 가리지만 **그 provider 를 대는 어댑터를 가진 앱**이 하나는 있어야 한다 */
  loginPkg,
  onChanged,
}: {
  providers: ProviderStatusView[];
  loginPkg: string | null;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [login, setLogin] = useState<ProviderStatusView | null>(null);

  if (!providers.length) {
    return (
      <section className="flex flex-col gap-2">
        <div className="rc-label">AI 제공사</div>
        <p className="hint">쓸 수 있는 AI 엔진이 아직 없습니다. 기판 어댑터 풀이 비어 있고 설치된 앱도 하네스를 동봉하지 않았습니다.</p>
      </section>
    );
  }

  const save = async (p: ProviderStatusView) => {
    setBusy(true);
    setErr(null);
    try {
      await connectProvider(p.provider, token);
      setToken("");
      setOpen(null);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  const forget = async (p: ProviderStatusView) => {
    setBusy(true);
    setErr(null);
    try {
      await disconnectProvider(p.provider);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  };

  return (
    <section className="flex flex-col gap-2">
      <div className="rc-label">AI 제공사 · {providers.length}</div>
      <p className="hint">
        에이전트를 움직이는 AI 엔진의 자격입니다. 앱마다 따로 넣지 않습니다 — 여기 한 번 이으면 이 제공사를 쓰는 모든 앱이 씁니다.
      </p>
      <div className="lv">
        {providers.map((p) => {
          const expanded = open === p.provider;
          return (
            <div key={p.provider}>
              <div className="lv-row" onClick={() => { setOpen(expanded ? null : p.provider); setErr(null); }}>
                <span className="lv-ic">{p.icon ? <img src={p.icon} alt="" /> : p.provider.slice(0, 1).toUpperCase()}</span>
                <span className="lv-tx">
                  <span className="lv-t">{p.provider}</span>
                  <span className="lv-s">
                    {p.kind === "oauth" ? "구독 로그인" : p.kind === "token" ? "API 키" : "자격 선언 없음"}
                    {" · "}
                    {p.harnesses.join(", ")}
                    {p.origin === "bundled" ? " · 앱이 데려온 하네스" : ""}
                  </span>
                </span>
                <Badge variant={p.hasCred ? "secondary" : "outline"}>{p.hasCred ? "연결됨" : "연결 안 됨"}</Badge>
              </div>

              {expanded ? (
                <div className="flex flex-col gap-2 px-3 pb-3">
                  {p.help?.note ? <p className="hint">{p.help.note}</p> : null}
                  {p.help?.url ? (
                    <a className="text-xs underline" href={p.help.url} target="_blank" rel="noreferrer">자격을 얻는 곳 ↗</a>
                  ) : null}

                  {p.kind === "token" ? (
                    <div className="flex gap-2">
                      <Input
                        type="password"
                        placeholder={`${p.provider} API 키 붙여넣기 (안전한 금고에 저장됩니다)`}
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter" && token.trim()) void save(p); }}
                      />
                      <Button variant="outline" size="sm" disabled={busy || !token.trim()} onClick={() => void save(p)}>연결</Button>
                    </div>
                  ) : p.kind === "oauth" ? (
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" disabled={busy || !loginPkg} onClick={() => setLogin(p)}>
                        {p.hasCred ? "다시 로그인" : "로그인"}
                      </Button>
                      {!loginPkg ? (
                        <span className="hint">이 제공사를 쓰는 앱이 아직 설치되지 않아 로그인을 발화할 수 없습니다.</span>
                      ) : (
                        <span className="hint">도구 자신의 로그인입니다 — 기판은 그 대화를 중계할 뿐 토큰을 보지 않습니다.</span>
                      )}
                    </div>
                  ) : (
                    <p className="hint">이 어댑터는 자격 형태를 선언하지 않았습니다 — 도구 자신의 기존 로그인을 그대로 씁니다.</p>
                  )}

                  {p.hasCred ? (
                    <div>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => void forget(p)}>연결 해제</Button>
                    </div>
                  ) : null}
                  {err ? <p className="text-sm text-destructive">{err}</p> : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {login && loginPkg ? (
        <HarnessLogin
          pkg={loginPkg}
          label={login.provider}
          variant={login.harnesses[0]}
          switchAccount={login.hasCred}
          onClose={() => setLogin(null)}
          onDone={() => onChanged()}
        />
      ) : null}
    </section>
  );
}

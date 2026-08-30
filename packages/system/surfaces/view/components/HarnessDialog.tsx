"use client";

/* 하네스 설정 다이얼로그 — 채팅 위젯 설정 시트의 그래프판.
   선택 UI 는 providers 리스트 패턴: 행 = 아이콘 + 제목/부제, 우측 선택 링.
   probe 로 variant 전수를 실제 실행해 행마다 준비 상태·계정을 보여주고,
   미준비 활성 어댑터에는 처방(token 입력 또는 터미널 로그인 명령)을 연다 */

import { useCallback, useEffect, useState } from "react";
import { connectHarness, getHarness, installHarnessTool, harnessModels, setHarnessActive, setModel, type HarnessVariantView } from "@/lib/api";
import HarnessLogin from "@/components/HarnessLogin";
import type { Pkg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function HarnessDialog({
  pkg,
  onClose,
  onChanged,
}: {
  pkg: Pkg;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [variants, setVariants] = useState<HarnessVariantView[]>([]);
  // 풀 어댑터의 아이콘은 패키지 아래 있지 않다 — 기판이 절대 주소로 실어 보내고, 그건 그대로 쓴다
  const asset = (rel: string) => (rel.startsWith("/") ? rel : `/pkg/${encodeURIComponent(pkg.name)}/asset/${rel}`);
  const [active, setActive] = useState<string | null>(pkg.harness);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModelState] = useState<string | null>(pkg.model);
  const [freeOpen, setFreeOpen] = useState(false);
  const [free, setFree] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 열려 있는 로그인 대화 — null 이면 닫힘. switch 는 계정 전환 */
  const [login, setLogin] = useState<{ variant: string; switch: boolean } | null>(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [h, m] = await Promise.all([getHarness(pkg.name, true), harnessModels(pkg.name)]);
      setVariants(h.variants);
      setActive(h.active);
      setModels(Array.isArray(m.value) ? m.value : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [pkg.name]);

  useEffect(() => {
    void load();
  }, [load]);

  async function switchHarness(name: string) {
    if (busy || name === active) return;
    setBusy(true);
    setNote("전환 중...");
    try {
      const r = await setHarnessActive(pkg.name, name);
      setNote(`지금 사용: ${r.active} · ${r.setup.ok ? "준비됨" : "준비 안 됨"}`);
      // 모델 어휘는 하네스 소속이다. 전환하면 새 어댑터 소관으로 리셋된다
      setModelState(null);
      await load();
      onChanged();
    } catch (e) {
      setNote("");
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function applyModel(m: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      const r = await setModel(pkg.name, m);
      setModelState(r.model);
      setNote(
        r.model && r.known === false
          ? `적용됨: ${r.model} · 엔진 목록에 없는 모델이라 대화가 실패할 수 있습니다`
          : `적용됨: ${r.model || "자동"}`,
      );
      setFreeOpen(false);
      setFree("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function connectToken() {
    if (busy || !token.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await connectHarness(pkg.name, token.trim());
      setNote(r.ok ? "연결됐습니다. 사용할 준비가 됐습니다" : `열쇠는 저장됐지만 아직 준비되지 않았습니다: ${r.setup.out.split("\n")[0]}`);
      setToken("");
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  // 로그인은 이제 앱 안에서 끝난다 — 대화창이 어댑터의 출력을 보여주고 입력을 넣는다.
  // 종전에는 여기서 응답의 launched·note·command 를 읽었는데 기본 경로(headless)의 응답에는
  // 그 셋이 없어 화면에 `undefined — undefined` 가 떴다(계약 두 갈래를 한 모양으로 읽었다)
  function doLogin(sw = false) {
    if (busy || !activeV) return;
    setErr(null);
    setNote("");
    setLogin({ variant: activeV.name, switch: sw });
  }

  // "도구 없음" 의 처방 — 자동 설치는 진작 있었고 부를 문만 없었다
  async function doInstall() {
    if (busy || !activeV) return;
    setBusy(true);
    setErr(null);
    setNote("도구를 설치하는 중… (수백 MB 를 받을 수 있습니다)");
    try {
      const r = await installHarnessTool(pkg.name, activeV.name);
      setNote(r.out || (r.ok ? "설치했습니다" : "설치하지 못했습니다"));
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setNote("");
    }
    setBusy(false);
  }

  const activeV = variants.find((v) => v.name === active) ?? null;
  // 저자가 verified 를 아예 선언하지 않았으면 "미검증" 을 붙이지 않는다(모두가 미검증이면 무의미하다)
  const anyVerified = variants.some((v) => v.verified);
  const loginCmd = `relay login ${pkg.name}`;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>AI 엔진 · {pkg.manifest?.display_name ?? pkg.name}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label>이 에이전트를 움직이는 AI 프로그램</Label>
            {variants.length ? (
              <div className={`lv${busy ? " busy" : ""}`}>
                {variants.map((v) => (
                  <div key={v.name} className={`lv-row${active === v.name ? " on" : ""}`} onClick={() => void switchHarness(v.name)}>
                    <span className="lv-ic">{v.icon ? <img src={asset(v.icon)} alt="" /> : v.name.slice(0, 1).toUpperCase()}</span>
                    <span className="lv-tx">
                      <span className="lv-t">{v.name}</span>
                      <span className="lv-s">
                        {v.provider ?? "자체 로그인"}
                        {v.ready != null ? (v.ready ? " · 준비됨" : " · 준비 안 됨") : ""}
                        {v.account?.email ? ` · ${v.account.email}${v.account.plan ? ` (${v.account.plan})` : ""}` : ""}
                        {/* 저자가 돌려본 것과 안 돌려본 것은 다르다 — 막지는 않고 표시만 한다.
                            선언이 아예 없는 앱(대부분)은 아무 말도 하지 않는다: 모른다는 것과
                            안 된다는 것을 뭉뚱그리면 그 표시가 잠금처럼 읽힌다 */}
                        {anyVerified ? (v.verified ? " · 저자 검증" : " · 미검증") : ""}
                      </span>
                    </span>
                    <span className="lv-ring" />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">이 프로그램에는 선택할 AI 엔진이 없습니다.</p>
            )}
            {activeV && activeV.ready === false ? (
              <div className="flex flex-col gap-1.5">
                {activeV.note ? <p className="text-sm text-destructive">{activeV.note}</p> : null}
                {activeV.reason === "no-tool" ? (
                  // 종전에는 이 분기가 null 이라 "codex CLI 없음" 이라고만 뜨고 설치 버튼도
                  // 명령도 없는 막다른 길이었다 — 기판은 진작 깔 수 있었고 문만 없었다
                  <div className="lv-in">
                    <Button size="sm" disabled={busy || !activeV.binary} onClick={() => void doInstall()}>
                      도구 설치
                    </Button>
                    <span className="text-xs text-muted-foreground self-center">
                      {activeV.binary ? "기판이 자기 자리에 깔고 이 앱에만 씁니다" : "이 하네스는 기판이 대신 깔 도구를 선언하지 않았습니다 — 직접 설치한 뒤 다시 점검하세요"}
                    </span>
                  </div>
                ) : activeV.auth === "token" ? (
                  <div className="lv-in">
                    <Input
                      type="password"
                      placeholder={`${activeV.provider ?? ""} API 토큰 붙여넣기 (안전한 금고에 저장됩니다)`}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && token.trim()) void connectToken();
                      }}
                    />
                    <Button variant="outline" size="sm" disabled={busy || !token.trim()} onClick={() => void connectToken()}>
                      연결
                    </Button>
                  </div>
                ) : activeV.login ? (
                  // 대화형 로그인: 인증은 터미널(TTY)이 소유하지만 그 창을 여는 것은 기판이 한다
                  <div className="lv-in">
                    <Button size="sm" disabled={busy} onClick={() => void doLogin()}>
                      로그인
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(loginCmd);
                        setNote(`복사됨: ${loginCmd}`);
                      }}
                    >
                      명령 복사
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {activeV && activeV.ready === true ? (
              // 준비됐다고 자격이 잠기면 안 된다 — 계정 전환·토큰 교체는 상시 열려 있어야 한다
              <div className="flex flex-col gap-1.5">
                {activeV.login ? (
                  <div className="lv-in">
                    <Button variant="outline" size="sm" disabled={busy} onClick={() => void doLogin(true)}>
                      계정 전환
                    </Button>
                    <span className="text-xs text-muted-foreground self-center">다른 계정으로 다시 로그인합니다</span>
                  </div>
                ) : activeV.auth === "token" ? (
                  <div className="lv-in">
                    <Input
                      type="password"
                      placeholder={`${activeV.provider ?? "provider"} 토큰 교체`}
                      value={token}
                      onChange={(e) => setToken(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && token.trim()) void connectToken();
                      }}
                    />
                    <Button variant="outline" size="sm" disabled={busy || !token.trim()} onClick={() => void connectToken()}>
                      교체
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            <Button variant="outline" size="sm" className="self-start" disabled={busy} onClick={() => void load()}>
              다시 점검
            </Button>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>모델</Label>
            {(() => {
              const llmIcon = variants.find((v) => v.name === active)?.llm_icon ?? null;
              const mic = llmIcon ? <span className="lv-ic"><img src={asset(llmIcon)} alt="" /></span> : null;
              return (
            <div className={`lv${busy ? " busy" : ""}`}>
              <div className={`lv-row${!model ? " on" : ""}`} onClick={() => void applyModel(null)}>
                {mic}
                <span className="lv-tx">
                  <span className="lv-t">자동</span>
                  <span className="lv-s">엔진이 알아서 고릅니다</span>
                </span>
                <span className="lv-ring" />
              </div>
              {models.map((m) => (
                <div key={m} className={`lv-row${model === m ? " on" : ""}`} onClick={() => void applyModel(m)}>
                  {mic}
                  <span className="lv-tx">
                    <span className="lv-t">{m}</span>
                  </span>
                  <span className="lv-ring" />
                </div>
              ))}
              {model && !models.includes(model) ? (
                <div className="lv-row on">
                  {mic}
                  <span className="lv-tx">
                    <span className="lv-t">{model}</span>
                    <span className="lv-s">직접 입력한 모델</span>
                  </span>
                  <span className="lv-ring" />
                </div>
              ) : null}
              {freeOpen ? (
                <div className="lv-in">
                  <Input
                    autoFocus
                    placeholder="모델 ID 직접 입력"
                    value={free}
                    onChange={(e) => setFree(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && free.trim()) void applyModel(free.trim());
                      if (e.key === "Escape") setFreeOpen(false);
                    }}
                  />
                  <Button variant="outline" size="sm" disabled={busy || !free.trim()} onClick={() => void applyModel(free.trim())}>
                    적용
                  </Button>
                </div>
              ) : (
                <div className="lv-row lv-add" onClick={() => setFreeOpen(true)}>
                  <b>+</b> 직접 입력
                </div>
              )}
            </div>
              );
            })()}
          </div>

          {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
          {err ? <p className="text-sm text-destructive">{err}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>닫기</Button>
        </DialogFooter>
      </DialogContent>
      {login ? (
        <HarnessLogin
          pkg={pkg.name}
          label={login.variant}
          variant={login.variant}
          switchAccount={login.switch}
          onClose={() => setLogin(null)}
          onDone={() => void load()}
        />
      ) : null}
    </Dialog>
  );
}

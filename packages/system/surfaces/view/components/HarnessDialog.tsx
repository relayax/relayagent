"use client";

/* 하네스 설정 다이얼로그 — 채팅 위젯 설정 시트의 그래프판.
   선택 UI 는 providers 리스트 패턴: 행 = 아이콘 + 제목/부제, 우측 선택 링.
   probe 로 variant 전수를 실제 실행해 행마다 준비 상태·계정을 보여주고,
   미준비 활성 어댑터에는 처방(token 입력 또는 터미널 로그인 명령)을 연다 */

import { useCallback, useEffect, useState } from "react";
import { connectHarness, getHarness, loginHarness, harnessModels, setHarnessActive, setModel, type HarnessVariantView } from "@/lib/api";
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
  const asset = (rel: string) => `/pkg/${encodeURIComponent(pkg.name)}/asset/${rel}`;
  const [active, setActive] = useState<string | null>(pkg.harness);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModelState] = useState<string | null>(pkg.model);
  const [freeOpen, setFreeOpen] = useState(false);
  const [free, setFree] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function doLogin(sw = false) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setNote("터미널 창을 여는 중...");
    try {
      const r = await loginHarness(pkg.name, sw);
      setNote(r.launched ? "터미널 창에서 로그인을 마친 뒤 다시 점검을 누르세요" : `${r.note} — ${r.command}`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setNote("");
    }
    setBusy(false);
  }

  const activeV = variants.find((v) => v.name === active) ?? null;
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
                {activeV.reason === "no-tool" ? null : activeV.auth === "token" ? (
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
    </Dialog>
  );
}

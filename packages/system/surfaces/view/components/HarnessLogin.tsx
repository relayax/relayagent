"use client";

/* 구독 로그인 대화 — 어댑터의 login 동사가 데몬 안에서 도는 동안 그 대화를 중계한다.
 *
 * 자격은 여전히 도구가 만든다. 이 창은 토큰을 보지도 저장하지도 않고, 출력을 보여주고 입력을
 * 넣을 뿐이다(runtime/login.ts). 뒷단(loginStart·read·input·stop)과 그 HTTP 문은 진작 있었고
 * **부르는 화면이 없었다** — 그래서 로그인 버튼을 누르면 프로세스는 진짜로 떴는데 출력을 읽는
 * 쪽도 입력을 넣는 쪽도 없어 그대로 매달렸다.
 *
 * 터미널을 흉내내지 않는다: 어댑터 규약이 "URL·코드·프롬프트는 평문 한 줄로, 입력은 줄 단위
 * stdin" 을 이미 요구하므로 줄 목록과 입력 한 칸이면 계약을 다 받는다. 전체화면 TUI 에 기대는
 * 어댑터는 창을 여는 폴백으로 강등되고, 이 창이 그 처방을 같이 낸다.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { loginHarness, loginInput, loginRead, loginStop } from "@/lib/api";

const POLL_MS = 500;

export default function HarnessLogin({
  pkg,
  label,
  variant,
  switchAccount,
  onClose,
  onDone,
}: {
  pkg: string;
  label: string;
  /** 어느 어댑터로 로그인하나 — 미지정이면 그 앱의 활성 하네스. 제공사 화면은 그 줄의
   *  provider 를 대는 어댑터를 명시한다(활성으로만 돌면 다른 회사에 로그인하게 된다) */
  variant?: string;
  /** 계정 전환 — 기존 자격을 비우고 다시 로그인한다 */
  switchAccount?: boolean;
  onClose: () => void;
  /** 로그인 프로세스가 끝났다(성공 여부는 code) — 부른 쪽이 준비 상태를 다시 읽는다 */
  onDone: (code: number | null) => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(true);
  const [code, setCode] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [terminal, setTerminal] = useState<{ command: string; note: string } | null>(null);
  const cursor = useRef(0);
  const tail = useRef<HTMLDivElement | null>(null);
  const started = useRef(false);

  // 시작은 한 번만. StrictMode 의 이중 마운트가 로그인 프로세스를 둘 띄우면
  // 기판이 "이미 진행 중인 로그인이 있습니다" 로 거절하고 창이 빈 채로 선다
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const r = await loginHarness(pkg, !!switchAccount, undefined, variant);
        // 두 갈래다 — headless 는 이 창이 중계하고, terminal 은 창을 연 뒤 여기선 안내만 한다
        if (r.mode === "terminal") {
          setTerminal({ command: r.command, note: r.note });
          setRunning(false);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
        setRunning(false);
      }
    })();
  }, [pkg, switchAccount, variant]);

  // 출력 폴링. from 은 절대 줄번호라 링버퍼가 앞을 잘라도 어긋나지 않는다
  useEffect(() => {
    if (!running || terminal) return;
    let live = true;
    const tick = async (): Promise<void> => {
      try {
        const r = await loginRead(pkg, cursor.current);
        if (!live) return;
        cursor.current = r.from;
        if (r.lines.length) setLines((prev) => [...prev, ...r.lines]);
        if (r.done) {
          setRunning(false);
          setCode(r.code);
          onDone(r.code);
        }
      } catch (e) {
        if (!live) return;
        setErr(e instanceof Error ? e.message : String(e));
        setRunning(false);
      }
    };
    const id = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pkg, running, terminal, onDone]);

  useEffect(() => {
    tail.current?.scrollIntoView({ block: "end" });
  }, [lines]);

  const send = useCallback(async () => {
    const v = text;
    setText("");
    // 사용자가 친 것은 화면에도 남긴다 — 어댑터가 되울리지 않으면 무엇을 넣었는지 사라진다
    setLines((prev) => [...prev, `> ${v}`]);
    try {
      await loginInput(pkg, v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [pkg, text]);

  const close = useCallback(() => {
    if (running) void loginStop(pkg).catch(() => { /* 이미 끝났다 */ });
    onClose();
  }, [pkg, running, onClose]);

  return (
    <Dialog open onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>로그인 · {label}</DialogTitle>
        </DialogHeader>

        {terminal ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm">{terminal.note}</p>
            <code className="rounded bg-muted px-2 py-1 text-xs">{terminal.command}</code>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="max-h-72 overflow-y-auto rounded border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap break-all">
              {lines.length ? lines.map((l, i) => <div key={i}>{l}</div>) : <span className="text-muted-foreground">시작하는 중…</span>}
              <div ref={tail} />
            </div>
            {running ? (
              <div className="flex gap-2">
                <Input
                  autoFocus
                  placeholder="여기에 입력하고 Enter (코드·선택지 등)"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void send(); }}
                />
                <Button variant="outline" size="sm" onClick={() => void send()}>보내기</Button>
              </div>
            ) : (
              <p className="text-sm">
                {code === 0 ? "로그인이 끝났습니다." : `로그인 프로세스가 종료됐습니다 (코드 ${code ?? "?"}).`}
              </p>
            )}
          </div>
        )}

        {err ? <p className="text-sm text-destructive">{err}</p> : null}

        <div className="flex justify-end gap-2">
          {/* 전체화면 TUI 를 고집하는 어댑터의 마지막 길 — 창을 열어 그 안에서 끝낸다 */}
          {!terminal && !running && code !== 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loginHarness(pkg, !!switchAccount, "terminal", variant).then((r) => {
                if (r.mode === "terminal") setTerminal({ command: r.command, note: r.note });
              }).catch((e) => setErr(e instanceof Error ? e.message : String(e)))}
            >
              터미널 창으로 열기
            </Button>
          ) : null}
          <Button size="sm" onClick={close}>{running ? "중단" : "닫기"}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

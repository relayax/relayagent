"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CREATABLES, GROUPS, blocked, slugOk, type CreateCtx, type Creatable, type Made } from "@/lib/create";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Manifest } from "@/lib/types";

// 만들 수 있는 것의 표면.
//
// 노션의 `/`, Figma 의 insert, n8n 의 노드 팔레트가 답하는 그 질문 — "무엇을 만들 수 있는가" —
// 에 이 화면에는 답이 없었다. 트리는 최상위 섹션 이름 12개를 흐리게 늘어놓았지만 그 이름들이
// 무엇을 주는지 말하지 않았고, 하위 항목(부품·하네스 후보·스킬)은 **선언된 뒤에야** 트리에
// 생기므로 그 존재를 이미 아는 사람에게만 보였다.
//
// 이미 있는 것도 숨기지 않고 흐리게 남긴다. 숨기면 어휘가 다시 보이지 않는다 — 팔레트가
// 가르치는 물건이라는 것이 그 이유다.
//
// 자리는 다이얼로그다(2026-08-28). 종전에는 직접 띄운 absolute 상자였는데, 기준으로 삼은
// `.st-body` 는 이 화면에 없고 `.pane-body` 는 position 을 갖지 않아 최초 포함 블록 — 즉 문서
// 왼쪽 위 — 에 붙었다. 탑바를 덮고 검색줄이 화면 위로 잘려 나가는 그 팝업이 그 결과다.
// 여기 오는 길은 [＋ 추가] 메뉴 하나뿐이므로, 그때는 목록을 건너뛰고 질문만 묻고 닫는다.

export default function Palette({
  manifest,
  files,
  ctx,
  onMade,
  onClose,
  initial,
}: {
  manifest: Manifest;
  files: string[];
  ctx: CreateCtx;
  onMade: (made: Made) => void;
  onClose: () => void;
  /** 이미 고른 것 — 설정 패널의 [＋ 추가] 메뉴에서 왔다. 목록을 건너뛰고 그 항목의 질문으로 연다 */
  initial?: Creatable | null;
}) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Creatable | null>(null);
  /** 목록에서 고른 것인가 — 메뉴에서 곧장 온 질문에는 돌아갈 목록이 없다 */
  const [fromList, setFromList] = useState(false);
  const [input, setInput] = useState("");
  const [input2, setInput2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return CREATABLES;
    return CREATABLES.filter((c) => (c.label + " " + c.yaml + " " + c.detail + " " + c.group).toLowerCase().includes(t));
  }, [q]);

  const run = useCallback(
    async (c: Creatable, value: string, second: string) => {
      if (busy) return;
      setBusy(true);
      setErr(null);
      try {
        const made = await c.make(ctx, value.trim(), second.trim());
        onMade(made);
        onClose();
      } catch (e) {
        setErr(String(e instanceof Error ? e.message : e));
        setBusy(false);
      }
    },
    [busy, ctx, onMade, onClose],
  );

  const pick = useCallback((c: Creatable, viaList: boolean) => {
    setErr(null);
    if (!c.needs) {
      void run(c, "", "");
      return;
    }
    const choices = c.needs.kind === "choice" ? (c.needs.choices?.(manifest, files) ?? []) : [];
    setInput(c.needs.kind === "choice" ? (choices[0] ?? "") : "");
    setInput2("");
    setFromList(viaList);
    setSel(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, files]);

  useEffect(() => { if (initial) pick(initial, false); }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const needs = sel?.needs;
  const choices = needs?.kind === "choice" ? (needs.choices?.(manifest, files) ?? []) : [];
  const needs2 = sel?.needs2;
  const ok1 = !needs || (needs.kind === "slug" ? slugOk(input) : input.trim().length > 0);
  const ok2 = !needs2 || (needs2.kind === "slug" ? slugOk(input2) : input2.trim().length > 0);
  const valid = ok1 && ok2;

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="pl-dlg" aria-label="만들기">
        {sel ? (
          <>
            <DialogHeader>
              <div className="pl-ask-hd">
                <DialogTitle>{sel.label}</DialogTitle>
                <span className="pl-yaml mono">{sel.yaml}</span>
              </div>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="pl-detail">{sel.detail}</div>
              <div className="flex flex-col gap-1.5">
                <Label>{needs!.label}</Label>
                {needs!.kind === "choice" ? (
                  <select value={input} onChange={(e) => setInput(e.target.value)} autoFocus>
                    {choices.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                ) : (
                  <Input
                    autoFocus
                    value={input}
                    placeholder={needs!.placeholder}
                    className="font-mono text-xs"
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && valid) void run(sel, input, input2); }}
                  />
                )}
              </div>
              {needs2 ? (
                <div className="flex flex-col gap-1.5">
                  <Label>{needs2.label}</Label>
                  <Input
                    value={input2}
                    placeholder={needs2.placeholder}
                    className="font-mono text-xs"
                    onChange={(e) => setInput2(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && valid) void run(sel, input, input2); }}
                  />
                </div>
              ) : null}
              {needs!.kind === "slug" && input.trim() && !ok1 ? (
                <div className="gx-err">영문 소문자·숫자·하이픈만, 40자까지. 한글 이름은 쓰지 않습니다.</div>
              ) : null}
              {err ? <div className="gx-err">{err}</div> : null}
            </div>
            <DialogFooter>
              {fromList ? (
                <Button variant="outline" size="sm" onClick={() => setSel(null)}>뒤로</Button>
              ) : (
                <Button variant="outline" size="sm" onClick={onClose}>취소</Button>
              )}
              <Button size="sm" disabled={!valid || busy} onClick={() => void run(sel, input, input2)}>
                {busy ? "만드는 중…" : "만들기"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>무엇을 만들까요</DialogTitle>
            </DialogHeader>
            <Input
              autoFocus
              className="pl-q"
              placeholder="부품, 하네스, 트리거…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="pl-list">
              {GROUPS.map((g) => {
                const rows = hits.filter((c) => c.group === g);
                if (!rows.length) return null;
                return (
                  <div key={g} className="pl-group">
                    <div className="rc-label">{g}</div>
                    {rows.map((c) => {
                      const why = blocked(c, manifest, files);
                      const n = c.present(manifest, files);
                      return (
                        <button
                          key={c.id}
                          className={`pl-row${why ? " off" : ""}`}
                          disabled={!!why}
                          title={why ?? c.detail}
                          onClick={() => pick(c, true)}
                        >
                          <span className="pl-tx">
                            <span className="pl-lb">{c.label}</span>
                            <span className="pl-dt">{c.detail}</span>
                          </span>
                          <span className="pl-rt">
                            {why ? <Badge variant="outline">{why}</Badge> : n ? <Badge variant="outline">{n}</Badge> : null}
                            <span className="pl-yaml mono">{c.yaml}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              {!hits.length ? <div className="empty">그런 것은 아직 문법에 없습니다</div> : null}
              {err ? <div className="gx-err">{err}</div> : null}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

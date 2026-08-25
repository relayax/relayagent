"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CREATABLES, GROUPS, blocked, slugOk, type CreateCtx, type Creatable, type Made } from "@/lib/create";
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

export default function Palette({
  manifest,
  files,
  ctx,
  onMade,
  onClose,
}: {
  manifest: Manifest;
  files: string[];
  ctx: CreateCtx;
  onMade: (made: Made) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Creatable | null>(null);
  const [input, setInput] = useState("");
  const [input2, setInput2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => { search.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") (open ? setOpen(null) : onClose()); };
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose]);

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

  const pick = useCallback((c: Creatable) => {
    setErr(null);
    if (!c.needs) {
      void run(c, "", "");
      return;
    }
    const choices = c.needs.kind === "choice" ? (c.needs.choices?.(manifest, files) ?? []) : [];
    setInput(c.needs.kind === "choice" ? (choices[0] ?? "") : "");
    setInput2("");
    setOpen(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest, files]);

  const needs = open?.needs;
  const choices = needs?.kind === "choice" ? (needs.choices?.(manifest, files) ?? []) : [];
  const needs2 = open?.needs2;
  const ok1 = !needs || (needs.kind === "slug" ? slugOk(input) : input.trim().length > 0);
  const ok2 = !needs2 || (needs2.kind === "slug" ? slugOk(input2) : input2.trim().length > 0);
  const valid = ok1 && ok2;

  return (
    <div className="pl" ref={box} role="dialog" aria-label="만들기">
      <div className="pl-top">
        <input
          ref={search}
          className="pl-q"
          placeholder="무엇을 만들까요 — 부품, 하네스, 트리거…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(null); }}
        />
        <button className="rc-btn" onClick={onClose} title="닫기 (Esc)">✕</button>
      </div>

      {open ? (
        <div className="pl-ask">
          <div className="pl-ask-hd">
            <b>{open.label}</b>
            <span className="pl-yaml mono">{open.yaml}</span>
          </div>
          <div className="pl-detail">{open.detail}</div>
          <label className="st-field">
            <span>{needs!.label}</span>
            {needs!.kind === "choice" ? (
              <select value={input} onChange={(e) => setInput(e.target.value)} autoFocus>
                {choices.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            ) : (
              <input
                autoFocus
                value={input}
                placeholder={needs!.placeholder}
                style={{ fontFamily: "var(--rc-mono)", fontSize: 12 }}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && valid) void run(open, input, input2); }}
              />
            )}
          </label>
          {needs2 ? (
            <label className="st-field">
              <span>{needs2.label}</span>
              <input
                value={input2}
                placeholder={needs2.placeholder}
                style={{ fontFamily: "var(--rc-mono)", fontSize: 12 }}
                onChange={(e) => setInput2(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && valid) void run(open, input, input2); }}
              />
            </label>
          ) : null}
          {needs!.kind === "slug" && input.trim() && !ok1 ? (
            <div className="gx-err">영문 소문자·숫자·하이픈만, 40자까지. 한글 이름은 쓰지 않습니다.</div>
          ) : null}
          {err ? <div className="gx-err">{err}</div> : null}
          <div className="pl-ask-foot">
            <button className="rc-btn" onClick={() => setOpen(null)}>뒤로</button>
            <button className="rc-btn accent" disabled={!valid || busy} onClick={() => void run(open, input, input2)}>
              {busy ? "만드는 중…" : "만들기"}
            </button>
          </div>
        </div>
      ) : (
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
                      onClick={() => pick(c)}
                    >
                      <span className="pl-tx">
                        <span className="pl-lb">{c.label}</span>
                        <span className="pl-dt">{c.detail}</span>
                      </span>
                      <span className="pl-rt">
                        {why ? <span className="rc-chip gray">{why}</span> : n ? <span className="rc-chip gray">{n}</span> : null}
                        <span className="pl-yaml mono">{c.yaml}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          })}
          {!hits.length ? <div className="empty">그런 것은 아직 문법에 없습니다</div> : null}
          {err ? <div className="gx-err" style={{ padding: "0 12px 10px" }}>{err}</div> : null}
        </div>
      )}
    </div>
  );
}

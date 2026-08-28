"use client";

import { useCallback, useEffect, useState } from "react";
import { Download, FolderPlus, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchSuites, packSuite, removeSuite, saveSuite, type Suite } from "@/lib/api";
import type { Registry } from "@/lib/types";

// 묶음 카드 — 사이드바 폴더의 관리 자리. 구성원을 고르고 허브를 정하면 사이드바에 폴더로 서고,
// 내보내기는 그 폴더를 봉투 하나(.relaypackages)로 굽는다. 결재로 접히는 허브▸모듈 트리는 여기서
// 만지지 않는다 — 그건 장부가 답하고(shell.ts mounted_in), 이 카드는 그 위에 사람이 얹는 폴더만 다룬다.
// 저장·삭제 뒤에는 relay:nav-refresh 를 쏜다 — 같은 문서에 주입된 사이드바가 그 신호로 다시 읽는다
export default function SuitesCard({ reg }: { reg: Registry }) {
  const [suites, setSuites] = useState<Suite[] | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [edit, setEdit] = useState<{ suite: Suite; fresh: boolean } | null>(null);
  const [packed, setPacked] = useState<{ name: string; href: string; file: string; size: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchSuites()
      .then((r) => { setSuites(r.suites); setGone(null); })
      // 묶음 문이 없는 기판(구 데몬)은 404 — 없는 기능을 빈 목록처럼 보이게 하지 않는다
      .catch((e) => setGone(String(e?.message ?? e)));
  }, []);
  useEffect(() => { load(); }, [load]);

  const labelOf = (name: string) => reg.packages.find((p) => p.name === name)?.manifest?.display_name ?? name;
  const refresh = () => {
    load();
    window.dispatchEvent(new CustomEvent("relay:nav-refresh"));
  };

  const remove = async (s: Suite) => {
    if (!confirm(`묶음 "${s.label}" 을 지울까요? 설치본은 그대로 남습니다.`)) return;
    setBusy(s.name); setErr(null);
    try { await removeSuite(s.name); refresh(); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };
  const pack = async (s: Suite) => {
    setBusy(s.name); setErr(null); setPacked(null);
    try { const r = await packSuite(s.name); setPacked({ name: s.name, href: r.href, file: r.file, size: r.size }); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  return (
    <div className="rc-card pad" style={{ flex: "none" }}>
      <div className="flex items-center gap-2">
        <h3 className="m-0">묶음</h3>
        <span className="text-xs text-muted-foreground">사이드바 폴더 · 한 파일(.relaypackages)로 내보내기</span>
        <span className="flex-1" />
        {gone ? null : (
          <Button size="sm" variant="outline" onClick={() => setEdit({ suite: { name: "", label: "", members: [], hub: null }, fresh: true })}>
            <FolderPlus className="size-3.5" />새 묶음
          </Button>
        )}
      </div>
      {gone ? (
        <p className="mt-2 mb-0 text-xs text-muted-foreground">이 기판에는 묶음 문이 없습니다 — 기판(데몬)을 0.3.15 이상으로 올리면 열립니다. ({gone})</p>
      ) : suites == null ? null : suites.length === 0 ? (
        <p className="mt-2 mb-0 text-xs text-muted-foreground">아직 묶음이 없어요. 함께 쓰는 에이전트들을 한 폴더로 묶으면 사이드바가 짧아지고, 폴더째 다른 컴퓨터로 옮길 수 있어요.</p>
      ) : (
        <ul className="mt-2 mb-0 flex list-none flex-col gap-1.5 p-0">
          {suites.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[13px]">
              <b>{s.label}</b>
              <span className="font-mono text-[11px] text-muted-foreground">{s.name}</span>
              {s.members.map((m) => (
                <Badge key={m} variant="outline" className="rounded-md px-1.5 py-0 text-[11px] font-normal" title={m}>
                  {labelOf(m)}{s.hub === m ? " · 허브" : ""}
                </Badge>
              ))}
              <span className="flex-1" />
              <Button size="xs" variant="ghost" title="구성원·허브 고치기" disabled={busy === s.name} onClick={() => setEdit({ suite: s, fresh: false })}><Pencil className="size-3" /></Button>
              <Button size="xs" variant="ghost" title="폴더째 파일로 내보내기(.relaypackages)" disabled={busy === s.name} onClick={() => void pack(s)}><Download className="size-3" /></Button>
              <Button size="xs" variant="ghost" title="묶음 지우기(설치본은 그대로)" disabled={busy === s.name} onClick={() => void remove(s)}><Trash2 className="size-3" /></Button>
              {packed?.name === s.name ? (
                <span className="basis-full text-xs text-muted-foreground">
                  구웠어요: <a href={packed.href} download className="font-semibold text-blue-700 underline underline-offset-3">{packed.file}</a> ({(packed.size / 1024).toFixed(0)}KB) — 받는 쪽은 사이드바 [+] → 파일 불러오기
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {err ? <p className="mt-2 mb-0 text-xs text-destructive">{err}</p> : null}
      {edit ? (
        <SuiteDialog
          reg={reg}
          suite={edit.suite}
          fresh={edit.fresh}
          onClose={() => setEdit(null)}
          onDone={() => { setEdit(null); refresh(); }}
        />
      ) : null}
    </div>
  );
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

function SuiteDialog({ reg, suite, fresh, onClose, onDone }: { reg: Registry; suite: Suite; fresh: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(suite.name);
  const [label, setLabel] = useState(suite.label);
  const [members, setMembers] = useState<string[]>(suite.members);
  const [hub, setHub] = useState<string | null>(suite.hub);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // 셸 자신(ring 0)은 묶지 않는다 — 폴더에 넣을 앱이 아니다
  const candidates = reg.packages.filter((p) => p.ring !== 0);
  const toggle = (pkg: string, on: boolean) => {
    setMembers((prev) => (on ? [...prev.filter((m) => m !== pkg), pkg] : prev.filter((m) => m !== pkg)));
    if (!on && hub === pkg) setHub(null);
  };
  const submit = async () => {
    setErr(null);
    if (!SLUG.test(name)) return setErr("이름은 소문자·숫자·하이픈으로(예: cardnews) — 파일 이름과 주소에 쓰입니다");
    if (!members.length) return setErr("구성원을 하나 이상 고르세요");
    setBusy(true);
    try {
      await saveSuite({ name, label: label.trim() || name, members, hub });
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{fresh ? "새 묶음" : `${suite.label} 묶음`}</DialogTitle>
          <DialogDescription>사이드바에 폴더 하나로 서고, 내보내기를 누르면 이 구성원 전부가 한 파일이 됩니다. 허브는 폴더의 문 — 접힌 사이드바에서 그 앱의 아이콘이 폴더를 대표합니다.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="suite-label">폴더 이름</Label>
            <Input id="suite-label" value={label} placeholder="예: 카드뉴스" onChange={(e) => setLabel(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="suite-name">파일·주소 이름</Label>
            <Input id="suite-name" value={name} placeholder="예: cardnews" disabled={!fresh} onChange={(e) => setName(e.target.value.trim())} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>구성원</Label>
            <div className="lv">
              {candidates.map((p) => {
                const on = members.includes(p.name);
                return (
                  <label key={p.name} className="lv-row cursor-pointer" style={{ gap: 10 }}>
                    <Checkbox checked={on} onCheckedChange={(v) => toggle(p.name, !!v)} />
                    <span className="lv-tx">
                      <span className="lv-t">{p.manifest?.display_name ?? p.name}</span>
                      <span className="lv-s">{p.name}</span>
                    </span>
                  </label>
                );
              })}
              {!candidates.length ? <p className="text-xs text-muted-foreground">묶을 설치본이 없습니다</p> : null}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="suite-hub">허브</Label>
            <select id="suite-hub" value={hub ?? ""} onChange={(e) => setHub(e.target.value || null)}>
              <option value="">없음 (첫 구성원이 대표)</option>
              {members.map((m) => (
                <option key={m} value={m}>{reg.packages.find((p) => p.name === m)?.manifest?.display_name ?? m} ({m})</option>
              ))}
            </select>
          </div>
          {err ? <p className="text-sm text-destructive">{err}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>취소</Button>
          <Button size="sm" disabled={busy} onClick={() => void submit()}>{busy ? "..." : fresh ? "만들기" : "저장"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

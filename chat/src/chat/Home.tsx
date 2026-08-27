/*!
 * Home.tsx — 홈(앱 런처). 기판의 "/" 문서(#relay-home)에 main.tsx boot 가 마운트한다.
 *
 * 종전에는 runner/runtime/shell.ts 의 SHELL_JS 가 innerHTML + 손 CSS 로 그렸다(2026-08-27
 * 이전). 콘솔 뷰·채팅 위젯이 shadcn 인데 홈만 손 CSS 라 같은 번들의 shadcn 화면으로 옮겼다.
 * 사이드바는 그대로 shell.ts 에 산다 — 모든 패키지 문서에 주입되는 크롬이라 React 번들에
 * 의존시키지 않는다. 문구·동선은 종전과 같다:
 *   · 말로 만들기 — 이 제품의 대표 동선이 첫 화면에서 시작된다. 문장은 relay:chat-open {send}
 *     로 콘솔 에이전트의 대화에 보내지고(같은 번들의 autoFloat 가 착지), 빌더 위임이 시작되면
 *     위젯이 그 탭을 연다. 별도의 "패키지 만들기" 버튼은 없다 — 불러오기·스토어는 상자 아래
 *     한 줄씩이라 처음 온 사람이 고를 것이 "말하기" 하나로 보인다.
 *   · 진행 중 카드 — 지금 신경 쓸 것(수정 중·새 판·오류·초안)만. 판정은 home-model.ts.
 *   · 사용 안내 — 첫 방문에 한 번, 이후엔 ?guide=1(콘솔 설정의 [안내]).
 * 사이드바의 [새로 만들기]는 relay:home-ask 를 쏘고, 다른 문서에서는 /#new 로 온다.
 * 목록은 relay:turn(settled)·relay:nav-refresh·탭 복귀마다 다시 읽는다 — 사이드바와 같은 조건.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Download, FileText, Pencil, RefreshCw, Store } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fetchNav, type ShellItem, type ShellNav } from "./nav";
import { cardAction, describe, draftLine, examplesAt, initialOf, isEmptyNav, todoOf, updateCount, type CardAction } from "./home-model";

const ASK_EVENT = "relay:home-ask";
const GUIDE_KEY = "relay-guide-v2";
const GUIDE: ReadonlyArray<{ t: string; b: React.ReactNode }> = [
  { t: "Relay에 오신 것을 환영합니다",
    b: <>Relay는 AI 에이전트를 <b>앱처럼 설치해서 쓰는</b> 내 컴퓨터 속 작업 공간입니다. 설치된 에이전트는 <b>왼쪽 사이드바</b>에서 골라 쓰고, 이 홈에서는 <b>새로 만들거나 손볼 것</b>을 봅니다.</> },
  { t: "만들기는 말로 시작합니다",
    b: <>홈 위의 입력창에 원하는 것을 적어 보세요. 예를 들어 <b>"근태관리 도우미 만들어줘"</b>. 빌더가 <b>설계부터 적용까지</b> 진행하고, 그 대화가 오른쪽에 열려 과정과 질문을 볼 수 있습니다.</> },
  { t: "손으로 고치려면 상세 화면",
    b: <>사이드바에서 에이전트를 고르고 <b>[상세]</b>를 누르면 무엇을 하는지 한 장으로 보입니다. <b>줄을 누르면 그 자리에서</b> 고치고 결과를 미리 보며, <b>[적용]</b>을 눌러야 실제로 바뀝니다.</> },
  { t: "안전장치가 기본입니다",
    b: <>비밀번호와 토큰은 <b>안전하게 따로 저장</b>되고, 에이전트는 <b>허락한 폴더만</b> 봅니다. 에이전트끼리 연결할 때도 <b>내 승인이 있어야</b> 켜집니다. 이 안내는 설정 화면의 [안내]로 다시 볼 수 있습니다.</> },
];

function useNav(): { nav: ShellNav | null; err: string | null } {
  const [nav, setNav] = useState<ShellNav | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = useCallback(() => {
    fetchNav().then((n) => { setNav(n); setErr(null); })
      .catch((e) => { setErr("설치 목록을 읽지 못했어요: " + String(e?.message || e)); });
  }, []);
  useEffect(() => {
    load();
    const onTurn = (ev: Event) => { const d = (ev as CustomEvent).detail || {}; if (d.phase === "settled") load(); };
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("relay:turn", onTurn);
    window.addEventListener("relay:nav-refresh", load);
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("relay:turn", onTurn);
      window.removeEventListener("relay:nav-refresh", load);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [load]);
  return { nav, err };
}

export function Home() {
  const { nav, err } = useNav();
  return (
    <div className="rc-home min-h-screen text-sm leading-relaxed text-foreground" style={{ fontFamily: "var(--rc-sans)" }}>
      {nav ? <Ask nav={nav} /> : null}
      {err ? (
        <Empty className="mx-5 my-4 rounded-xl border border-border bg-background">
          <EmptyHeader><EmptyTitle>설치 목록을 읽지 못했어요</EmptyTitle><EmptyDescription>{err}</EmptyDescription></EmptyHeader>
        </Empty>
      ) : nav ? <Progress nav={nav} /> : null}
      <Guide />
    </div>
  );
}

// ── 말로 만들기 ────────────────────────────────────────────────────────────
function Ask({ nav }: { nav: ShellNav }) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState("");
  const [page, setPage] = useState(0);
  const focus = useCallback(() => {
    const el = ta.current; if (!el) return;
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch { /* jsdom 등 */ }
    el.focus();
  }, []);
  useEffect(() => {
    if (location.hash === "#new") {
      try { history.replaceState(null, "", location.pathname); } catch { /* 무시 */ }
      focus();
    }
    window.addEventListener(ASK_EVENT, focus);
    return () => window.removeEventListener(ASK_EVENT, focus);
  }, [focus]);
  const submit = () => {
    const t = text.trim();
    if (!t) { focus(); return; }
    // 같은 번들의 autoFloat 가 착지한다(view-bridge §4-8) — 종전의 RelayChat 대기 루프는 불요
    window.dispatchEvent(new CustomEvent("relay:chat-open", { detail: { send: t } }));
    setText("");
  };
  const pick = (sentence: string) => {
    setText(sentence);
    const el = ta.current; if (!el) return;
    el.focus();
    requestAnimationFrame(() => { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* 무시 */ } });
  };
  return (
    <section className="mx-auto max-w-[620px] px-5 pt-14 pb-7">
      <h2 className="m-0 mb-4 text-center text-[22px] font-bold tracking-tight">무엇을 만들까요?</h2>
      <form
        className="flex flex-col gap-2.5 rounded-xl border border-border bg-background px-3.5 pt-3.5 pb-2.5 shadow-xs transition-[box-shadow,border-color] focus-within:border-blue-600 focus-within:ring-3 focus-within:ring-blue-600/20"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        <Textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          maxLength={2000}
          rows={2}
          placeholder="만들고 싶은 에이전트를 적어 주세요"
          aria-label="만들 것을 말로 설명"
          className="min-h-[58px] resize-none border-0 bg-transparent px-0.5 py-0 text-[14.5px] leading-[1.55] shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-[14.5px]"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="m-0 text-xs text-muted-foreground">적으면 빌더가 설계부터 적용까지 진행하고, 그 대화가 오른쪽에 열려요.</p>
          {/* 포인트 컬러(블루)는 살짝만 — 시작 버튼·입력 포커스·"수정 중" 칩 셋뿐. 나머지는 neutral */}
          <Button type="submit" size="sm" className="shrink-0 rounded-full bg-blue-600 px-3.5 text-white hover:bg-blue-700">시작</Button>
        </div>
      </form>
      <div className="mt-3 flex flex-wrap justify-center gap-1.5">
        {examplesAt(page).map(([name, sentence]) => (
          <Button key={name} type="button" variant="outline" size="sm" title={sentence} onClick={() => pick(sentence)}
            className="h-7 rounded-full px-3 text-xs font-normal text-muted-foreground hover:text-foreground">
            {name}
          </Button>
        ))}
        <Button type="button" variant="outline" size="icon-sm" aria-label="다른 예시" title="다른 예시" onClick={() => setPage((p) => p + 1)}
          className="size-7 rounded-full text-muted-foreground">
          <RefreshCw />
        </Button>
      </div>
      <ItemGroup className="mt-3.5 border-t border-border">
        <Item render={<a href={nav.importer} />} size="sm" className="rounded-none border-b border-border border-x-0 px-1.5 no-underline text-inherit hover:bg-muted">
          <ItemMedia variant="icon" className="size-auto border-0 bg-transparent text-muted-foreground"><Download className="size-4" /></ItemMedia>
          <ItemContent className="flex-row items-center gap-2.5">
            <ItemTitle className="text-[13.5px]">불러오기</ItemTitle>
            <ItemDescription className="text-xs">받은 에이전트 파일을 열어요</ItemDescription>
          </ItemContent>
          <ChevronRight className="size-4 text-muted-foreground" />
        </Item>
        {nav.store ? (
          <Item render={<a href={nav.store} />} size="sm" className="rounded-none border-b border-border border-x-0 px-1.5 no-underline text-inherit hover:bg-muted">
            <ItemMedia variant="icon" className="size-auto border-0 bg-transparent text-muted-foreground"><Store className="size-4" /></ItemMedia>
            <ItemContent className="flex-row items-center gap-2.5">
              <ItemTitle className="text-[13.5px]">스토어에서 담기</ItemTitle>
              <ItemDescription className="text-xs">만들어진 에이전트를 골라 설치해요</ItemDescription>
            </ItemContent>
            <ChevronRight className="size-4 text-muted-foreground" />
          </Item>
        ) : null}
      </ItemGroup>
    </section>
  );
}

// ── 진행 중 ────────────────────────────────────────────────────────────────
function Progress({ nav }: { nav: ShellNav }) {
  if (isEmptyNav(nav)) {
    return (
      <Empty className="mx-5 my-4 rounded-xl border border-border bg-background">
        <EmptyHeader><EmptyTitle>아직 설치된 에이전트가 없어요</EmptyTitle><EmptyDescription>위 입력칸에 만들고 싶은 것을 적어 시작하세요</EmptyDescription></EmptyHeader>
      </Empty>
    );
  }
  const todo = todoOf(nav.items);
  const ups = updateCount(nav.items);
  const any = todo.length || nav.drafts.length;
  return (
    <>
      {ups && nav.library ? (
        // 새 판 요약 배너 — 개수만 말한다. 실행은 각 카드의 버튼(설치 동의 관문이 판마다 선다)
        <div className="mx-5 mt-4 -mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/60 px-3.5 py-2 text-xs">
          <b className="font-semibold">업데이트 {ups}개</b> · 카드에서 받을 수 있어요
          <span className="flex-1" />
          <a href={nav.library} className="font-semibold text-blue-700 underline underline-offset-3">내 서재 열기</a>
        </div>
      ) : null}
      {any ? (
        <h3 className="mx-auto mt-2 mb-0 max-w-[1240px] px-5 text-xs font-bold tracking-wide text-muted-foreground">진행 중</h3>
      ) : (
        <p className="mx-auto my-5 max-w-[620px] px-5 text-center text-[13px] text-muted-foreground">진행 중인 것이 없어요. 에이전트는 왼쪽 목록에서 골라 쓰세요.</p>
      )}
      <div className="grid gap-3 px-5 py-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(248px, 1fr))" }}>
        {todo.map((it) => <ItemCard key={it.pkg} it={it} library={nav.library} />)}
        {nav.drafts.map((df) => <DraftCard key={df.name} df={df} />)}
      </div>
    </>
  );
}

// preflight 가 없어 border 색은 매번 명시한다(border-border) — 기본값 currentColor 는 검정 테두리가 된다
// 색은 neutral 하나 — 상태는 채움색이 아니라 칩의 테두리/글자로만 가른다(오류만 붉게). 호버도 테두리 한 단계
const cardClass = "gap-2.5 rounded-xl border border-border px-4 py-3.5 shadow-none ring-0 transition-colors hover:border-foreground/30 [--card-spacing:0px]";
const chip = "rounded-md px-1.5 py-0 text-[11px] font-semibold";

// 카드 전체가 링크다. 버튼은 두지 않는다 — 카드가 곧 그 초안/앱이고 누르면 고치러 가는 것이 이 격자의
// 뜻이라, 버튼은 같은 말을 두 번 하는 셈이다. 목적지(수정 화면)는 오른쪽 아래의 연필+"수정" 표시가
// 말한다(버튼 모양 아님, 호버에 진해진다). 예외는 목적지가 바깥(스토어 서재)인 업데이트뿐 — 그때만 버튼.
function ItemCard({ it, library }: { it: ShellItem; library: string | null }) {
  const act = cardAction(it, library);
  const desc = describe(it.description);
  return (
    <Card className={cn(cardClass, "group/hc")}>
      <a href={act.href} className="flex flex-col gap-2 text-inherit no-underline">
        <CardHeader className="flex flex-row items-center gap-2.5 px-0">
          <span className="flex size-[30px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-[13px] font-bold text-muted-foreground">
            {it.icon ? <img src={it.icon} alt="" className="block size-[30px] object-cover" /> : initialOf(it.label)}
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13.5px]">{it.label}</b>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{it.pkg}{it.version ? "@" + it.version : ""}</span>
          </span>
          {it.resident ? <span className="size-[7px] shrink-0 rounded-full bg-emerald-500" title="도는 중" /> : null}
        </CardHeader>
        <CardContent className="px-0">
          <p className={cn("m-0 line-clamp-2 min-h-[2.6em] text-xs", desc ? "text-muted-foreground" : "text-muted-foreground/60 italic")}>{desc ?? "설명이 아직 없어요"}</p>
        </CardContent>
        <CardFooter className="flex items-center gap-1.5 px-0">
          <StatusChip status={act.status}>{act.chip}</StatusChip>
          <span className="flex-1" />
          {act.status === "update" ? (
            <Button size="xs" render={<span />} className="pointer-events-none">{act.label}</Button>
          ) : <EditHint />}
        </CardFooter>
      </a>
    </Card>
  );
}

/** 목적지 표시 — "누르면 수정 화면" 을 버튼 없이 말한다 */
function EditHint() {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground/70 transition-colors group-hover/hc:text-foreground">
      <Pencil className="size-3" />수정
    </span>
  );
}

function StatusChip({ status, children }: { status: CardAction["status"] | "draft"; children: React.ReactNode }) {
  if (status === "error") return <Badge variant="destructive" className={chip}>{children}</Badge>;
  if (status === "editing") return <Badge variant="outline" className={cn(chip, "border-blue-200 bg-blue-50 text-blue-700")} title="적용하지 않은 수정이 스튜디오에 있습니다">{children}</Badge>;
  return <Badge variant="outline" className={chip}>{children}</Badge>;
}

// 만드는 중인 초안 — 장부에 없어 설치 카드는 못 되지만, 어디에도 없으면 만들다 만 것이 잃은 것처럼
// 보인다. 설치본과 같은 격자에 같은 모양으로 세우고, 점선과 "초안" 칩으로만 가른다.
// 이름은 한 번만(설치본의 pkg 줄은 라벨과 다른 이름이라 뜻이 있지만 초안은 이름뿐이다)
function DraftCard({ df }: { df: ShellNav["drafts"][number] }) {
  return (
    <Card className={cn(cardClass, "group/hc border-dashed")}>
      <a href={df.href} className="flex flex-col gap-2 text-inherit no-underline">
        <CardHeader className="flex flex-row items-center gap-2.5 px-0">
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-4" /></span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13.5px]">{df.name}</b>
            <span className="block truncate font-mono text-[11px] text-muted-foreground">{df.version ?? "버전 없음"}</span>
          </span>
        </CardHeader>
        <CardContent className="px-0">
          <p className="m-0 line-clamp-2 min-h-[2.6em] text-xs text-muted-foreground">{draftLine(df.changes)}</p>
        </CardContent>
        <CardFooter className="flex items-center gap-1.5 px-0">
          <StatusChip status="draft">초안</StatusChip>
          <span className="flex-1" />
          <EditHint />
        </CardFooter>
      </a>
    </Card>
  );
}

// ── 사용 안내 — 홈 첫 방문에 한 번, 이후엔 ?guide=1 ─────────────────────────
function Guide() {
  const [open, setOpen] = useState(false);
  const [i, setI] = useState(0);
  useEffect(() => {
    let want = false, seen = false;
    try { want = new URLSearchParams(location.search).get("guide") === "1"; } catch { /* 무시 */ }
    try { seen = localStorage.getItem(GUIDE_KEY) === "1"; } catch { /* 무시 */ }
    if (want || !seen) setOpen(true);
  }, []);
  const close = () => {
    try { localStorage.setItem(GUIDE_KEY, "1"); } catch { /* 무시 */ }
    setOpen(false);
    try {
      const u = new URL(location.href);
      if (u.searchParams.has("guide")) { u.searchParams.delete("guide"); history.replaceState(null, "", u.pathname + (u.search || "")); }
    } catch { /* 무시 */ }
  };
  const last = i === GUIDE.length - 1;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
      <DialogContent className="w-[min(440px,calc(100vw-48px))] gap-3 rounded-xl px-7 py-6" showCloseButton={false}>
        <DialogHeader className="gap-1.5">
          <div className="text-[11.5px] font-semibold tracking-wide text-muted-foreground">사용 안내 {i + 1} / {GUIDE.length}</div>
          <DialogTitle className="text-lg leading-snug">{GUIDE[i].t}</DialogTitle>
          <DialogDescription className="min-h-[88px] text-sm leading-relaxed text-muted-foreground [&_b]:font-semibold [&_b]:text-foreground">{GUIDE[i].b}</DialogDescription>
        </DialogHeader>
        <div className="flex justify-center gap-1.5 py-1">
          {GUIDE.map((_, n) => (
            <button key={n} type="button" aria-label={`${n + 1}쪽`} onClick={() => setI(n)}
              className={cn("size-1.5 cursor-pointer rounded-full border-0 p-0", n === i ? "bg-primary" : "bg-border")} />
          ))}
        </div>
        <DialogFooter className="flex-row justify-end gap-2">
          {i > 0 ? <Button variant="outline" size="sm" onClick={() => setI((k) => Math.max(0, k - 1))}>이전</Button> : null}
          <Button size="sm" autoFocus onClick={() => { if (last) close(); else setI((k) => k + 1); }}>{last ? "시작하기" : "다음"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

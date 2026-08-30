/*!
 * Home.tsx — 홈(앱 런처). 기판의 "/" 문서(#relay-home)에 main.tsx boot 가 마운트한다.
 *
 * 종전에는 runner/runtime/shell.ts 의 SHELL_JS 가 innerHTML + 손 CSS 로 그렸다(2026-08-27
 * 이전). 콘솔 뷰·채팅 위젯이 shadcn 인데 홈만 손 CSS 라 같은 번들의 shadcn 화면으로 옮겼다.
 * 사이드바는 그대로 shell.ts 에 산다 — 모든 패키지 문서에 주입되는 크롬이라 React 번들에
 * 의존시키지 않는다. 문구·동선은 종전과 같다:
 *   · 말로 만들기 — 이 제품의 대표 동선이 첫 화면에서 시작된다. 문장은 relay:chat-open
 *     {conversation, send} 로 콘솔 에이전트의 **새 대화**에 보내지고(같은 번들의 autoFloat 가
 *     착지 — 좌표가 있어 새 탭이 선다), 빌더 위임이 시작되면
 *     위젯이 그 탭을 연다. 별도의 "패키지 만들기" 버튼은 없다 — 불러오기는 사이드바 [+] 메뉴에만, 스토어는
 *     예시 칩 아래 옅은 글자 링크 한 줄이라 처음 온 사람이 고를 것이 "말하기" 하나로 보인다.
 *   · 진행 중 카드 — 지금 신경 쓸 것(수정 중·새 버전·오류·초안)만. 판정은 home-model.ts.
 *   · 사용 안내 — 첫 방문에 한 번, 이후엔 ?guide=1(콘솔 설정의 [안내]).
 * 사이드바의 [새로 만들기]는 relay:home-ask 를 쏘고, 다른 문서에서는 /#new 로 온다.
 * 목록은 relay:turn(settled)·relay:nav-refresh·탭 복귀마다 다시 읽는다 — 사이드바와 같은 조건.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check as CheckIcon, ChevronDown, FileIcon, FileText, Pencil, Plus, RefreshCw, Store, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Attachment, AttachmentAction, AttachmentActions, AttachmentContent, AttachmentDescription, AttachmentGroup, AttachmentMedia, AttachmentTitle } from "@/components/ui/attachment";
import { cn } from "@/lib/utils";
import { fetchNav, type ShellItem, type ShellNav } from "./nav";
import { useAttachments, useDropGuard, useFileDrop, filesFrom } from "./attach";
import { fmtSize, providerLabelOf } from "./parts";
import { loadHarnessName, loadHarnessVariants, loadModelOptions, loadModelOptionsFor, modelOptions, type ModelOption } from "./runtime";
import { siblingThread } from "./routematch";
import { cardAction, describe, draftLine, examplesAt, initialOf, isEmptyNav, splitDrafts, todoOf, updateCount, type CardAction, type DraftRef } from "./home-model";

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
    <div className="rc-home relative min-h-screen text-sm leading-relaxed text-foreground" style={{ fontFamily: "var(--rc-sans)" }}>
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
  // 첨부·끌어놓기·모델 — 사이드 챗의 컴포저와 같은 세 가지를 이 입력에도 둔다. 스테이징
  // 규칙(인라인/사이드밴드·용량 상한)은 attach.ts 한 벌을 함께 쓴다: 규칙이 갈리면 홈에서
  // 붙인 첨부만 대화에 착지할 때 다르게 취급된다.
  const { atts, addFiles, removeAtt, clear: clearAtts, error: attError, setError: setAttError, uploading } = useAttachments();
  const fileRef = useRef<HTMLInputElement>(null);
  useDropGuard();
  // 표적은 입력 카드가 아니라 홈 판 전체 — 사람은 화면 한가운데에 파일을 떨어뜨린다.
  const { dragging, dropHost } = useFileDrop(() => document.querySelector<HTMLElement>(".rc-home"), addFiles);
  // 모델 — 모델 어휘는 **하네스에 딸린다**(Claude·Codex·Gemini…). 그래서 축이 둘이다:
  // 공급자(하네스 변형) 줄에 그 변형의 모델 목록이 붙는다. 한 축만 보여 주면 Claude 를 쓰지
  // 않는 사람에게 남의 모델 목록이 뜬다(2026-08-30 피드백).
  //
  // 적용 범위는 사이드 챗의 모델 버튼과 같다 — 즉 **인스턴스 단위**다(오버라이드는
  // instances.list 의 행에 앉는다, runtime.instanceRow). 대화 하나만 갈아입히는 축은 없다.
  const [variants, setVariants] = useState<{ name: string; provider?: string }[]>([]);
  const [soloName, setSoloName] = useState<string | null>(null);
  // 공급자별 카탈로그 — undefined = 아직 안 물음, null = 미도달. 서브메뉴를 열 때 한 번만 묻는다.
  const [byVariant, setByVariant] = useState<Record<string, ModelOption[] | null>>({});
  const [soloModels, setSoloModels] = useState<ModelOption[]>(() => modelOptions());
  const [hover, setHover] = useState<string | null>(null);
  // 고른 것 — 빈 값이면 손대지 않는다(기판 기본값 그대로).
  const [pick_, setPick] = useState<{ harness: string; model: string; label: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadHarnessVariants().then((r) => {
      if (!alive) return;
      setVariants(r.variants);
      if (r.variants.length === 0) {
        void loadHarnessName().then((n) => { if (alive) setSoloName(n); });
        void loadModelOptions().then((m) => { if (alive && m.length) setSoloModels(m); });
      }
    });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!hover || hover in byVariant) return;
    let alive = true;
    void loadModelOptionsFor(hover).then((o) => { if (alive) setByVariant((m) => ({ ...m, [hover]: o })); });
    return () => { alive = false; };
  }, [hover, byVariant]);
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
    // 아직 올라가는 중인 첨부가 있으면 보내지 않는다 — 참조(path)가 없는 칩을 실으면
    // 그 첨부만 조용히 빠진 채 턴이 시작된다.
    if (uploading) { setAttError("첨부를 올리는 중이에요. 잠시 뒤 다시 눌러 주세요."); return; }
    // 같은 번들의 autoFloat 가 착지한다(view-bridge §4-8) — 종전의 RelayChat 대기 루프는 불요.
    // 좌표를 실어 보낸다: 홈은 페이지 슬롯을 선언하지 않아(relay:scope 없음) 좌표 없는 send 는
    // "지금 활성인 탭" — 대개 마지막에 보던 무관한 에이전트의 대화 — 로 들어갔다(2026-08-28).
    // 홈의 한 문장은 언제나 **새 대화 하나**다: sibling 스레드를 민팅해 새 탭으로 착지시킨다
    // (인스턴스 축은 크롬 자신의 좌표=콘솔로 해석된다, §4-8). 지연 민팅이라 첫 발화 직전에야
    // 서버 세션이 생기고, 탭 이름은 그 첫 문장에서 자동으로 붙는다.
    // 첨부·모델은 send 와 함께 실린다(view-bridge §4-8). 넘기는 것은 스테이징을 마친
    // PendingAtt 그대로다 — 바이트/참조를 실은 평범한 객체라 postMessage 를 건너간다.
    // 전송 payload(attToPayload)로의 변환은 받는 쪽이 한 번만 한다: 여기서 미리 바꾸면
    // 컴포저가 다시 변환해 이중 인코딩이 된다.
    window.dispatchEvent(new CustomEvent("relay:chat-open", {
      detail: {
        conversation: siblingThread("main"),
        send: t,
        ...(atts.length ? { atts } : {}),
        ...(pick_?.harness ? { harness: pick_.harness } : {}),
        ...(pick_?.model ? { model: pick_.model } : {}),
      },
    }));
    setText("");
    clearAtts();
  };
  const pick = (sentence: string) => {
    setText(sentence);
    const el = ta.current; if (!el) return;
    el.focus();
    requestAnimationFrame(() => { try { el.setSelectionRange(el.value.length, el.value.length); } catch { /* 무시 */ } });
  };
  return (
    <section className="mx-auto max-w-[620px] px-5 pt-14 pb-7">
      {dragging && dropHost ? createPortal(
        <div className="rc-drop" aria-hidden>
          <span className="text-[13px] font-semibold text-[var(--rc-accent-strong)]">여기에 파일을 놓으세요</span>
        </div>,
        dropHost,
      ) : null}
      <h2 className="m-0 mb-4 text-center text-[22px] font-bold tracking-tight">무엇을 만들까요?</h2>
      <form
        className="flex flex-col gap-2.5 rounded-xl border border-border bg-background px-3.5 pt-3.5 pb-2.5 shadow-xs transition-[box-shadow,border-color] focus-within:border-blue-600 focus-within:ring-3 focus-within:ring-blue-600/20"
        onSubmit={(e) => { e.preventDefault(); submit(); }}
      >
        {attError ? (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-1.5 text-xs text-destructive">
            <span className="min-w-0 flex-1 break-all leading-relaxed">{attError}</span>
            <Button type="button" variant="ghost" size="icon-xs" aria-label="닫기" className="shrink-0 text-destructive" onClick={() => setAttError(null)}><X /></Button>
          </div>
        ) : null}
        {atts.length > 0 ? (
          <AttachmentGroup className="flex-wrap gap-1.5 overflow-visible py-0">
            {atts.map((a) => {
              const img = a.mime.startsWith("image/") && !!a.dataUrl;
              return (
                <Attachment key={a.id} size="xs" state={a.uploading ? "uploading" : "done"} className="min-w-0 max-w-60">
                  <AttachmentMedia variant={img ? "image" : "icon"}>
                    {img ? <img src={a.dataUrl} alt={a.name} /> : <FileIcon aria-hidden />}
                  </AttachmentMedia>
                  <AttachmentContent>
                    <AttachmentTitle title={a.name}>{a.name}</AttachmentTitle>
                    <AttachmentDescription>{a.uploading ? `업로드 ${a.progress ?? 0}%` : fmtSize(a.size)}</AttachmentDescription>
                  </AttachmentContent>
                  <AttachmentActions>
                    <AttachmentAction aria-label="첨부 제거" onClick={() => removeAtt(a.id)}><X /></AttachmentAction>
                  </AttachmentActions>
                </Attachment>
              );
            })}
          </AttachmentGroup>
        ) : null}
        <Textarea
          ref={ta}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          onPaste={(e) => { const f = filesFrom(e.clipboardData); if (f.length) { e.preventDefault(); void addFiles(f); } }}
          maxLength={2000}
          rows={2}
          placeholder="만들고 싶은 에이전트를 적어 주세요"
          aria-label="만들 것을 말로 설명"
          className="min-h-[58px] resize-none border-0 bg-transparent px-0.5 py-0 text-[14.5px] leading-[1.55] shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-[14.5px]"
        />
        {/* 아래 줄 — 왼쪽 [+ 첨부], 오른쪽 [모델] [시작]. 사이드 챗 컴포저와 같은 배치라
            두 입력을 오가도 손이 같은 자리를 찾는다. */}
        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
          />
          <Button type="button" variant="ghost" size="icon-sm" aria-label="파일 첨부" title="파일 첨부"
            className="size-7 shrink-0 cursor-pointer rounded-full text-muted-foreground hover:text-foreground"
            onClick={() => fileRef.current?.click()}>
            <Plus />
          </Button>
          <span className="flex-1" />
          <DropdownMenu onOpenChange={(o) => { if (!o) setHover(null); }}>
            <DropdownMenuTrigger
              render={
                <Button type="button" variant="ghost" size="sm"
                  className="h-7 shrink-0 gap-1 px-2 text-xs font-normal text-muted-foreground hover:text-foreground">
                  {pick_ ? pick_.label : "모델"}
                  <ChevronDown className="size-3.5" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="min-w-44">
              {/* 아무것도 고르지 않는 것도 선택지다 — 기판이 쓰던 하네스·모델 그대로 */}
              <DropdownMenuItem onClick={() => setPick(null)}>
                기본값 {pick_ ? null : <CheckIcon className="ml-auto size-3.5" />}
              </DropdownMenuItem>
              {variants.length > 0 ? (
                // 공급자 → 그 공급자의 모델. 목록은 줄에 들어갈 때 한 번만 묻는다.
                variants.map((v) => {
                  const list = byVariant[v.name];
                  return (
                    <DropdownMenuSub key={v.name}>
                      <DropdownMenuSubTrigger onMouseEnter={() => setHover(v.name)} onFocus={() => setHover(v.name)}>
                        {providerLabelOf(v)}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent className="min-w-40">
                        {list === undefined ? (
                          <DropdownMenuItem disabled>불러오는 중…</DropdownMenuItem>
                        ) : list === null || list.length === 0 ? (
                          // 카탈로그를 못 읽어도 공급자는 고를 수 있어야 한다 — 모델은 그쪽 기본값.
                          <DropdownMenuItem onClick={() => setPick({ harness: v.name, model: "", label: providerLabelOf(v) })}>
                            {providerLabelOf(v)} 기본 모델
                          </DropdownMenuItem>
                        ) : (
                          list.map((m) => (
                            <DropdownMenuItem key={m.id}
                              onClick={() => setPick({ harness: v.name, model: m.id, label: m.label })}>
                              {m.label}
                            </DropdownMenuItem>
                          ))
                        )}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  );
                })
              ) : (
                // 변형이 하나뿐(capability 미선언) — 공급자 축이 없으니 모델만 편다.
                soloModels.map((m) => (
                  <DropdownMenuItem key={m.id} onClick={() => setPick({ harness: "", model: m.id, label: m.label })}>
                    {m.label}
                  </DropdownMenuItem>
                ))
              )}
              {variants.length === 0 && soloName ? (
                <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">{soloName}</DropdownMenuLabel>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* 포인트 컬러(블루)는 살짝만 — 시작 버튼·입력 포커스 둘뿐. 나머지는 neutral */}
          <Button type="submit" size="sm" disabled={uploading} className="shrink-0 rounded-full bg-blue-600 px-3.5 text-white hover:bg-blue-700">시작</Button>
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
      {/* 스토어는 보조 동선 — 예시 칩 아래의 옅은 글자 링크 한 줄, 스토어가 있을 때만.
          "받은 에이전트 파일 불러오기"는 2026-08-27 뺐다 — 사이드바 [+] 메뉴에 같은 동작이 있고,
          홈에서는 처음 온 사람이 고를 것이 "말하기" 하나로 보여야 한다. */}
      {nav.store ? (
        <p className="m-0 mt-4 flex items-center justify-center text-xs text-muted-foreground">
          <a href={nav.store} className="inline-flex items-center gap-1 text-inherit no-underline hover:text-foreground hover:underline underline-offset-3">
            <Store className="size-3.5" />스토어에서 골라 설치
          </a>
        </p>
      ) : null}
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
  const { live, empty } = splitDrafts(nav.drafts);
  const any = todo.length || live.length;
  return (
    <>
      {nav.attention?.credentials ? (
        // 연결 배너 — 필수인데 빈 자격의 수만 말한다(선택 자격의 빔으로는 뜨지 않는다). 넣는 자리는 연결 화면 하나다
        <div className="mx-5 mt-4 -mb-1.5 flex items-center gap-2 rounded-lg border border-border bg-muted/60 px-3.5 py-2 text-xs">
          <b className="font-semibold">연결 필요 {nav.attention.credentials}개</b> · 키를 넣어야 켜지는 기능이 있어요
          <span className="flex-1" />
          <a href={nav.connections} className="font-semibold text-blue-700 underline underline-offset-3">연결 화면 열기</a>
        </div>
      ) : null}
      {ups && nav.library ? (
        // 새 버전 요약 배너 — 개수만 말한다. 실행은 각 카드의 버튼(설치 동의 관문이 버전마다 선다)
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
      {any ? (
        <div className="mx-auto grid max-w-[1240px] gap-4 px-5 py-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(min(248px, 100%), 1fr))" }}>
          {todo.map((it) => <ItemCard key={it.pkg} it={it} library={nav.library} />)}
          {live.map((df) => <DraftCard key={df.name} df={df} />)}
        </div>
      ) : null}
      {empty.length ? <EmptyDrafts drafts={empty} /> : null}
    </>
  );
}

// preflight 가 없어 border 색은 매번 명시한다(border-border) — 기본값 currentColor 는 검정 테두리가 된다
// 색은 neutral 하나 — 상태는 채움색이 아니라 칩의 테두리/글자로만 가른다(오류만 붉게). 호버도 테두리 한 단계
const cardClass = "gap-2.5 rounded-xl border border-border px-5 py-4 shadow-none ring-0 transition-colors hover:border-foreground/30 [--card-spacing:0px]";
// 설명 줄 — 글자가 테두리에 닿고 두 줄이 붙어 있어 답답했다(2026-08-27). 줄간격을 넓히고
// 두 줄 자리(min-h)도 그만큼 늘린다 — 설명이 한 줄이어도 카드 아랫줄은 서로 맞아야 한다
const descClass = "m-0 line-clamp-2 min-h-[3.2em] text-[12.5px] leading-[1.6]";
const chip = "rounded-md px-1.5 py-0 text-[11px] font-semibold";

// 카드 전체가 링크다. 버튼은 두지 않는다 — 카드가 곧 그 초안/앱이고 누르면 고치러 가는 것이 이 격자의
// 뜻이라, 버튼은 같은 말을 두 번 하는 셈이다. 목적지(수정 화면)는 오른쪽 아래의 연필+"수정" 표시가
// 말한다(버튼 모양 아님, 호버에 진해진다). 예외는 목적지가 바깥(스토어 서재)인 업데이트뿐 — 그때만 버튼.
function ItemCard({ it, library }: { it: ShellItem; library: string | null }) {
  const act = cardAction(it, library);
  const desc = describe(it.description);
  return (
    <Card className={cn(cardClass, "group/hc")}>
      <a href={act.href} className="flex flex-col gap-2.5 text-inherit no-underline">
        <CardHeader className="flex flex-row items-center gap-2.5 px-0">
          <span className="flex size-[30px] shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted text-[13px] font-bold text-muted-foreground">
            {it.icon ? <img src={it.icon} alt="" className="block size-[30px] object-cover" /> : initialOf(it.label)}
          </span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13.5px]">{it.label}</b>
          </span>
          {it.resident ? <span className="size-[7px] shrink-0 rounded-full bg-emerald-500" title="도는 중" /> : null}
        </CardHeader>
        <CardContent className="px-0">
          <p className={cn(descClass, desc ? "text-muted-foreground" : "text-muted-foreground/60 italic")}>{desc ?? "설명이 아직 없어요"}</p>
        </CardContent>
        <CardFooter className="flex items-center gap-1.5 px-0">
          {/* 칩은 예외일 때만 — 이 격자에 선 것은 어차피 수정 중이라, 모든 카드에 같은 칩이 붙으면
              아무것도 가르지 못한다. 오류·새 버전만 칩을 단다(2026-08-27) */}
          {act.chip ? <StatusChip status={act.status}>{act.chip}</StatusChip> : null}
          {/* 이름@버전은 맨 아래 옅게 — 제목 바로 밑의 고정폭 글자는 설명보다 먼저 눈에 들어왔다(2026-08-27) */}
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/60" title={it.pkg}>{it.pkg}{it.version ? "@" + it.version : ""}</span>
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

// 수정 중은 여기 오지 않는다(칩 없음) — 남는 것은 오류·새 버전·초안뿐이라 붉은 것 하나와 나머지
function StatusChip({ status, children }: { status: CardAction["status"] | "draft"; children: React.ReactNode }) {
  if (status === "error") return <Badge variant="destructive" className={chip}>{children}</Badge>;
  return <Badge variant="outline" className={chip}>{children}</Badge>;
}

// 만드는 중인 초안 — 장부에 없어 설치 카드는 못 되지만, 어디에도 없으면 만들다 만 것이 잃은 것처럼
// 보인다. 설치본과 같은 격자에 같은 모양으로 세우고, 점선과 "초안" 칩으로만 가른다.
// 이름은 한 번만(설치본의 pkg 줄은 라벨과 다른 이름이라 뜻이 있지만 초안은 이름뿐이다)
function DraftCard({ df }: { df: ShellNav["drafts"][number] }) {
  return (
    <Card className={cn(cardClass, "group/hc border-dashed")}>
      <a href={df.href} className="flex flex-col gap-2.5 text-inherit no-underline">
        <CardHeader className="flex flex-row items-center gap-2.5 px-0">
          <span className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><FileText className="size-4" /></span>
          <span className="min-w-0 flex-1">
            <b className="block truncate text-[13.5px]">{df.name}</b>
          </span>
        </CardHeader>
        <CardContent className="px-0">
          <p className={cn(descClass, "text-muted-foreground")}>{draftLine(df.changes)}</p>
        </CardContent>
        <CardFooter className="flex items-center gap-1.5 px-0">
          <StatusChip status="draft">초안</StatusChip>
          <span className="min-w-0 truncate font-mono text-[10.5px] text-muted-foreground/60">{df.version ?? ""}</span>
          <span className="flex-1" />
          <EditHint />
        </CardFooter>
      </a>
    </Card>
  );
}

// ── 빈 초안 — 이름만 짓고 만 것. 카드가 아니라 한 줄이고, 여기서 바로 버릴 수 있다 ──────────
// 버리기는 스튜디오 ⋯ 메뉴 깊숙이만 있었다 — 빈 초안 세 개가 카드로 서 있는데 지울 길이 홈에 없었다(2026-08-27).
// 데몬 호출은 콘솔과 같은 문(/pkg/system/script/draft-discard). 손댄 초안(바뀐 파일 있음)은 여기 오지 않는다.
function EmptyDrafts({ drafts }: { drafts: DraftRef[] }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const discard = async (name: string) => {
    if (!confirm(`빈 초안 "${name}" 을 버릴까요? 되돌릴 수 없어요.`)) return;
    setBusy(name); setErr(null);
    try {
      const r = await fetch("/pkg/system/script/draft-discard", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input: { name } }) });
      if (!r.ok) { let m = "HTTP " + r.status; try { const d = await r.json(); if (d?.error) m = String(d.error); } catch { /* 본문 없음 */ } throw new Error(m); }
      window.dispatchEvent(new CustomEvent("relay:nav-refresh"));
    } catch (e: any) { setErr(`버리지 못했어요: ${String(e?.message || e)}`); }
    finally { setBusy(null); }
  };
  return (
    <div className="mx-5 mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>빈 초안 {drafts.length}개</span>
      {drafts.map((d) => (
        <span key={d.name} className="inline-flex items-center gap-0.5 rounded-md border border-dashed border-border px-1.5 py-0.5">
          <a href={d.href} className="text-inherit no-underline hover:text-foreground hover:underline underline-offset-3">{d.name}</a>
          <button type="button" aria-label={`${d.name} 버리기`} title="버리기" disabled={busy === d.name} onClick={() => void discard(d.name)}
            className="inline-flex cursor-pointer items-center border-0 bg-transparent p-0.5 text-muted-foreground/60 hover:text-destructive disabled:cursor-progress">
            <Trash2 className="size-3" />
          </button>
        </span>
      ))}
      {err ? <span className="text-destructive">{err}</span> : null}
    </div>
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

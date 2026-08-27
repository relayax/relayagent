/*!
 * Menus.tsx — 패널 헤더와 그 메뉴들: 대화함(InboxMenu), 대화 목록·새 대화·이름변경·삭제(SessionMenu),
 * 계정·로그아웃(AccountMenu), 이들을 배치하는 ChatHeader.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { RelayCtx, ConversationRow, ConversationsInfo, InboxRow } from "./runtime";
import { loadConversations, renameConversation, deleteConversation, loadInbox, serverAgentOf, serverParamOf } from "./runtime";
import { threadFamily, siblingThread, displayBinding } from "./routematch";
import { broadcastLogout } from "../auth-sync";
import { relTime, instanceLabelOf, agentLabelOf } from "./parts";
import { HeadDot } from "./Trace";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Item, ItemGroup, ItemSeparator, ItemMedia, ItemContent, ItemTitle, ItemDescription, ItemActions } from "@/components/ui/item";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

// 메뉴 공통 — 팝오버 본체(기본 p-4·w-72 를 목록용으로 좁힌다)와 목록 행. 배치·색은 전부 유틸리티,
// rc-sess-* 배치 규칙은 ChatTabs 가 아직 쓰므로 chat.css 에 남아 있지만 여기서는 더 쓰지 않는다.
const MENU = "block w-auto min-w-52 max-w-72 gap-0 p-1 text-[12.5px]";
// 목록이 길면 팝오버 대신 이 영역이 스크롤한다 — Root 와 Viewport 모두 높이를 잡아야 base-ui 뷰포트가 넘친다.
const LIST_SCROLL = "max-h-72 [&>[data-slot=scroll-area-viewport]]:max-h-72";
const ROW = "cursor-pointer rounded-md hover:bg-muted focus-visible:ring-1";
const ROW_ON = "bg-primary/10 font-semibold text-primary";
// 행 hover 액션(이름변경·삭제) — 평소엔 숨기고 hover/focus 시 노출, 터치 기기는 항상(hover 없음).
const ROW_ACTS = "ml-auto opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100 [@media(hover:none)]:opacity-100";
const ROW_TIME = "ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground group-hover/item:hidden group-focus-within/item:hidden [@media(hover:none)]:hidden";

/** 대화 전환 메뉴 — 현재 레인 패밀리의 스레드 목록 + "새 대화" (agent-package-layout.md §4 다중세션).
 *  수렴이 기본: 분기는 여기 "새 대화" 명시 클릭에서만. 다중세션은 상수 능력(2026-07-22 —
 *  구 manifest sessions/session_policy 게이트 은퇴, FDE·end-user 동일 뷰).
 *  목록은 열 때마다 재조회 — best-effort(실패=현재 대화만, "새 대화"도 잠김).
 *  행별 이름변경(연필)·삭제(휴지통) — VS Code 세션 목록 패리티. 이름은 세션 row 의 title
 *  (host.conversations.rename), 삭제는 세션+메시지 replay 파기(host.conversations.delete).
 *  seed(기본 대화)는 되돌아갈 자리라 삭제 불가 — 초기화는 /clear 가 담당. */
/** 대화함 — 내 신원이 가진 **전 인스턴스**의 대화 목록(출처 라벨 동반). 행 클릭 =
 *  같은 인스턴스면 대화 전환(onSwitch), 다른 인스턴스면 대상 전환(ctx.onRetarget — mount
 *  API 재마운트) 폴백은 그 인스턴스 채팅 문서로 이동. 데이터는 읽기 합성(사본 없음). */
function InboxMenu({ ctx, onSwitch }: { ctx: RelayCtx; onSwitch?: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  // 바깥 클릭·Escape 닫기는 Popover 가 맡는다 — 여기선 열릴 때 목록만 읽는다.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRows(null);
    loadInbox(ctx).then((r) => { if (alive) setRows(r); });
    return () => { alive = false; };
  }, [open, ctx.instanceId, ctx.principal]);
  const label = (r: InboxRow) => {
    if (r.title) return r.title;
    const id = r.conversation_id;
    if (id.startsWith("chat-")) return "기본 대화";
    return id.length > 22 ? id.slice(0, 22) + "…" : id;
  };
  const go = (r: InboxRow) => {
    setOpen(false);
    if (r.instance === ctx.instanceId) {
      if (r.conversation_id !== ctx.conversationId) onSwitch?.(r.conversation_id);
      return;
    }
    // 다른 인스턴스로의 전환은 onRetarget(호스트 주입)만 — 구 "/i/<id>/chat" 이동 폴백은
    // 클라이언트의 마운트 문법 조립이라 은퇴했다(§2-6). 미주입 마운트에서는 조용히 유지.
    if (ctx.onRetarget) ctx.onRetarget(r.instance, r.conversation_id);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
    <div className="rc-sess">
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-xs" className="rc-head-btn" />}
              aria-haspopup="menu" aria-expanded={open} aria-label="대화 목록" title="대화 목록 · 모든 에이전트의 대화">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 13h5l2 3h4l2-3h5" /><path d="M5 6h14l2 7v5a1 1 0 01-1 1H4a1 1 0 01-1-1v-5z" />
        </svg>
      </PopoverTrigger>
      {open && (
        <PopoverContent align="end" side="bottom" sideOffset={6} className={cn(MENU, "min-w-70")} role="menu">
          {rows === null ? (
            <ItemDescription className="px-2 py-2 text-xs">불러오는 중…</ItemDescription>
          ) : rows.length === 0 ? (
            <ItemDescription className="px-2 py-2 text-xs">대화가 없어요</ItemDescription>
          ) : (
            <ScrollArea className={LIST_SCROLL}>
              <ItemGroup role="presentation" className="gap-0.5">
                {rows.map((r) => {
                  const on = r.instance === ctx.instanceId && r.conversation_id === ctx.conversationId;
                  return (
                    <Item key={r.instance + "|" + r.conversation_id} size="xs" role="menuitemradio" tabIndex={0}
                          aria-checked={on} className={cn(ROW, on && ROW_ON)}
                          title={r.instance + " · " + r.conversation_id}
                          onClick={() => go(r)}
                          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(r); } }}>
                      {/* 출처(인스턴스) 칩 — 어느 에이전트의 대화인지 */}
                      <ItemMedia><Badge variant="outline" className="max-w-24 font-mono text-[10px]"><span className="truncate">{r.instance}</span></Badge></ItemMedia>
                      <ItemContent><ItemTitle className="block w-full truncate font-normal">{label(r)}</ItemTitle></ItemContent>
                      {r.last_started_at && <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{relTime(r.last_started_at)}</span>}
                    </Item>
                  );
                })}
              </ItemGroup>
            </ScrollArea>
          )}
        </PopoverContent>
      )}
    </div>
    </Popover>
  );
}

function SessionMenu({ ctx, onSwitch }: { ctx: RelayCtx; onSwitch: (c: string) => void }) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState<ConversationsInfo | null>(null);
  const [editing, setEditing] = useState<string | null>(null); // 이름 편집 중인 대화 id
  const [confirming, setConfirming] = useState<string | null>(null); // 삭제 확인 중인 대화 id
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const refresh = () => loadConversations(ctx).then(setInfo);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setEditing(null); setConfirming(null); setErr(null);
    loadConversations(ctx).then((i) => { if (alive) setInfo(i); });
    // 바깥 클릭·Escape 닫기는 Popover 가 맡는다.
    return () => { alive = false; };
  }, [open, ctx.instanceId, ctx.principal]);
  useEffect(() => { if (editing) editRef.current?.select(); }, [editing]);

  const family = threadFamily(ctx.conversationId);
  const rows = useMemo(() => {
    const byId = new Map<string, ConversationRow>();
    // seed(패밀리 기본 스레드)는 히스토리가 없어도 항상 목록에 — 되돌아갈 자리.
    const seed = family === "main" && ctx.conversationId.startsWith("chat-") ? ctx.conversationId : family;
    byId.set(seed, { conversation_id: seed });
    for (const c of info?.conversations ?? []) {
      if (threadFamily(c.conversation_id) !== family) continue;
      byId.set(c.conversation_id, c);
    }
    if (!byId.has(ctx.conversationId)) byId.set(ctx.conversationId, { conversation_id: ctx.conversationId });
    const list = [...byId.values()];
    list.sort((a, b) => {
      if (a.conversation_id === seed) return -1;
      if (b.conversation_id === seed) return 1;
      return Date.parse(b.last_started_at || "") - Date.parse(a.last_started_at || "") || 0;
    });
    return { seed, list };
  }, [info, family, ctx.conversationId]);

  // 목록 로드 실패(info=null)면 잠금 — 선민팅/전환이 헛돌 수 있는 상태라 분기만 보수적으로 막는다.
  const canBranch = info != null;
  const label = (c: ConversationRow) => {
    if (c.title) return c.title;
    if (c.conversation_id === rows.seed) return "기본 대화";
    return "새 대화";
  };

  const saveRename = async (c: ConversationRow, value: string) => {
    if (busy) return;
    setBusy(true); setErr(null);
    const ok = await renameConversation(ctx, c.conversation_id, value.trim());
    setBusy(false);
    if (!ok) { setErr("이름을 저장하지 못했어요"); return; }
    setEditing(null);
    await refresh();
  };

  const doDelete = async (c: ConversationRow) => {
    if (busy) return;
    setBusy(true); setErr(null);
    const ok = await deleteConversation(ctx, c.conversation_id);
    setBusy(false);
    if (!ok) { setErr("대화를 삭제하지 못했어요"); return; }
    setConfirming(null);
    if (c.conversation_id === ctx.conversationId) {
      // 보고 있던 대화를 지웠으면 seed 로 복귀(빈 스레드 잔상 방지).
      setOpen(false);
      onSwitch(rows.seed);
      return;
    }
    await refresh();
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
    <div className="rc-sess">
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-xs" className="rc-head-btn" />}
              aria-haspopup="menu" aria-expanded={open} aria-label="대화 목록" title="대화 목록 · 새 대화">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 5h16M4 12h16M4 19h10" />
        </svg>
      </PopoverTrigger>
      {open && (
        <PopoverContent align="end" side="bottom" sideOffset={6} className={MENU} role="menu">
          {info === null ? (
            <ItemDescription className="px-2 py-2 text-xs">불러오는 중…</ItemDescription>
          ) : (
            <>
              <ScrollArea className={LIST_SCROLL}>
              <ItemGroup role="presentation" className="gap-0.5">
              {rows.list.map((c) => {
                const id = c.conversation_id;
                if (editing === id) {
                  // 이름 편집 행 — 인라인 input(Enter=저장, Esc=취소)
                  return (
                    <Item key={id} size="xs" className="flex-nowrap">
                      <Input
                        ref={editRef}
                        className="h-7 min-w-0 flex-1 px-2 text-xs"
                        defaultValue={c.title || ""}
                        placeholder={label({ ...c, title: undefined })}
                        maxLength={120}
                        disabled={busy}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") { e.preventDefault(); void saveRename(c, (e.target as HTMLInputElement).value); }
                          if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                        }}
                      />
                      <ItemActions>
                        <Button type="button" variant="ghost" size="icon-xs" title="저장" aria-label="이름 저장" disabled={busy}
                                onClick={() => { const v = editRef.current?.value ?? ""; void saveRename(c, v); }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M2.5 8.5l3.5 3.5 7.5-8" />
                          </svg>
                        </Button>
                      </ItemActions>
                    </Item>
                  );
                }
                if (confirming === id) {
                  // 삭제 확인 행 — 위험 버튼 + 고스트 취소
                  return (
                    <Item key={id} size="xs" className="flex-nowrap">
                      <ItemContent><ItemTitle className="w-full font-normal">"{label(c)}" 삭제?</ItemTitle></ItemContent>
                      <ItemActions className="gap-1">
                        <Button type="button" variant="destructive" size="xs" disabled={busy}
                                onClick={() => void doDelete(c)}>{busy ? "삭제 중…" : "삭제"}</Button>
                        <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setConfirming(null)}>취소</Button>
                      </ItemActions>
                    </Item>
                  );
                }
                // 행 자체는 전환, 우측 hover 액션 = 이름변경·삭제(seed 는 삭제 없음 — 되돌아갈 자리).
                const on = id === ctx.conversationId;
                return (
                  <Item key={id} size="xs" role="menuitemradio" tabIndex={0}
                        aria-checked={on}
                        className={cn(ROW, "flex-nowrap", on && ROW_ON)}
                        title={id}
                        onClick={() => { setOpen(false); if (!on) onSwitch(id); }}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(false); if (!on) onSwitch(id); } }}>
                    <ItemContent><ItemTitle className="block w-full truncate font-[inherit]">{label(c)}</ItemTitle></ItemContent>
                    {c.last_started_at && <span className={ROW_TIME}>{relTime(c.last_started_at)}</span>}
                    <ItemActions className={cn(ROW_ACTS, "gap-0.5")}>
                      <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" title="이름 바꾸기" aria-label="이름 바꾸기"
                              onClick={(e) => { e.stopPropagation(); setConfirming(null); setErr(null); setEditing(id); }}>
                        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                          <path d="M11.3 2.3a1.6 1.6 0 012.4 2.4L5.5 12.9l-3 .6.6-3z" />
                        </svg>
                      </Button>
                      {id !== rows.seed && (
                        <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" title="대화 삭제" aria-label="대화 삭제"
                                onClick={(e) => { e.stopPropagation(); setEditing(null); setErr(null); setConfirming(id); }}>
                          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <path d="M2.5 4.5h11M6.5 2.5h3M5 4.5l.5 9h5l.5-9M6.8 7v4M9.2 7v4" />
                          </svg>
                        </Button>
                      )}
                    </ItemActions>
                  </Item>
                );
              })}
              </ItemGroup>
              </ScrollArea>
              {err && <ItemDescription className="px-2 py-1 text-xs text-destructive">{err}</ItemDescription>}
              <ItemSeparator className="my-1" />
              {canBranch ? (
                <Button type="button" variant="ghost" size="sm" className="w-full justify-start text-xs font-semibold text-primary"
                        onClick={() => {
                          setOpen(false);
                          // 로컬 드래프트 좌표 — 서버 세션은 첫 발화 직전 session.create 가
                          // 발급한다(지연 민팅, §5.3-22). 그 전까지 목록에는 없다(빈 로컬 상태).
                          const next = siblingThread(ctx.conversationId);
                          onSwitch(next);
                        }}>
                  ＋ 새 대화
                </Button>
              ) : (
                <ItemDescription className="px-2 py-2 text-xs">이 에이전트는 대화가 하나뿐이에요</ItemDescription>
              )}
            </>
          )}
        </PopoverContent>
      )}
    </div>
    </Popover>
  );
}

/** 계정 메뉴 — 현재 신원(email/principal) + 로그아웃. 위젯 헤더가 단일 소유라 core·저작 패키지
 *  전 인스턴스 뷰에 자동 노출된다(전송은 same-origin deployd 파사드 /api/me·/api/logout — 앱은
 *  토큰을 모른다). relay_edge 는 도메인 전역 쿠키 → 로그아웃은 모든 인스턴스 세션을 함께 종료한다.
 *  주의 — 인증 표면은 계약 밖·기판 소유다(client-protocol §2-5): 이 메뉴의 /api/me·/api/logout
 *  는 org 기판 잔류 어휘이고, principal 을 주입한 기판(org)에서만 렌더된다 — 무신원 loopback
 *  기판(OSS 기본, principal "local")은 헤더에서 이 메뉴 자체가 빠진다. */
function AccountMenu({ ctx }: { ctx: RelayCtx }) {
  const [open, setOpen] = useState(false);
  const [me, setMe] = useState<{ email?: string; id?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    fetch("/api/me").then((r) => (r.ok ? r.json() : null)).then((m) => { if (alive) setMe(m || {}); }).catch(() => { if (alive) setMe({}); });
    // 바깥 클릭·Escape 닫기는 Popover 가 맡는다.
    return () => { alive = false; };
  }, [open]);

  const who = me?.email || (ctx.principal && ctx.principal !== "local" ? ctx.principal : "") || me?.id || "로그인됨";
  const logout = () => {
    if (busy) return;
    setBusy(true);
    // 쿠키 파기는 서버가 정본(POST 실패해도 로그인 화면으로). 게이트가 미인증을 302 /login 처리하므로
    // location 을 /login 으로 보내 즉시 재로그인 표면을 연다.
    fetch("/api/logout", { method: "POST" })
      .catch(() => { /* best-effort */ })
      .finally(() => {
        // relay_edge 는 도메인 전역 쿠키라 서버 세션은 전 뷰가 함께 끝난다 — 같은 브라우징
        // 컨텍스트의 다른 뷰(탭·다른 인스턴스)에도 즉시 알려 로그인 화면으로 보낸다
        // (수신 = relayjs AuthWatch + 이 위젯 installAuthWatch; 씬클라 분리 웹뷰는
        //  BroadcastChannel 이 안 닿아 focus 시 /api/me 재검사가 커버).
        broadcastLogout();
        window.location.href = "/login";
      });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
    <div className="rc-sess">
      <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-xs" className="rc-head-btn" />}
              aria-haspopup="menu" aria-expanded={open} aria-label="계정" title="계정 · 로그아웃">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 12a4 4 0 100-8 4 4 0 000 8zM5 20c0-3.3 3.1-6 7-6s7 2.7 7 6" />
        </svg>
      </PopoverTrigger>
      {open && (
        <PopoverContent align="end" side="bottom" sideOffset={6} className={MENU} role="menu">
          {/* 신원 행 — 아바타(머리글자) + 계정 */}
          <Item size="xs" title={who}>
            <ItemMedia><Avatar size="sm"><AvatarFallback className="text-[10px] uppercase">{who.slice(0, 1)}</AvatarFallback></Avatar></ItemMedia>
            <ItemContent><ItemTitle className="block w-full truncate font-normal text-muted-foreground">{who}</ItemTitle></ItemContent>
          </Item>
          <ItemSeparator className="my-1" />
          <Item size="xs" role="menuitem" tabIndex={busy ? -1 : 0} aria-disabled={busy}
                className={cn(ROW, busy && "pointer-events-none opacity-50")}
                onClick={logout}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); logout(); } }}>
            <ItemMedia variant="icon">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
              </svg>
            </ItemMedia>
            <ItemContent><ItemTitle className="w-full font-normal">{busy ? "로그아웃 중…" : "로그아웃"}</ItemTitle></ItemContent>
          </Item>
        </PopoverContent>
      )}
    </div>
    </Popover>
  );
}

/** 패널 헤더 — 위젯이 단일 소유(연결 상태 표시 + 대화 전환 + 계정 + 접기, agent-package-layout.md §4).
 *  "어떤 에이전트와 연결됐는가"를 항상 보여준다: main=인스턴스 제목(통합/front), 도킹=에이전트
 *  이름 + 스레드 키(param) 배지. live=false 는 히스토리 로딩 스켈레톤 단계(runtime 밖 — 정적 점). */
export function ChatHeader({ ctx, live, onSwitch }: { ctx: RelayCtx; live: boolean; onSwitch?: (c: string) => void }) {
  // 로컬 스레드 문법 > 서버가 밝힌 세션 정체성(위임 대화 — §5.3-24 agent). 서버 발급 슬롯은
  // 문법을 못 실으므로(디렉토리명 제약) 이 폴백이 없으면 위임 대화가 착지 행세를 한다
  const rawBind = displayBinding(ctx.conversationId);
  const bind = rawBind.agent
    ? rawBind
    : { ...rawBind, agent: serverAgentOf(ctx.conversationId), param: serverParamOf(ctx.conversationId) };
  return (
    <header className="rc-head">
      {live ? <HeadDot /> : <span className="rc-dot" />}
      {/* 대상 칩 — 지금 누구와 말하는가(인스턴스 + 서브에이전트 도킹이면 :param 까지).
          대화함으로 대상을 바꿔도 ctx 가 정본이라 칩이 따라온다. */}
      {/* 칩에 ● 를 넣지 않는다 — 라이브 상태점(HeadDot)이 바로 왼쪽에 있어 중복. */}
      <span className="rc-head-target" title={ctx.instanceId + " · " + ctx.conversationId}>
        {/* 사람 말로 — "system / agent-builder:todo" 는 개발자 이름 그대로였다(2026-08-27). 원문은 title 에 남는다 */}
        <Badge variant="secondary" className="rc-chip"><span className="rc-chip-tx">{ctx.instanceId ? instanceLabelOf(ctx.instanceId) : ctx.title || "agent"}</span></Badge>
        {bind.agent && (
          <Badge variant="secondary" className="rc-chip"><span className="rc-chip-slash" aria-hidden>/</span><span className="rc-chip-tx">{agentLabelOf(bind.agent)}{bind.param ? " · " + bind.param : ""}</span></Badge>
        )}
      </span>
      <span className="rc-head-sp" />
      <InboxMenu ctx={ctx} onSwitch={onSwitch} />
      {onSwitch && <SessionMenu ctx={ctx} onSwitch={onSwitch} />}
      {/* 신원을 주입한 기판만 계정 표면이 있다(§2-5) — 무신원 기판에서 죽은 메뉴를 그리지 않는다. */}
      {ctx.principal && ctx.principal !== "local" && <AccountMenu ctx={ctx} />}
      {ctx.onClose && (
        <Button type="button" variant="ghost" size="icon-xs" className="rc-head-btn" onClick={ctx.onClose} aria-label="채팅 닫기" title="닫기">
          {/* X — "패널을 닫는다"를 직관적으로(구 chevron 은 '접기'로 읽히지 않았다). */}
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </Button>
      )}
    </header>
  );
}

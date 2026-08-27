/*!
 * Ask.tsx — 사용자에게 묻는 카드들: AskUserQuestion 질문 카드(AskCard), 얹기 표시(SteerCard),
 * script_ask 논블로킹 선택지(ChoiceCard). 골격은 shadcn Questionnaire — 회송 페이로드는 그대로.
 */
import { useState } from "react";
import { useMessage, useThread, useThreadRuntime } from "@assistant-ui/react";
import { CheckIcon, CornerDownRightIcon } from "lucide-react";
import { respondAsk, setPendingAttachments } from "./runtime";
import { useRelayCtx } from "./ctx";
import type { AnyPart } from "./parts";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";

/** 카드 껍데기 — 두 카드(AskCard·ChoiceCard)가 같은 틀을 쓴다. live = 답을 기다리는 중. */
const shell = "flex w-full max-w-[520px] flex-col gap-3 rounded-xl border border-border bg-card p-4 text-sm text-card-foreground shadow-xs animate-in fade-in-0 slide-in-from-bottom-1 duration-200";
const shellLive = "border-primary/40 ring-3 ring-primary/10";
const foot = "flex min-h-[18px] flex-wrap items-center gap-2 text-xs text-muted-foreground";

/** AskUserQuestion 질문 카드 — 세션 pod 가 stdio can_use_tool 채널에서 답변을 기다린다.
 *  즉시 전달은 "질문 1개 + 단일선택"일 때만 — 질문이 여럿이거나 multiSelect 면 모든 질문을
 *  채운 뒤 "답변 보내기"로 한 번에 회송한다(한 질문만 눌러 카드가 조기 완료되는 버그 방지).
 *  답변/타임아웃 후엔 tool result 가 도착해(part.result) 카드가 완료 상태로 굳는다.
 *  Questionnaire 는 한 번에 한 문항만 펼친다(비활성 문항은 hidden+inert, 마운트 유지 → 선택 보존).
 *  옛 탭 스트립처럼 아무 문항으로나 건너뛸 수 있게 `item` 을 제어 모드로 잡고 탭 줄은 Button 으로 둔다. */
export function AskCard({ part, active }: { part: AnyPart; active: boolean }) {
  const ctx = useRelayCtx();
  const [sent, setSent] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sel, setSel] = useState<Record<number, string[]>>({});
  const [tab, setTab] = useState(0); // 다중 질문 — 활성 문항 인덱스
  const [text, setText] = useState<Record<number, string>>({}); // 문항별 자유입력 초안
  const done = part.result !== undefined || part.isError;
  const questions: any[] = Array.isArray(part.args?.questions) ? part.args.questions : [];
  const waiting = active && !done && !sent;
  // 즉시 전달 = 질문 1개 & 단일선택뿐. 그 외는 전부 누적 후 명시 전송(부분 제출 봉쇄).
  const instant = questions.length === 1 && !questions[0]?.multiSelect;

  const submit = async (answers: Array<{ question: string; header?: string; selected: string[] }>) => {
    setSent(true);
    const ok = await respondAsk(ctx, answers);
    if (!ok) { setFailed(true); setSent(false); }
  };
  // 첫 답이 확정된 단일선택 문항에서 다음 미응답 문항으로 자동 이동.
  const advance = (qi: number, q: any, wasEmpty: boolean) => {
    if (questions.length > 1 && !q.multiSelect && wasEmpty) {
      const next = questions.findIndex((_, i) => i !== qi && (sel[i]?.length ?? 0) === 0);
      if (next >= 0) setTab(next);
    }
  };
  const pick = (qi: number, q: any, label: string) => {
    if (!waiting) return;
    if (instant) {
      setSel({ [qi]: [label] });
      void submit([{ question: q.question, header: q.header, selected: [label] }]);
      return;
    }
    // 누적: multiSelect=토글, 단일선택=라벨 교체(라디오 — 질문당 하나).
    const wasEmpty = (sel[qi]?.length ?? 0) === 0;
    setSel((prev) => {
      const cur = prev[qi] ?? [];
      if (q.multiSelect) {
        return { ...prev, [qi]: cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label] };
      }
      return { ...prev, [qi]: cur.includes(label) ? [] : [label] };
    });
    advance(qi, q, wasEmpty);
  };
  // 자유입력(직접 입력) — 네이티브 AskUserQuestion "Other" 등가. 임의 문자열을 selected 로
  // 회송(mergeAskAnswers 가 join → {질문:값}). instant 는 즉시 회송, 누적 모드는 이 질문 답으로
  // 굳힌다(단일선택=치환, multiSelect=옵션 선택에 덧댐). 굳힌 값은 선택지 목록 끝에 체크된
  // 선택지로 나타나 다시 끌 수 있다.
  const freeSubmit = (qi: number, q: any) => {
    if (!waiting) return;
    const v = (text[qi] ?? "").trim();
    if (!v) return;
    if (instant) {
      setSel({ [qi]: [v] });
      void submit([{ question: q.question, header: q.header, selected: [v] }]);
      return;
    }
    const wasEmpty = (sel[qi]?.length ?? 0) === 0;
    setSel((prev) => ({
      ...prev,
      [qi]: q.multiSelect ? [...(prev[qi] ?? []).filter((l) => l !== v), v] : [v],
    }));
    setText((prev) => ({ ...prev, [qi]: "" }));
    advance(qi, q, wasEmpty);
  };
  const sendMulti = () => {
    void submit(questions.map((q, qi) => ({ question: q.question, header: q.header, selected: sel[qi] ?? [] })));
  };
  const answered = questions.filter((_, qi) => (sel[qi]?.length ?? 0) > 0).length;
  const allAnswered = answered === questions.length;

  if (questions.length === 0) return null;
  const tabbed = questions.length > 1; // 다중 질문은 한 문항씩 펼쳐 카드 높이를 한 질문만큼으로 유지
  const optionsOf = (q: any): any[] => (Array.isArray(q.options) ? q.options : []);

  // 답한 뒤(전송됨·완료) — 읽기 전용 요약. 선택을 모르는 리플레이는 물었던 선택지만 흐리게 보인다.
  if (!waiting) {
    return (
      <div className={shell} role="group" aria-label="질문 답변 요약">
        {questions.map((q, qi) => {
          const chosen = sel[qi] ?? [];
          return (
            <div key={qi} className="flex flex-col gap-1.5">
              <Marker className="items-start text-foreground">
                <MarkerIcon className={cn("mt-0.5", done || sent ? "text-primary" : "")}><CheckIcon /></MarkerIcon>
                <MarkerContent className="font-medium">
                  {q.header && <Badge variant="secondary" className="me-1.5 align-middle">{q.header}</Badge>}
                  {q.question}
                </MarkerContent>
              </Marker>
              <div className="flex flex-wrap gap-1.5 ps-6">
                {chosen.length > 0
                  ? chosen.map((l) => <Badge key={l} variant="outline" className="h-auto whitespace-normal">{l}</Badge>)
                  : optionsOf(q).map((o: any, oi: number) => (
                      <Badge key={oi} variant="outline" className="h-auto whitespace-normal text-muted-foreground">{o?.label}</Badge>
                    ))}
              </div>
            </div>
          );
        })}
        <div className={foot}>
          {sent && !done && <span>답변을 보냈어요 · 이어서 진행 중…</span>}
          {done && <span className="font-semibold text-primary">✓ 답변 완료</span>}
          {!sent && !done && <span>답변 기한이 지났어요</span>}
        </div>
      </div>
    );
  }

  return (
    <Questionnaire
      className={cn(shell, shellLive, "gap-3")}
      item={`q${tab}`}
      onItemChange={(name) => { const i = Number(name.slice(1)); if (Number.isFinite(i)) setTab(i); }}
      onSubmit={(e) => { e.preventDefault(); if (waiting && !instant && allAnswered) sendMulti(); }}
    >
      {tabbed && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="질문 목록">
            {questions.map((q, qi) => {
              const on = (sel[qi]?.length ?? 0) > 0;
              return (
                <Button type="button" key={qi} role="tab" aria-selected={qi === tab} size="xs"
                        variant={qi === tab ? "secondary" : "outline"}
                        className={cn("rounded-full", qi === tab && "border-primary/40 text-primary", on && qi !== tab && "text-foreground")}
                        onClick={() => setTab(qi)}>
                  <span className="max-w-[140px] truncate">{q.header || `질문 ${qi + 1}`}</span>
                  {on && <CheckIcon className="text-primary" aria-hidden />}
                </Button>
              );
            })}
          </div>
          <QuestionnaireProgress aria-valuetext={`${questions.length}개 중 ${tab + 1}번째 질문`} className="min-w-0">
            {tab + 1} / {questions.length}
          </QuestionnaireProgress>
        </div>
      )}
      {questions.map((q, qi) => {
        const options = optionsOf(q);
        const labels = options.map((o: any) => o?.label ?? "");
        const cur = sel[qi] ?? [];
        const custom = cur.filter((v) => !labels.includes(v)); // 직접 입력으로 굳힌 값
        const draft = (text[qi] ?? "").trim();
        return (
          <QuestionnaireItem key={qi} name={`q${qi}`} multiple={!!q.multiSelect} required className="gap-3">
            <QuestionnaireTitle className="text-sm leading-snug">
              {!tabbed && q.header && <Badge variant="secondary" className="me-1.5 align-middle">{q.header}</Badge>}
              {q.question}
            </QuestionnaireTitle>
            <QuestionnaireChoices className="gap-1.5">
              {options.map((o: any, oi: number) => {
                const label = o?.label ?? "";
                return (
                  <QuestionnaireChoice key={oi} value={label} checked={cur.includes(label)} disabled={!waiting}
                                       className="min-h-9 px-3 py-2" onChange={() => pick(qi, q, label)}>
                    <span className="font-medium">{label}</span>
                    {o?.description && <QuestionnaireChoiceDescription className="text-xs">{o.description}</QuestionnaireChoiceDescription>}
                  </QuestionnaireChoice>
                );
              })}
              {custom.map((v) => (
                <QuestionnaireChoice key={"custom:" + v} value={v} checked disabled={!waiting}
                                     className="min-h-9 px-3 py-2" onChange={() => pick(qi, q, v)}>
                  <span className="font-medium">{v}</span>
                  <QuestionnaireChoiceDescription className="text-xs">직접 입력</QuestionnaireChoiceDescription>
                </QuestionnaireChoice>
              ))}
            </QuestionnaireChoices>
            <QuestionnaireError className="text-xs">답을 하나 골라 주세요</QuestionnaireError>
            {/* 자유 입력줄 — Questionnaire 의 답 추적 밖(plain Input). Enter 는 폼 제출이 아니라 "입력". */}
            <div className="flex items-stretch gap-1.5">
              <Input type="text" className="h-8 min-w-0 flex-1" placeholder="또는 직접 입력…" aria-label="직접 입력"
                     value={text[qi] ?? ""} disabled={!waiting}
                     onChange={(e) => setText((prev) => ({ ...prev, [qi]: e.target.value }))}
                     onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); freeSubmit(qi, q); } }} />
              <Button type="button" variant="outline" size="sm" className="shrink-0" disabled={!waiting || !draft}
                      onClick={() => freeSubmit(qi, q)}>{instant ? "보내기" : "입력"}</Button>
            </div>
          </QuestionnaireItem>
        );
      })}
      {instant ? (
        <div className={foot}>
          <span>선택하면 바로 보내요</span>
          {failed && <span className="text-destructive">답을 보내지 못했어요 · 다시 골라 주세요</span>}
        </div>
      ) : (
        <>
          <QuestionnaireActions className="min-h-8 sm:min-h-8">
            <QuestionnairePrevious size="sm">이전</QuestionnairePrevious>
            <QuestionnaireNext size="sm" variant="outline">다음</QuestionnaireNext>
            <QuestionnaireSubmit size="sm" disabled={!allAnswered}>
              답변 보내기{allAnswered ? "" : ` (${answered}/${questions.length})`}
            </QuestionnaireSubmit>
          </QuestionnaireActions>
          {failed && <div className={foot}><span className="text-destructive">답을 보내지 못했어요 · 다시 골라 주세요</span></div>}
        </>
      )}
    </Questionnaire>
  );
}

/** 얹기 카드 — 턴이 도는 중에 사용자가 더한 말을 그 말이 들어간 자리에 세운다.
 *  말풍선이 아니라 흐름 안의 표시인 이유: 이것은 새 턴의 시작이 아니라 **이 턴에 얹힌 것**이고,
 *  화면이 그 차이를 지워 버리면 사용자는 자기 말이 다음 턴으로 밀렸다고 읽는다.
 *  왼쪽 세로선이 "여기서부터 방향이 바뀌었다"를 도구 카드들 사이에서 눈에 걸리게 한다. */
export function SteerCard({ part }: { part: AnyPart }) {
  const text = String(part?.args?.text ?? part?.argsText ?? "");
  if (!text) return null;
  return (
    <Marker role="note"
            className="my-0.5 w-fit max-w-[520px] items-start rounded-r-lg border-l-2 border-primary bg-muted px-3 py-1.5 text-[13px] leading-relaxed text-foreground animate-in fade-in-0 slide-in-from-bottom-1 duration-200">
      <MarkerIcon className="mt-0.5 text-primary"><CornerDownRightIcon /></MarkerIcon>
      <MarkerContent className="whitespace-pre-wrap [overflow-wrap:anywhere]">{text}</MarkerContent>
    </Marker>
  );
}

/** script_ask 선택지 카드(논블로킹) — @relay/builder ask 스크립트가 tool_use 로 표시만
 *  요청하고 턴을 끝낸다(핸들러 즉시 반환). AskCard(mid-turn respond 회송)와 달리 답이
 *  "다음 턴의 프롬프트"다: 클릭 = 라벨을 사용자 메시지로 전송 — rt.append 는 idle 스레드에서
 *  새 턴을 시작하는 정본 경로(Composer.sendNow·AttachOnMount 와 동일). 턴 실행 중이거나
 *  이미 답했으면(카드 뒤 user 메시지 존재) 비활성 — 리플레이에선 다음 user 메시지가 옵션
 *  라벨과 일치할 때 선택 표시를 복원한다. Questionnaire 문항 하나(라디오)로 그린다. */
export function ChoiceCard({ part }: { part: AnyPart }) {
  const rt = useThreadRuntime();
  const running = useThread((t) => t.isRunning);
  const msgId = useMessage((m) => m.id);
  // 카드가 속한 메시지 뒤 첫 user 메시지의 텍스트 = 이미 도착한 답(리플레이 포함). null = 미답.
  const answer = useThread((t) => {
    const idx = t.messages.findIndex((m) => m.id === msgId);
    if (idx < 0) return null;
    for (let i = idx + 1; i < t.messages.length; i++) {
      const m: any = t.messages[i];
      if (m.role !== "user") continue;
      const c = m.content;
      return Array.isArray(c)
        ? c.filter((x: any) => x && x.type === "text").map((x: any) => x.text).join("\n")
        : typeof c === "string" ? c : "";
    }
    return null;
  });
  const [picked, setPicked] = useState<string | null>(null);

  // 스트리밍 중엔 args 가 비고 argsText 가 partial JSON 일 수 있다 — 파싱 실패 = 스켈레톤
  // (크래시 금지). 완결 assistant 프레임이 args 를 채우면 자연히 실카드로 전환된다.
  let a: any = part.args && typeof part.args === "object" && Object.keys(part.args).length ? part.args : null;
  if (!a && typeof part.argsText === "string" && part.argsText.trim()) {
    try { a = JSON.parse(part.argsText); } catch { a = null; }
  }
  const options: { label: string; description: string }[] = Array.isArray(a?.options)
    ? a.options
        .filter((o: any) => o && typeof o.label === "string" && o.label)
        .map((o: any) => ({ label: o.label, description: typeof o.description === "string" ? o.description : "" }))
    : [];
  const question = typeof a?.question === "string" ? a.question : "";
  if (!question && options.length === 0) {
    return (
      <div className={shell} role="status" aria-label="선택지 준비 중">
        <div className="inline-flex items-center gap-2 text-xs text-muted-foreground"><Spinner aria-hidden /> 선택지 준비 중…</div>
      </div>
    );
  }
  const header = typeof a?.header === "string" ? a.header : "";
  const chosen = picked ?? (answer != null && options.some((o) => o.label === answer) ? answer : null);
  const disabled = running || picked != null || answer != null;
  const send = (label: string) => {
    if (disabled) return;
    setPicked(label);
    setPendingAttachments([]); // 단일 슬롯 홀더 오염 방지 — 이 턴은 첨부 없음
    rt.append({ role: "user", content: [{ type: "text", text: label }] });
  };
  return (
    <Questionnaire className={cn(shell, !disabled && shellLive)} onSubmit={(e) => e.preventDefault()}>
      <QuestionnaireItem name="choice" className="gap-3">
        <QuestionnaireTitle className="text-sm leading-snug">
          {header && <Badge variant="secondary" className="me-1.5 align-middle">{header}</Badge>}
          {question}
        </QuestionnaireTitle>
        <QuestionnaireChoices className="gap-1.5">
          {options.map((o, i) => {
            const on = chosen === o.label;
            return (
              // 답한 뒤에도 고른 선택지는 또렷하게(disabled 흐림 해제) — 무엇을 골랐는지가 기록이다.
              <QuestionnaireChoice key={i} value={o.label} checked={on} disabled={disabled}
                                   className={cn("min-h-9 px-3 py-2", on && "data-disabled:opacity-100")}
                                   onChange={() => send(o.label)}>
                <span className="font-medium">{o.label}</span>
                {o.description && <QuestionnaireChoiceDescription className="text-xs">{o.description}</QuestionnaireChoiceDescription>}
              </QuestionnaireChoice>
            );
          })}
        </QuestionnaireChoices>
      </QuestionnaireItem>
      {!disabled && <div className={foot}><span>선택하면 바로 보내요</span></div>}
    </Questionnaire>
  );
}

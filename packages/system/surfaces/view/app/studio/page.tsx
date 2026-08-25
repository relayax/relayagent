"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentScope, onAgentTurn } from "@relay/chat";
import { parse as parseYaml, parseDocument } from "yaml";
import CodeEditor, { type Mark } from "@/components/CodeEditor";
import DeclTree from "@/components/DeclTree";
import Palette from "@/components/Palette";
import Preview, { materialOf, type PreviewCtx } from "@/components/Preview";
import SectionView, { type SectionCtx } from "@/components/SectionView";
import { CommitDialog, DiscardDialog, PublishDialog, ReleasesDialog } from "@/components/StudioDialogs";
import { fetchRegistry } from "@/lib/api";
import type { Made } from "@/lib/create";
import { SECTIONS } from "@/lib/sections";
import {
  draftList,
  draftOpen,
  draftRead,
  draftReadFile,
  draftValidate,
  draftWrite,
  fetchSchema,
  packPkg,
  type DraftStatus,
  type PublishOutcome,
  type Verdict,
} from "@/lib/studio";
import type { Manifest, Registry } from "@/lib/types";

// 스튜디오 = 패키지 하나의 수정 레이어를 여는 IDE. URL 쿼리가 depth 의 정본이다:
//   /studio/?pkg=x              depth 1  개요 (relay.yaml 에디터)
//   /studio/?pkg=x&sec=agents   depth 2  섹션 (선언 폼 + 파일 카드)
//   /studio/?pkg=x&...&file=f   depth 3  파일 (에디터 전면)
// 정적 발행(output: export)이라 동적 세그먼트 대신 쿼리를 쓴다.
// 모든 편집은 draft 로 간다 — 설치본(live)을 만지는 화면 경로는 없다.
//
// 화면은 세 면이다: 선언 트리 · 고치는 자리 · **결과면**. 셋째 면이 없던 동안 결과로 가는 문은
// [적용] 뿐이었고, 그건 미리보기가 아니라 발행이었다 — 저작의 되먹임이 "고친다 → 도는 판을
// 갈아치운다 → 본다" 였다는 뜻이다. 결과면의 모양은 재료가 정한다(lib/sections.ts Material).

type LogLine = { kind: "ok" | "err" | "info"; text: string; href?: string };
type Dialog = null | "commit" | "publish" | "releases" | "discard";

export default function StudioPage() {
  return (
    <Suspense fallback={null}>
      <Studio />
    </Suspense>
  );
}

function Studio() {
  const router = useRouter();
  const sp = useSearchParams();
  const pkg = sp.get("pkg");
  const sec = sp.get("sec");
  const item = sp.get("item");
  const file = sp.get("file");
  const isNew = sp.get("new") === "1";

  const [status, setStatus] = useState<DraftStatus | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [schema, setSchema] = useState<any>(null);
  const [buf, setBuf] = useState<{ path: string; content: string; dirty: boolean } | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // 동시 편집 판정에 걸린 파일 — 배너가 "새 내용 읽기 / 덮어쓰기" 를 묻는다
  const [conflict, setConflict] = useState<string | null>(null);
  // 이 패키지의 빌더 대화에서 턴이 도는 중 (relay:turn started↔settled)
  const [agentBusy, setAgentBusy] = useState(false);
  const [reg, setReg] = useState<Registry | null>(null);
  const [palette, setPalette] = useState(false);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  // 폼 조작의 되돌리기. 눈금은 relay.yaml 전문이다 — 폼 한 번이 문서 한 판을 만들기 때문이고,
  // 그 판을 통째로 되돌리는 것이 "방금 그 조작"의 정확한 역이다. draft 의 git 이 그물을 치지만
  // 그 그물의 눈금은 커밋이라, 눌러 본 것 하나를 물릴 단위가 없었다 — 그러면 사람은 과감해지지
  // 않는다. 텍스트 편집은 CodeMirror 의 이력이 따로 맡는다(에디터 안에서 ⌘Z)
  const [undo, setUndo] = useState<string[]>([]);
  const [redo, setRedo] = useState<string[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 경로별 마지막 읽기 지문 — draft-write 의 base. 디바운스 발화 시점에 읽어야 하므로
  // (in-flight 저장이 지문을 갱신하는 사이 잡힌 클로저가 낡은 값을 들 수 있다) ref 다
  const bufHash = useRef<Record<string, string | null>>({});

  const say = useCallback((kind: LogLine["kind"], text: string, href?: string) => {
    setLog((l) => [{ kind, text, href }, ...l].slice(0, 200));
  }, []);

  const nav = useCallback(
    (q: { sec?: string | null; item?: string | null; file?: string | null }) => {
      const p = new URLSearchParams();
      if (pkg) p.set("pkg", pkg);
      const s = q.sec === undefined ? sec : q.sec;
      const it = q.item === undefined ? item : q.item;
      const f = q.file === undefined ? file : q.file;
      if (s) p.set("sec", s);
      if (s && it) p.set("item", it);
      if (f) p.set("file", f);
      router.push(`/studio/?${p.toString()}`);
    },
    [router, pkg, sec, item, file],
  );

  useEffect(() => {
    void fetchSchema().then(setSchema).catch(() => setSchema(null));
  }, []);

  // 배선 재료의 결과면이 콘솔의 지도를 그대로 쓴다 — 이웃(제공자·소비자)이 장부에 있다
  const loadReg = useCallback(() => {
    void fetchRegistry().then(setReg).catch(() => setReg(null));
  }, []);
  useEffect(() => { loadReg(); }, [loadReg]);

  const refresh = useCallback(async () => {
    if (!pkg) return;
    try {
      setStatus(await draftRead(pkg));
    } catch (e) {
      say("err", String(e instanceof Error ? e.message : e));
    }
  }, [pkg, say]);

  // 진입 = draft 열기. 오타 이름으로 빈 draft 가 생기지 않게 설치본·기존 draft 만 자동으로 연다
  useEffect(() => {
    if (!pkg) return;
    let on = true;
    setStatus(null);
    setFatal(null);
    void (async () => {
      try {
        const [known0, dl] = await Promise.all([fetchRegistry(), draftList()]);
        if (!on) return;
        const known = known0.packages.some((p) => p.name === pkg) || dl.drafts.some((d) => d.name === pkg);
        if (!known) {
          setFatal(`없는 패키지: ${pkg} — 콘솔에서 진입하거나 새 패키지로 만드세요`);
          return;
        }
        await draftOpen(pkg);
        if (!on) return;
        setStatus(await draftRead(pkg));
      } catch (e) {
        if (on) setFatal(String(e instanceof Error ? e.message : e));
      }
    })();
    return () => {
      on = false;
    };
  }, [pkg]);

  // depth 1 의 캔버스는 relay.yaml 에디터다 — file 미지정이면 relay.yaml 이 열린 것과 같다
  const effFile = file ?? (!sec && !isNew && pkg ? "relay.yaml" : null);

  useEffect(() => {
    setConflict(null); // 판정은 파일 단위다 — 다른 파일로 옮기면 배너도 접는다
    if (!pkg || !effFile || !status) {
      if (!effFile) setBuf(null);
      return;
    }
    if (buf?.path === effFile) return;
    let on = true;
    void draftReadFile(pkg, effFile)
      .then((r) => {
        if (!on) return;
        bufHash.current[r.file] = r.hash;
        setBuf({ path: r.file, content: r.content, dirty: false });
      })
      .catch((e) => {
        if (!on) return;
        bufHash.current[effFile] = null; // 없는 파일로 알고 시작 — 그 사이 생기면 그것도 충돌
        setBuf({ path: effFile, content: "", dirty: false });
        say("err", `${effFile}: ${String(e instanceof Error ? e.message : e)}`);
      });
    return () => {
      on = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg, effFile, status?.name]);

  const scheduleSave = useCallback(
    (path: string, content: string) => {
      if (!pkg) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        // base = 이 버퍼가 마지막으로 읽은 판의 지문. 그 사이 다른 손(빌더·CLI·다른 화면)이
        // 고쳤으면 기판이 E_CONFLICT 로 거절한다 — 전문 쓰기가 남의 작업을 되덮는 사고 방지
        void draftWrite(pkg, { [path]: content }, undefined, { [path]: bufHash.current[path] ?? null })
          .then(async (r) => {
            bufHash.current[path] = r.hashes?.[path] ?? null;
            setBuf((b) => (b && b.path === path && b.content === content ? { ...b, dirty: false } : b));
            await refresh();
          })
          .catch((e) => {
            const msg = String(e instanceof Error ? e.message : e);
            if (msg.includes("E_CONFLICT")) {
              setConflict(path);
              say("err", `다른 손이 ${path} 을(를) 먼저 고쳤습니다 — 편집기 위 배너에서 처리를 고르세요`);
            } else say("err", `저장 실패 ${path}: ${msg}`);
          });
      }, 600);
    },
    [pkg, refresh, say],
  );

  const onEdit = useCallback(
    (text: string) => {
      setBuf((b) => (b ? { ...b, content: text, dirty: true } : b));
      if (buf) scheduleSave(buf.path, text);
    },
    [buf, scheduleSave],
  );

  // 폼 편집(디스크리트 커밋)은 디바운스 없이 바로 쓴다. base = 폼이 편집한 Document 의
  // 원천(status.manifest)을 읽던 시점 지문 — 충돌이면 낡은 폼 위의 조작이라 새로 읽고 다시 한다
  const writeManifest = useCallback(
    (text: string, history: "push" | "none" = "push"): Promise<void> => {
      if (!pkg) return Promise.resolve();
      // 되돌릴 판은 **쓰기 직전의 문서**다. 성공 뒤에 담으면 그 사이 다른 손이 끼어든 판을
      // 담게 되고, 되돌리기가 남의 조작까지 물린다
      if (history === "push" && status?.manifest != null && status.manifest !== text) {
        const prev = status.manifest;
        setUndo((u) => [...u.slice(-49), prev]);
        setRedo([]);
      }
      const base = status?.hashes?.["relay.yaml"] ?? null;
      return draftWrite(pkg, { "relay.yaml": text }, undefined, { "relay.yaml": base })
        .then(async (r) => {
          bufHash.current["relay.yaml"] = r.hashes?.["relay.yaml"] ?? null;
          setBuf((b) => (b && b.path === "relay.yaml" ? { path: b.path, content: text, dirty: false } : b));
          await refresh();
        })
        .catch(async (e) => {
          const msg = String(e instanceof Error ? e.message : e);
          if (msg.includes("E_CONFLICT")) {
            setConsoleOpen(true);
            say("err", "다른 손이 relay.yaml 을 먼저 고쳤습니다 — 새로 읽었으니 방금 조작을 다시 해주세요");
            await refresh();
          } else say("err", `저장 실패 relay.yaml: ${msg}`);
        });
    },
    [pkg, status, refresh, say],
  );

  /**
   * 폼 조작 되돌리기. 되돌리기 자체가 새 눈금을 만들면 무한히 오가게 되므로 history:"none" 으로
   * 쓰고, 현재 판을 반대편 더미에 넣는다. base 검사는 그대로 지난다 — 되돌리기도 쓰기다.
   */
  const stepHistory = useCallback(
    (dir: "undo" | "redo") => {
      const from = dir === "undo" ? undo : redo;
      if (!from.length || !status) return;
      const text = from[from.length - 1];
      const cur = status.manifest;
      if (dir === "undo") {
        setUndo((u) => u.slice(0, -1));
        setRedo((r) => [...r, cur]);
      } else {
        setRedo((r) => r.slice(0, -1));
        setUndo((u) => [...u, cur]);
      }
      writeManifest(text, "none");
      say("info", dir === "undo" ? "폼 조작을 되돌렸습니다" : "다시 적용했습니다");
    },
    [undo, redo, status, writeManifest, say],
  );

  // ⌘Z 는 에디터 안에서는 CodeMirror 의 것이다 — 입력 요소 밖에서만 폼 이력을 집는다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.(".cm-editor, input, textarea, select")) return;
      e.preventDefault();
      stepHistory(e.shiftKey ? "redo" : "undo");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepHistory]);

  // relay:turn(view-bridge §6-a) — 같은 문서에서 시킨 턴이 끝나면 화면이 스스로 신선해진다.
  // 힌트 소비 규율: payload 는 상태가 아니라 재조회의 트리거다(멱등 — 재생 중복 무해).
  // 핸들러가 렌더 시점 값(열린 파일·dirty)을 봐야 하므로 ref 로 나른다 — deps 로 넣으면
  // 타이핑마다 구독이 재생성된다
  const liveView = useRef({ file: null as string | null, dirty: false });
  liveView.current = { file: effFile, dirty: !!buf?.dirty };
  useEffect(() => {
    if (!pkg) return;
    return onAgentTurn((s) => {
      // 칩은 이 패키지의 빌더 대화만 — param 은 slug 목록일 수 있다(client-protocol §5.3-21)
      const mine = s.agent === "agent-builder" && (!s.param || s.param.split(",").includes(pkg));
      if (s.phase === "started") {
        if (mine) setAgentBusy(true);
        return;
      }
      if (mine) setAgentBusy(false);
      // 재조회는 대화 불문 — system 에이전트가 직접 draft 를 고치는 경로도 있고, 재조회는 싸다
      void refresh();
      const { file, dirty } = liveView.current;
      if (!file || dirty) return; // dirty 버퍼는 base 검사가 지킨다 — 힌트로 덮지 않는다
      void draftReadFile(pkg, file)
        .then((r) => {
          bufHash.current[r.file] = r.hash;
          setBuf((b) => (b && b.path === file && !b.dirty ? { path: file, content: r.content, dirty: false } : b));
        })
        .catch(() => { /* 그 사이 삭제됐을 수 있다 — refresh 가 트리를 갱신한다 */ });
    });
  }, [pkg, refresh]);

  // 충돌 배너의 두 처분 — 판정은 기판이 했고(base 검사), 선택은 사람이 한다
  const conflictReload = useCallback(() => {
    if (!pkg || !conflict) return;
    void draftReadFile(pkg, conflict)
      .then((r) => {
        bufHash.current[r.file] = r.hash;
        setBuf({ path: r.file, content: r.content, dirty: false });
        setConflict(null);
        void refresh();
      })
      .catch((e) => say("err", `다시 읽기 실패 ${conflict}: ${String(e instanceof Error ? e.message : e)}`));
  }, [pkg, conflict, refresh, say]);
  const conflictOverwrite = useCallback(() => {
    if (!pkg || !conflict || !buf || buf.path !== conflict) return;
    void draftWrite(pkg, { [conflict]: buf.content }) // base 없이 — 명시적 덮어쓰기 선언
      .then(async (r) => {
        bufHash.current[conflict] = r.hashes?.[conflict] ?? null;
        setBuf((b) => (b && b.path === conflict ? { ...b, dirty: false } : b));
        setConflict(null);
        await refresh();
      })
      .catch((e) => say("err", `덮어쓰기 실패 ${conflict}: ${String(e instanceof Error ? e.message : e)}`));
  }, [pkg, conflict, buf, refresh, say]);

  const manifest: Manifest | null = useMemo(() => {
    if (!status) return null;
    try {
      return (parseYaml(status.manifest) as Manifest) ?? {};
    } catch {
      return null;
    }
  }, [status]);

  /**
   * 만든 뒤. 지우면 화면이 반응하고 만들면 반응하지 않던 자리를 뒤집는다 — 종전에는 생성 경로
   * 11개 중 **어느 것도** 만든 것으로 데려가지 않았다(openItem 은 클릭과 삭제 뒤에만 불렸다).
   * 데려가면 결과면이 그 재료의 모양으로 바뀌므로, 만든 것이 곧바로 눈에 보인다.
   */
  const onMade = useCallback(
    (made: Made) => {
      nav({ sec: made.sec, item: made.item ?? null, file: made.file ?? null });
      say("ok", `${made.receipt} · ⌘Z 로 되돌릴 수 있습니다`);
    },
    [nav, say],
  );

  const ctx: SectionCtx | null = useMemo(() => {
    if (!pkg || !status || !manifest) return null;
    return {
      manifest,
      text: status.manifest,
      files: status.files,
      changes: status.changes,
      schema,
      apply: (mutate) => {
        const doc = parseDocument(status.manifest);
        mutate(doc);
        return writeManifest(doc.toString());
      },
      createFile: (path, content) =>
        draftWrite(pkg, { [path]: content })
          .then(refresh)
          .catch((e) => {
            say("err", `생성 실패 ${path}: ${String(e instanceof Error ? e.message : e)}`);
            throw e;
          }),
      openFile: (f) => nav({ file: f }),
      openItem: (it) => nav({ item: it, file: null }),
      made: onMade,
      seedHarness: (source, entry) =>
        draftOpen(pkg, { seedHarness: [{ source, entry }] })
          .then(refresh)
          .catch((e) => {
            say("err", `템플릿 복사 실패: ${String(e instanceof Error ? e.message : e)}`);
            throw e;
          }),
    };
  }, [pkg, status, manifest, schema, writeManifest, refresh, nav, say]);

  async function validate() {
    if (!pkg) return;
    try {
      const r = await draftValidate(pkg);
      setIssues(r.ok ? [] : r.issues);
      // 좌표를 실은 같은 판정 — 에디터 거터와 트리 배지가 이것을 읽는다. 못 짚은 판정도
      // 문장으로는 그대로 콘솔에 남는다(둘의 길이는 항상 같다)
      setVerdicts(r.verdicts ?? []);
      const located = (r.verdicts ?? []).filter((v) => v.line != null).length;
      setConsoleOpen(!r.ok);
      if (r.ok) say("ok", "검사 통과");
      else {
        say("err", `검사에 걸린 곳 ${r.issues.length}건${located ? ` — ${located}건은 relay.yaml 에서 자리를 짚었습니다` : ""}`);
        // 짚은 자리가 있으면 그 파일로 데려간다. 판정을 고치는 자리는 콘솔이 아니라 문서다
        if (located && effFile !== "relay.yaml") nav({ sec: null, item: null, file: "relay.yaml" });
      }
    } catch (e) {
      say("err", String(e instanceof Error ? e.message : e));
    }
  }

  // 내보내기 — 실행본을 봉투로 만들어 선반에 앉힌다. 스토어 등재의 재료가 여기서 나온다.
  // (코드와 문서는 '굽기·봉투'라는 말을 쓴다. 화면만 일상어로 옮긴 것은 의도한 분리다)
  // 파일을 내려받게 하지 않는다: 봉인이 함께 계산된 채로 선반에 남아야 등재 화면이
  // 그것을 그대로 읽어 올릴 수 있다. 손으로 옮기면 그 사이에 어긋날 자리가 생긴다.
  async function pack() {
    if (!pkg) return;
    setConsoleOpen(true);
    try {
      const r = await packPkg(pkg);
      say("ok", `만들었습니다: ${r.ref}@${r.version} · 파일 ${r.files}개 · ${(r.size / 1024).toFixed(0)}KB`);
      say("ok", `봉인 ${r.digest}`);
      say("ok", `스토어에 올릴 준비가 됐습니다 · ${r.shelf}`);
      say("ok", `↓ 파일로 받기 — ${r.file}`, `/store/export/${encodeURIComponent(r.file)}`);
      if (r.excluded.length) {
        say("err", `선언 밖이라 빠진 파일 ${r.excluded.length}개 — 매니페스트에 없으면 봉투에도 없다`);
        for (const f of r.excluded.slice(0, 10)) say("err", `  · ${f}`);
      }
    } catch (e) {
      say("err", `내보내기 실패: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  function onPublished(r: PublishOutcome) {
    // 배포는 눌러도 아무 일이 안 일어날 수 있다(변경 없음). 그 답이 접힌 콘솔에만 남으면
    // 사용자는 눌렀는지조차 알 수 없으므로, 결과가 나오면 콘솔을 연다
    setConsoleOpen(true);
    if (!r.published) {
      say("info", `적용하지 않았습니다: ${r.note}`);
      return;
    }
    say("ok", `적용됨: ${r.name}@${r.version}${r.fresh ? " (첫 설치)" : ""}`);
    if (r.build) say(r.build.ok ? "info" : "err", `view 빌드: ${r.build.out}`);
    for (const s of r.services ?? []) say("info", s);
    setIssues([]);
    void refresh();
  }

  if (!pkg && !isNew) return <Landing />;
  if (isNew) return <Wizard onOpen={(name) => router.replace(`/studio/?pkg=${encodeURIComponent(name)}`)} />;

  const changedCount = status?.changes.length ?? 0;
  const secDef = SECTIONS.find((s) => s.key === sec);
  // 결과면은 relay.yaml 판정만 자리로 짚는다 — 다른 파일의 판정은 좌표계가 다르다
  const marks: Mark[] = effFile === "relay.yaml"
    ? verdicts.filter((v): v is Verdict & { line: number } => v.line != null).map((v) => ({ line: v.line, col: v.col, message: v.message }))
    : [];
  const material = materialOf(secDef?.material, sec, item);
  // draft 의 내용 지문 — 무엇이든 바뀌면 결과면이 스스로 새로 읽는다(즉시성의 실체)
  const rev = status ? Object.entries(status.hashes ?? {}).map(([k, v]) => k + ":" + v).join("|") : "";
  const previewCtx: PreviewCtx | null = pkg && status && manifest
    ? { pkg, manifest, status, sec, item, reg, rev, say, refresh }
    : null;

  return (
    // 페이지 정체성 선언(view-bridge §5) — "이 화면의 대화는 이 패키지의 빌더". 부유 위젯이
    // 이 대화를 미리보기 탭으로 끌어오고, 대상 없는 openChat prefill/send 가 여기로 간다
    <AgentScope agent="agent-builder" param={pkg ?? undefined}>
    <div className="st-shell">
      <div className="rc-card st-top">
        <Link href="/" className="st-back">
          ◀ 콘솔
        </Link>
        <b>{manifest?.display_name ?? pkg}</b>
        <span className="st-ver">
          {status?.version.live ? `live v${status.version.live}` : "미발행"}
          {status?.version.draft && status.version.draft !== status.version.live ? ` · draft v${status.version.draft}` : ""}
        </span>
        {changedCount ? <span className="rc-chip">수정 {changedCount}건</span> : <span className="rc-chip gray">변경 없음</span>}
        {agentBusy ? (
          <span className="rc-chip" title="이 패키지의 빌더 대화에서 턴이 돌고 있습니다 — 끝나면 화면이 새 내용을 반영합니다">
            빌더 작업 중…
          </span>
        ) : null}
        {status?.lastCommit ? <span className="st-commit">기록: {status.lastCommit.message}</span> : null}
        <span className="st-sp" />
        {/* 되돌리기·다시하기 — 폼 조작의 눈금. 파괴적인 [초기화]와 멀리 둔다(오른쪽 끝) */}
        <span className="st-undo">
          <button className="rc-btn" title={`폼 조작 되돌리기 (⌘Z) — 쌓인 판 ${undo.length}`} disabled={!undo.length} onClick={() => stepHistory("undo")}>
            ↶
          </button>
          <button className="rc-btn" title="다시 적용 (⌘⇧Z)" disabled={!redo.length} onClick={() => stepHistory("redo")}>
            ↷
          </button>
        </span>
        {/* 버튼은 성질로 묶는다. 왼쪽에서 오른쪽이 곧 작업 순서다:
              고치는 동안 반복하는 것 → 결과를 내고 확인하는 것 → 되돌리는 것.
            되돌리기·초기화를 맨 끝에 두는 것은 파괴적이기 때문이다 — 자주 누르는
            버튼 옆에 두면 언젠가 잘못 눌린다 */}
        <button className="rc-btn" title="선언한 것과 실제 파일이 맞는지 봅니다 — 고치지는 않습니다" onClick={() => void validate()}>
          검사
        </button>
        <button className="rc-btn" title="지금까지 고친 것을 되돌릴 수 있는 지점으로 남깁니다" disabled={!changedCount} onClick={() => setDialog("commit")}>
          기록
        </button>

        <span className="st-div" aria-hidden="true" />

        <button className="rc-btn accent" title="고친 것을 실제로 돌아가는 판으로 바꿉니다" onClick={() => setDialog("publish")}>
          적용
        </button>
        {/* 실행본으로 가는 문. 기판이 직접 서빙하는 경로라 여기는 Link 가 아니라 생짜 a 가 맞다
            (앱 내부 경로였다면 basePath 때문에 Link 여야 한다) */}
        {status?.installed && pkg ? (
          <a className="rc-btn" style={{ textDecoration: "none" }} href={`/pkg/${pkg}/view/`} target="_blank" rel="noreferrer" title="지금 돌아가고 있는 판의 화면을 새 탭에서 엽니다">
            실행본 열기
          </a>
        ) : null}
        <button className="rc-btn" title="남에게 주거나 스토어에 올릴 수 있는 형태로 만듭니다" disabled={!status?.version.live} onClick={() => void pack()}>
          내보내기
        </button>

        <span className="st-div" aria-hidden="true" />

        <button className="rc-btn" title="예전 판 목록을 보고 그때로 돌립니다" onClick={() => setDialog("releases")}>
          되돌리기
        </button>
        <button className="rc-btn" title="고치던 내용을 지웁니다 — 되돌릴 수 없습니다" onClick={() => setDialog("discard")}>
          초기화
        </button>
      </div>

      <div className={`st-body${previewCtx ? " st-3" : ""}`}>
        <div className="rc-card st-left">
          {status && ctx ? (
            <button className="rc-btn accent st-make" onClick={() => setPalette(true)} title="이 앱에 무엇을 붙일 수 있는지 봅니다">
              ＋ 만들기
            </button>
          ) : null}
          {fatal ? (
            <div className="banner">{fatal}</div>
          ) : status ? (
            <DeclTree
              manifest={manifest}
              files={status.files}
              changes={status.changes}
              sec={sec}
              item={item}
              onSelect={(s, it) => nav({ sec: s, item: it ?? null, file: null })}
            />
          ) : (
            <div className="empty">
              <span className="rc-ring" /> draft 여는 중…
            </div>
          )}
        </div>

        <div className="rc-card st-canvas">
          <div className="st-crumb">
            <span className={!sec && !file ? "cur" : "lnk"} onClick={() => nav({ sec: null, item: null, file: null })}>
              {pkg}
            </span>
            {secDef || sec === "files" ? (
              <>
                <i>/</i>
                <span className={!item && !file ? "cur" : "lnk"} onClick={() => nav({ item: null, file: null })}>
                  {secDef?.label ?? "기타 파일"}
                </span>
              </>
            ) : null}
            {item ? (
              <>
                <i>/</i>
                <span className={!file ? "cur" : "lnk"} onClick={() => nav({ file: null })}>
                  {item}
                </span>
              </>
            ) : null}
            {file ? (
              <>
                <i>/</i>
                <span className="cur mono">{file}</span>
              </>
            ) : null}
            {buf?.dirty ? <span className="st-dot" title="저장 중" /> : null}
            {file ? (
              <button
                className="st-x"
                title="파일 삭제"
                onClick={() => {
                  if (!pkg || !file) return;
                  void draftWrite(pkg, {}, [file])
                    .then(async () => {
                      say("info", `삭제됨: ${file}`);
                      nav({ file: null });
                      await refresh();
                    })
                    .catch((e) => say("err", String(e instanceof Error ? e.message : e)));
                }}
              >
                삭제
              </button>
            ) : null}
          </div>

          <div className="st-canvas-body">
            {fatal ? (
              <div className="empty">{fatal}</div>
            ) : !status ? (
              <div className="empty">
                <span className="rc-ring" />
              </div>
            ) : effFile ? (
              buf && buf.path === effFile ? (
                <>
                  {conflict === effFile ? (
                    <div className="banner" role="alert" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span>다른 손(빌더·다른 화면)이 이 파일을 먼저 고쳤습니다 — 지금 버퍼는 그 위 판이 아닙니다.</span>
                      <button className="rc-btn" onClick={conflictReload}>
                        새 내용 읽기 (내 편집 버림)
                      </button>
                      <button className="rc-btn" onClick={conflictOverwrite}>
                        내 내용으로 덮어쓰기
                      </button>
                    </div>
                  ) : null}
                  <CodeEditor key={`${pkg}:${buf.path}`} path={buf.path} value={buf.content} onChange={onEdit} marks={marks} />
                </>
              ) : (
                <div className="empty">
                  <span className="rc-ring" />
                </div>
              )
            ) : sec && ctx ? (
              <div className="st-scroll">
                <SectionView sec={sec} item={item} ctx={ctx} />
              </div>
            ) : !manifest ? (
              <div className="empty">relay.yaml 파싱 실패 — 개요 에디터에서 문법을 고치세요</div>
            ) : null}
          </div>

          <div className={`st-console${consoleOpen ? " open" : ""}`}>
            <div className="st-console-bar" onClick={() => setConsoleOpen(!consoleOpen)}>
              <span className="rc-label">콘솔</span>
              {issues != null ? (
                issues.length ? (
                  <span className="rc-chip" style={{ color: "var(--rc-err)", background: "var(--rc-err-bg)" }}>
                    판정 {issues.length}건
                  </span>
                ) : (
                  <span className="rc-chip">검사 통과</span>
                )
              ) : null}
              {!consoleOpen && log[0] ? <span className={`st-last ${log[0].kind}`}>{log[0].text}</span> : null}
              <span className="st-sp" />
              <span className="st-caret">{consoleOpen ? "▾" : "▴"}</span>
            </div>
            {consoleOpen ? (
              <div className="st-console-body">
                {issues?.length ? (
                  <div className="st-issues">
                    {issues.map((i, x) => (
                      <div key={x} className="err">
                        - {i}
                      </div>
                    ))}
                  </div>
                ) : null}
                {log.map((l, x) => (
                  <div key={x} className={l.kind}>
                    {l.href ? (
                      // 파일로 받기 — 버튼을 하나 더 두는 대신 결과 줄에서 바로 받는다.
                      // 굽고 나서야 의미가 생기는 동작이라 그 자리가 제일 가깝다
                      <a href={l.href} download style={{ color: "inherit", fontWeight: 600 }}>
                        {l.text}
                      </a>
                    ) : (
                      l.text
                    )}
                  </div>
                ))}
                {!log.length && !issues?.length ? <div className="info">검사·기록·적용 결과가 여기 남습니다</div> : null}
              </div>
            ) : null}
          </div>
        </div>

        {palette && ctx && manifest && status ? (
          <Palette
            manifest={manifest}
            files={status.files}
            ctx={ctx}
            onMade={onMade}
            onClose={() => setPalette(false)}
          />
        ) : null}

        {previewCtx ? (
          <div className="rc-card st-right">
            <div className="st-crumb">
              <span className="cur">결과</span>
              <span className="rc-chip gray">{material} 재료</span>
              <span className="st-sp" />
              <span className="st-ver">발행 전 · 작업 사본</span>
            </div>
            <Preview ctx={previewCtx} material={material} />
          </div>
        ) : null}
      </div>

      {dialog === "commit" && pkg ? (
        <CommitDialog
          pkg={pkg}
          onDone={(line) => {
            say("ok", line);
            void refresh();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "publish" && pkg ? (
        <PublishDialog pkg={pkg} draftVersion={status?.version.draft ?? null} onDone={onPublished} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === "releases" && pkg ? (
        <ReleasesDialog
          pkg={pkg}
          onDone={(line) => {
            say("ok", line);
            void refresh();
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "discard" && pkg ? (
        <DiscardDialog pkg={pkg} installed={!!status?.installed} onDone={() => router.push("/")} onClose={() => setDialog(null)} />
      ) : null}
    </div>
    </AgentScope>
  );
}

function Landing() {
  return (
    <div className="st-shell">
      <div className="rc-card st-top">
        <Link href="/" className="st-back">
          ◀ 콘솔
        </Link>
        <b>스튜디오</b>
      </div>
      <div className="rc-card" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div className="empty">
          콘솔에서 패키지를 골라 들어오거나, <Link href="/studio/?new=1">새 패키지</Link>를 만드세요.
        </div>
      </div>
    </div>
  );
}

/** 새 패키지 마법사 — 신분 세 칸만 받고 나머지는 스튜디오 안에서 붙여 나간다 */
function Wizard({ onOpen }: { onOpen: (name: string) => void }) {
  const [dir, setDir] = useState("");
  const [display, setDisplay] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirValue = dir.trim();
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(dirValue);
  const invalidDir = dirValue.length > 0 && !valid;

  return (
    <div className="st-shell">
      <div className="rc-card st-top">
        <Link href="/" className="st-back">
          ◀ 콘솔
        </Link>
        <b>새 패키지</b>
      </div>
      <div className="rc-card st-wizard">
        <div className="st-form" style={{ maxWidth: 480 }}>
          <label className="st-field">
            <span>디렉토리 이름 (영문 소문자, 숫자, 하이픈)</span>
            <input
              autoFocus
              placeholder="diary"
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              aria-invalid={invalidDir}
              aria-describedby="new-package-dir-help"
            />
            <div id="new-package-dir-help" className={invalidDir ? "gx-err" : "st-hint"}>
              {invalidDir
                ? "영문 소문자, 숫자, 하이픈(-)만 사용할 수 있습니다. 한글 디렉터리 이름은 지원하지 않습니다."
                : "패키지 식별자로 사용되므로 영문 소문자, 숫자, 하이픈(-)만 사용할 수 있습니다. 한글은 지원하지 않습니다."}
            </div>
          </label>
          <label className="st-field">
            <span>표시 이름</span>
            <input placeholder="일기 비서" value={display} onChange={(e) => setDisplay(e.target.value)} />
          </label>
          <label className="st-field">
            <span>카드 한 줄 설명</span>
            <input placeholder="지도, 카탈로그, 설치 화면이 이 문장을 그대로 쓴다" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <div className="st-hint">
            착지 에이전트(이름 = 패키지 이름)와 claude-code 하네스가 함께 스캐폴드된다. 페르소나, 동사, 서비스, 트리거는 스튜디오에서
            붙인다.
          </div>
          {err ? <div className="gx-err">{err}</div> : null}
          <button
            className="rc-btn accent"
            disabled={!valid || busy}
            onClick={async () => {
              const name = dir.trim();
              setBusy(true);
              setErr(null);
              try {
                await draftOpen(name, {
                  manifest: {
                    schema: "relay/v1",
                    name: `@local/${name}`,
                    version: "0.1.0",
                    display_name: display.trim() || name,
                    description: desc.trim() || "설명을 적어 주세요.",
                    agents: [{ name, persona: `agents/${name}/AGENT.md`, greeting: "무엇을 도와드릴까요?" }],
                  },
                });
                onOpen(name);
              } catch (e) {
                setErr(String(e instanceof Error ? e.message : e));
                setBusy(false);
              }
            }}
          >
            {busy ? "스캐폴드 중…" : "draft 만들기"}
          </button>
        </div>
      </div>
    </div>
  );
}

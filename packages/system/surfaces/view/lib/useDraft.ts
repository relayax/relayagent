"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { onAgentTurn } from "@relay/chat";
import { parse as parseYaml, parseDocument } from "yaml";
import type { Mark } from "@/components/CodeEditor";
import { materialOf, type PreviewCtx } from "@/components/Preview";
import type { SectionCtx } from "@/components/SectionView";
import { fetchRegistry } from "@/lib/api";
import type { Made } from "@/lib/create";
import { SECTIONS, type Material } from "@/lib/sections";
import {
  draftList,
  draftIcon,
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

// 패키지 하나의 수정 레이어(draft)를 다루는 기계. 종전에는 스튜디오 페이지 하나가 이 전부를
// 안고 있었다 — 패키지 화면이 같은 기계를 쓰게 되면서(콘솔 상세와 스튜디오를 합친다) 화면과
// 기계를 가른다. 화면이 갖는 것은 다이얼로그·팔레트 열림 같은 순수 표시 상태뿐이다.
//
// 깊이의 정본은 여전히 URL 이다(sec · item · file) — 훅은 그것을 `view` 로 받고 `nav` 로 옮긴다.
// 모든 편집은 draft 로 간다 — 설치본(live)을 만지는 경로는 없다.

export type LogLine = { kind: "ok" | "err" | "info"; text: string; href?: string };
export type View = { sec: string | null; item: string | null; file: string | null };
export type Nav = (q: { sec?: string | null; item?: string | null; file?: string | null }) => void;

/** 전역 셸(사이드바·홈)에 목록 재조회를 알린다 — 적용·버리기 뒤 새로고침 없이 카드가 따라오게 */
export function notifyNav(): void {
  try {
    window.dispatchEvent(new CustomEvent("relay:nav-refresh"));
  } catch {
    /* 셸 없는 문서 — 무시 */
  }
}

export interface Draft {
  status: DraftStatus | null;
  fatal: string | null;
  manifest: Manifest | null;
  schema: any;
  reg: Registry | null;
  buf: { path: string; content: string; dirty: boolean } | null;
  effFile: string | null;
  marks: Mark[];
  issues: string[] | null;
  verdicts: Verdict[];
  log: LogLine[];
  consoleOpen: boolean;
  setConsoleOpen(v: boolean): void;
  conflict: string | null;
  agentBusy: boolean;
  undoDepth: number;
  redoDepth: number;
  rev: string;
  ctx: SectionCtx | null;
  previewCtx: PreviewCtx | null;
  material: Material;
  changedCount: number;
  /** 적용 결과 시트의 재료 — 화면이 닫으면 null 로 */
  published: PublishOutcome | null;
  setPublished(v: PublishOutcome | null): void;
  /** draft 를 연다(설치본 사본 또는 기존 draft). 이름이 장부에도 draft 목록에도 없으면 fatal */
  open(): Promise<void>;
  /** 화면에서 draft 를 내려놓는다(파일은 그대로) — 버린 뒤 설치본으로 돌아갈 때 */
  close(): void;
  refresh(): Promise<void>;
  onEdit(text: string): void;
  stepHistory(dir: "undo" | "redo"): void;
  validate(): Promise<void>;
  pack(): Promise<void>;
  onPublished(r: PublishOutcome): void;
  conflictReload(): void;
  conflictOverwrite(): void;
  deleteFile(path: string): void;
  say(kind: LogLine["kind"], text: string, href?: string): void;
  onMade(made: Made): void;
}

export function useDraft(
  pkg: string | null,
  view: View,
  nav: Nav,
  opts: {
    /** file 미지정일 때 여는 파일 — 스튜디오는 개요가 relay.yaml 에디터라 "relay.yaml", 패키지 화면은 null */
    defaultFile?: string | null;
  } = {},
): Draft {
  const { sec, item, file } = view;
  const defaultFile = opts.defaultFile ?? null;

  const [status, setStatus] = useState<DraftStatus | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [schema, setSchema] = useState<any>(null);
  const [buf, setBuf] = useState<{ path: string; content: string; dirty: boolean } | null>(null);
  const [issues, setIssues] = useState<string[] | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  // 동시 편집 판정에 걸린 파일 — 배너가 "새 내용 읽기 / 덮어쓰기" 를 묻는다
  const [conflict, setConflict] = useState<string | null>(null);
  // 이 패키지의 빌더 대화에서 턴이 도는 중 (relay:turn started↔settled)
  const [agentBusy, setAgentBusy] = useState(false);
  const [reg, setReg] = useState<Registry | null>(null);
  const [verdicts, setVerdicts] = useState<Verdict[]>([]);
  // 폼 조작의 되돌리기. 눈금은 relay.yaml 전문이다 — 폼 한 번이 문서 한 판을 만들기 때문이고,
  // 그 판을 통째로 되돌리는 것이 "방금 그 조작"의 정확한 역이다. draft 의 git 이 그물을 치지만
  // 그 그물의 눈금은 커밋이라, 눌러 본 것 하나를 물릴 단위가 없었다 — 그러면 사람은 과감해지지
  // 않는다. 텍스트 편집은 CodeMirror 의 이력이 따로 맡는다(에디터 안에서 ⌘Z)
  const [undo, setUndo] = useState<string[]>([]);
  const [redo, setRedo] = useState<string[]>([]);
  // 적용 결과 시트 — 접힌 로그 한 줄 대신 열기 버튼과 실행 도구 상태를 한 자리에
  const [published, setPublished] = useState<PublishOutcome | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 경로별 마지막 읽기 지문 — draft-write 의 base. 디바운스 발화 시점에 읽어야 하므로
  // (in-flight 저장이 지문을 갱신하는 사이 잡힌 클로저가 낡은 값을 들 수 있다) ref 다
  const bufHash = useRef<Record<string, string | null>>({});

  const say = useCallback((kind: LogLine["kind"], text: string, href?: string) => {
    setLog((l) => [{ kind, text, href }, ...l].slice(0, 200));
  }, []);

  useEffect(() => {
    void fetchSchema().then(setSchema).catch(() => setSchema(null));
  }, []);

  // 배선 재료의 결과면이 콘솔의 지도를 그대로 쓴다 — 이웃(제공자·소비자)이 장부에 있다
  useEffect(() => {
    void fetchRegistry().then(setReg).catch(() => setReg(null));
  }, []);

  const refresh = useCallback(async () => {
    if (!pkg) return;
    try {
      setStatus(await draftRead(pkg));
    } catch (e) {
      say("err", String(e instanceof Error ? e.message : e));
    }
  }, [pkg, say]);

  const close = useCallback(() => {
    setStatus(null);
    setFatal(null);
    setBuf(null);
    setUndo([]);
    setRedo([]);
    setIssues(null);
    setVerdicts([]);
    setConflict(null);
    setPublished(null);
  }, []);

  // 패키지가 바뀌면 전부 내려놓는다 — 열기는 화면이 시점을 정한다(open)
  useEffect(() => {
    close();
    setLog([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);

  // draft 열기. 오타 이름으로 빈 draft 가 생기지 않게 설치본·기존 draft 만 연다
  const open = useCallback(async () => {
    if (!pkg) return;
    setFatal(null);
    try {
      const [known0, dl] = await Promise.all([fetchRegistry(), draftList()]);
      const known = known0.packages.some((p) => p.name === pkg) || dl.drafts.some((d) => d.name === pkg);
      if (!known) {
        setFatal(`없는 패키지: ${pkg} — 콘솔에서 진입하거나 새 패키지로 만드세요`);
        return;
      }
      await draftOpen(pkg);
      setStatus(await draftRead(pkg));
    } catch (e) {
      setFatal(String(e instanceof Error ? e.message : e));
    }
  }, [pkg]);

  const effFile = file ?? (!sec && pkg && status ? defaultFile : null);

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
      void writeManifest(text, "none");
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
  const liveView = useRef({ file: null as string | null, dirty: false, open: false });
  liveView.current = { file: effFile, dirty: !!buf?.dirty, open: status != null };
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
      // 재조회는 대화 불문 — system 에이전트가 직접 draft 를 고치는 경로도 있고, 재조회는 싸다.
      // 다만 아직 열지 않은 draft 를 재조회가 만들지는 않는다
      const { file, dirty, open } = liveView.current;
      if (!open) return;
      void refresh();
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

  const deleteFile = useCallback(
    (path: string) => {
      if (!pkg) return;
      void draftWrite(pkg, {}, [path])
        .then(async () => {
          say("info", `삭제됨: ${path}`);
          nav({ file: null });
          await refresh();
        })
        .catch((e) => say("err", String(e instanceof Error ? e.message : e)));
    },
    [pkg, nav, refresh, say],
  );

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
      pkg,
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
      setIcon: (emoji) =>
        draftIcon(pkg, emoji)
          .then(refresh)
          .catch((e) => {
            say("err", `아이콘 실패: ${String(e instanceof Error ? e.message : e)}`);
            throw e;
          }),
      seedHarness: (source, entry) =>
        draftOpen(pkg, { seedHarness: [{ source, entry }] })
          .then(refresh)
          .catch((e) => {
            say("err", `템플릿 복사 실패: ${String(e instanceof Error ? e.message : e)}`);
            throw e;
          }),
    };
  }, [pkg, status, manifest, schema, writeManifest, refresh, nav, say, onMade]);

  const validate = useCallback(async () => {
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
  }, [pkg, effFile, nav, say]);

  // 내보내기 — 실행본을 봉투로 만들어 선반에 앉힌다. 스토어 등재의 재료가 여기서 나온다.
  // (코드와 문서는 '굽기·봉투'라는 말을 쓴다. 화면만 일상어로 옮긴 것은 의도한 분리다)
  // 파일을 내려받게 하지 않는다: 봉인이 함께 계산된 채로 선반에 남아야 등재 화면이
  // 그것을 그대로 읽어 올릴 수 있다. 손으로 옮기면 그 사이에 어긋날 자리가 생긴다.
  const pack = useCallback(async () => {
    if (!pkg) return;
    setConsoleOpen(true);
    try {
      const r = await packPkg(pkg);
      say("ok", `만들었습니다: ${r.ref}@${r.version} · 파일 ${r.files}개 · ${(r.size / 1024).toFixed(0)}KB`);
      say("ok", `검증값 ${r.digest}`);
      say("ok", `저장 위치: ${r.shelf} — 스토어에 올릴 수 있습니다`);
      say("ok", `↓ 파일로 받기 — ${r.file}`, `/store/export/${encodeURIComponent(r.file)}`);
      if (r.excluded.length) {
        say("err", `선언 밖이라 빠진 파일 ${r.excluded.length}개 — 매니페스트에 없으면 봉투에도 없다`);
        for (const f of r.excluded.slice(0, 10)) say("err", `  · ${f}`);
      }
    } catch (e) {
      say("err", `내보내기 실패: ${String(e instanceof Error ? e.message : e)}`);
    }
  }, [pkg, say]);

  const onPublished = useCallback(
    (r: PublishOutcome) => {
      // 배포는 눌러도 아무 일이 안 일어날 수 있다(변경 없음). 그 답이 접힌 콘솔에만 남으면
      // 사용자는 눌렀는지조차 알 수 없으므로, 결과가 나오면 콘솔을 연다
      setConsoleOpen(true);
      if (!r.published) {
        say("info", `적용하지 않았습니다: ${r.note}`);
        return;
      }
      say("ok", `적용됨: ${r.name}@${r.version}${r.fresh ? " (첫 설치)" : ""}`);
      if (r.build) say(r.build.ok ? "info" : "err", `화면 빌드: ${r.build.out}`);
      for (const s of r.services ?? []) say("info", s);
      setIssues([]);
      setPublished(r);
      notifyNav();
      void refresh();
    },
    [say, refresh],
  );

  const changedCount = status?.changes.length ?? 0;
  const secDef = SECTIONS.find((s) => s.key === sec);
  // 결과면은 relay.yaml 판정만 자리로 짚는다 — 다른 파일의 판정은 좌표계가 다르다
  const marks: Mark[] = useMemo(
    () =>
      effFile === "relay.yaml"
        ? verdicts.filter((v): v is Verdict & { line: number } => v.line != null).map((v) => ({ line: v.line, col: v.col, message: v.message }))
        : [],
    [effFile, verdicts],
  );
  const material = materialOf(secDef?.material, sec, item);
  // draft 의 내용 지문 — 무엇이든 바뀌면 결과면이 스스로 새로 읽는다(즉시성의 실체)
  const rev = status ? Object.entries(status.hashes ?? {}).map(([k, v]) => k + ":" + v).join("|") : "";
  const previewCtx: PreviewCtx | null = useMemo(
    () => (pkg && status && manifest ? { pkg, manifest, status, sec, item, reg, rev, say, refresh } : null),
    [pkg, status, manifest, sec, item, reg, rev, say, refresh],
  );

  return {
    status,
    fatal,
    manifest,
    schema,
    reg,
    buf,
    effFile,
    marks,
    issues,
    verdicts,
    log,
    consoleOpen,
    setConsoleOpen,
    conflict,
    agentBusy,
    undoDepth: undo.length,
    redoDepth: redo.length,
    rev,
    ctx,
    previewCtx,
    material,
    changedCount,
    published,
    setPublished,
    open,
    close,
    refresh,
    onEdit,
    stepHistory,
    validate,
    pack,
    onPublished,
    conflictReload,
    conflictOverwrite,
    deleteFile,
    say,
    onMade,
  };
}

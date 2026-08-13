"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { parse as parseYaml, parseDocument } from "yaml";
import CodeEditor from "@/components/CodeEditor";
import DeclTree from "@/components/DeclTree";
import SectionView, { type SectionCtx } from "@/components/SectionView";
import { CommitDialog, DiscardDialog, PublishDialog, ReleasesDialog } from "@/components/StudioDialogs";
import { fetchRegistry } from "@/lib/api";
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
} from "@/lib/studio";
import type { Manifest } from "@/lib/types";

// 스튜디오 = 패키지 하나의 수정 레이어를 여는 IDE. URL 쿼리가 depth 의 정본이다:
//   /studio/?pkg=x              depth 1  개요 (relay.yaml 에디터)
//   /studio/?pkg=x&sec=agents   depth 2  섹션 (선언 폼 + 파일 카드)
//   /studio/?pkg=x&...&file=f   depth 3  파일 (에디터 전면)
// 정적 발행(output: export)이라 동적 세그먼트 대신 쿼리를 쓴다.
// 모든 편집은 draft 로 간다 — 설치본(live)을 만지는 화면 경로는 없다.

type LogLine = { kind: "ok" | "err" | "info"; text: string };
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((kind: LogLine["kind"], text: string) => {
    setLog((l) => [{ kind, text }, ...l].slice(0, 200));
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
        const [reg, dl] = await Promise.all([fetchRegistry(), draftList()]);
        if (!on) return;
        const known = reg.packages.some((p) => p.name === pkg) || dl.drafts.some((d) => d.name === pkg);
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
    if (!pkg || !effFile || !status) {
      if (!effFile) setBuf(null);
      return;
    }
    if (buf?.path === effFile) return;
    let on = true;
    void draftReadFile(pkg, effFile)
      .then((r) => on && setBuf({ path: r.file, content: r.content, dirty: false }))
      .catch((e) => {
        if (!on) return;
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
        void draftWrite(pkg, { [path]: content })
          .then(async () => {
            setBuf((b) => (b && b.path === path && b.content === content ? { ...b, dirty: false } : b));
            await refresh();
          })
          .catch((e) => say("err", `저장 실패 ${path}: ${String(e instanceof Error ? e.message : e)}`));
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

  // 폼 편집(디스크리트 커밋)은 디바운스 없이 바로 쓴다
  const writeManifest = useCallback(
    (text: string) => {
      if (!pkg) return;
      void draftWrite(pkg, { "relay.yaml": text })
        .then(async () => {
          setBuf((b) => (b && b.path === "relay.yaml" ? { path: b.path, content: text, dirty: false } : b));
          await refresh();
        })
        .catch((e) => say("err", `저장 실패 relay.yaml: ${String(e instanceof Error ? e.message : e)}`));
    },
    [pkg, refresh, say],
  );

  const manifest: Manifest | null = useMemo(() => {
    if (!status) return null;
    try {
      return (parseYaml(status.manifest) as Manifest) ?? {};
    } catch {
      return null;
    }
  }, [status]);

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
        writeManifest(doc.toString());
      },
      createFile: (path, content) => {
        void draftWrite(pkg, { [path]: content })
          .then(refresh)
          .catch((e) => say("err", `생성 실패 ${path}: ${String(e instanceof Error ? e.message : e)}`));
      },
      openFile: (f) => nav({ file: f }),
      openItem: (it) => nav({ item: it, file: null }),
      seedHarness: (source, entry) => {
        void draftOpen(pkg, { seedHarness: [{ source, entry }] })
          .then(refresh)
          .catch((e) => say("err", `템플릿 복사 실패: ${String(e instanceof Error ? e.message : e)}`));
      },
    };
  }, [pkg, status, manifest, schema, writeManifest, refresh, nav, say]);

  async function validate() {
    if (!pkg) return;
    try {
      const r = await draftValidate(pkg);
      setIssues(r.ok ? [] : r.issues);
      setConsoleOpen(!r.ok);
      say(r.ok ? "ok" : "err", r.ok ? "판정 통과" : `판정 실패 ${r.issues.length}건`);
    } catch (e) {
      say("err", String(e instanceof Error ? e.message : e));
    }
  }

  // 굽기 — 배포본을 봉투로 만들어 선반에 앉힌다. 스토어 등재의 재료가 여기서 나온다.
  // 파일을 내려받게 하지 않는다: 봉인이 함께 계산된 채로 선반에 남아야 등재 화면이
  // 그것을 그대로 읽어 올릴 수 있다. 손으로 옮기면 그 사이에 어긋날 자리가 생긴다.
  async function pack() {
    if (!pkg) return;
    setConsoleOpen(true);
    try {
      const r = await packPkg(pkg);
      say("ok", `구움: ${r.ref}@${r.version} · 파일 ${r.files}개 · ${(r.size / 1024).toFixed(0)}KB`);
      say("ok", `봉인 ${r.digest}`);
      say("ok", `선반: ${r.shelf}`);
      say("ok", `내보내려면 [내보내기] — 또는 ${location.origin}/store/export/${r.file}`);
      if (r.excluded.length) {
        say("err", `선언 밖이라 빠진 파일 ${r.excluded.length}개 — 매니페스트에 없으면 봉투에도 없다`);
        for (const f of r.excluded.slice(0, 10)) say("err", `  · ${f}`);
      }
    } catch (e) {
      say("err", `굽기 실패: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  // 내보내기 — 구운 봉투를 파일로 받는다. 스토어를 거치지 않고 손으로 건네는 길이라
  // 받는 쪽은 콘솔의 [봉투 열기](/store/import)로 연다. export 와 import 가 한 쌍이다.
  async function exportPkg() {
    if (!pkg) return;
    setConsoleOpen(true);
    try {
      const r = await packPkg(pkg);
      say("ok", `구움: ${r.ref}@${r.version} — 내려받는 중`);
      window.location.href = `/store/export/${encodeURIComponent(r.file)}`;
    } catch (e) {
      say("err", `내보내기 실패: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  function onPublished(r: PublishOutcome) {
    // 배포는 눌러도 아무 일이 안 일어날 수 있다(변경 없음). 그 답이 접힌 콘솔에만 남으면
    // 사용자는 눌렀는지조차 알 수 없으므로, 결과가 나오면 콘솔을 연다
    setConsoleOpen(true);
    if (!r.published) {
      say("info", `배포 안 함: ${r.note}`);
      return;
    }
    say("ok", `배포됨: ${r.name}@${r.version}${r.fresh ? " (첫 설치)" : ""}`);
    if (r.build) say(r.build.ok ? "info" : "err", `view 빌드: ${r.build.out}`);
    for (const s of r.services ?? []) say("info", s);
    setIssues([]);
    void refresh();
  }

  if (!pkg && !isNew) return <Landing />;
  if (isNew) return <Wizard onOpen={(name) => router.replace(`/studio/?pkg=${encodeURIComponent(name)}`)} />;

  const changedCount = status?.changes.length ?? 0;
  const secDef = SECTIONS.find((s) => s.key === sec);

  return (
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
        {status?.lastCommit ? <span className="st-commit">커밋: {status.lastCommit.message}</span> : null}
        <span className="st-sp" />
        {/* 배포본으로 가는 문. 기판이 직접 서빙하는 경로라 여기는 Link 가 아니라 생짜 a 가 맞다
            (앱 내부 경로였다면 basePath 때문에 Link 여야 한다) */}
        {status?.installed && pkg ? (
          <a className="rc-btn" style={{ textDecoration: "none" }} href={`/pkg/${pkg}/view/`} target="_blank" rel="noreferrer">
            배포본 열기
          </a>
        ) : null}
        <button className="rc-btn" onClick={() => void validate()}>
          판정
        </button>
        <button className="rc-btn" disabled={!changedCount} onClick={() => setDialog("commit")}>
          커밋
        </button>
        <button className="rc-btn accent" onClick={() => setDialog("publish")}>
          배포
        </button>
        <button className="rc-btn" disabled={!status?.version.live} onClick={() => void pack()}>
          굽기
        </button>
        <button className="rc-btn" disabled={!status?.version.live} onClick={() => void exportPkg()}>
          내보내기
        </button>
        <button className="rc-btn" onClick={() => setDialog("releases")}>
          릴리스
        </button>
        <button className="rc-btn" onClick={() => setDialog("discard")}>
          폐기
        </button>
      </div>

      <div className="st-body">
        <div className="rc-card st-left">
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
                <CodeEditor key={`${pkg}:${buf.path}`} path={buf.path} value={buf.content} onChange={onEdit} />
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
                  <span className="rc-chip">판정 통과</span>
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
                    {l.text}
                  </div>
                ))}
                {!log.length && !issues?.length ? <div className="info">판정, 커밋, 배포 결과가 여기 남는다</div> : null}
              </div>
            ) : null}
          </div>
        </div>
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
            착지 에이전트(이름 = 패키지 이름)와 chat 표면, claude-code 하네스가 함께 스캐폴드된다. 페르소나, 동사, 서비스, 트리거는 스튜디오에서
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
                    surfaces: { chat: { mode: "direct", greeting: "무엇을 도와드릴까요?" } },
                    agents: [{ name, persona: `agents/${name}/AGENT.md` }],
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

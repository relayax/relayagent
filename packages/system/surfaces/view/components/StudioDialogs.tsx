"use client";

import { useEffect, useState } from "react";
import { getHarness, type HarnessVariantView } from "@/lib/api";
import {
  draftCommit,
  draftDiff,
  draftDiscard,
  draftHistory,
  draftPublish,
  draftRestore,
  draftValidate,
  releaseList,
  releaseRollback,
  type DraftChange,
  type DraftCommit,
  type PublishOutcome,
  type Release,
} from "@/lib/studio";
import type { Manifest } from "@/lib/types";

function Overlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="gx-overlay" onClick={onClose}>
      <div className="gx-modal" style={{ width: "34rem" }} onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}

function when(t: number): string {
  try {
    return new Date(t).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

/**
 * 기록 — 지금까지 고친 것을 되돌릴 수 있는 지점으로 남기고, 이전 지점 목록에서 그 자리로 돌아간다.
 * 종전에는 남기기만 있고 돌아가는 문이 없었다 — 툴팁의 약속("되돌릴 수 있는 지점")을 지키지
 * 않는 버튼이었다. 메시지는 비워도 된다(기록 시각으로 채운다) — 한 줄 강제는 기록을 미루게 한다.
 */
export function CommitDialog({
  pkg,
  changedCount,
  onDone,
  onClose,
}: {
  pkg: string;
  changedCount: number;
  onDone: (line: string) => void;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [commits, setCommits] = useState<DraftCommit[] | null>(null);
  const [arming, setArming] = useState<string | null>(null);

  const load = () =>
    draftHistory(pkg)
      .then((r) => setCommits(r.commits))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);

  const autoMsg = () => `기록 ${when(Date.now())}`;

  return (
    <Overlay title="기록" onClose={onClose}>
      <div className="gx-mbody">
        <div className="gx-field">
          <span>지금까지 고친 것 {changedCount}건을 한 지점으로 남깁니다</span>
          <input autoFocus value={msg} placeholder={changedCount ? "무엇을 바꿨는지 한 줄 (비우면 시각으로 채웁니다)" : "기록할 변경이 없습니다"} disabled={!changedCount} onChange={(e) => setMsg(e.target.value)} />
        </div>
        <div className="gx-field">
          <span>이전 지점 — 파일을 그 모습으로 되돌립니다 (이력은 남고, 되돌린 것은 새 변경이 됩니다)</span>
          {commits == null ? (
            <div className="gx-hint">불러오는 중…</div>
          ) : commits.length ? (
            <div className="st-hist">
              {commits.map((c, i) => (
                <div key={c.hash} className="st-hist-row">
                  <span className="msg" title={c.hash}>{c.message || "(메시지 없음)"}</span>
                  <span className="when">{when(c.time)}</span>
                  {i === 0 && !changedCount ? (
                    <span className="rc-chip">지금</span>
                  ) : arming === c.hash ? (
                    <button
                      className="rc-btn danger"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        setErr(null);
                        try {
                          const r = await draftRestore(pkg, c.hash);
                          onDone(`이 지점으로 되돌렸습니다: ${r.message || c.hash.slice(0, 7)}`);
                          onClose();
                        } catch (e) {
                          setErr(String(e instanceof Error ? e.message : e));
                          setBusy(false);
                        }
                      }}
                    >
                      {changedCount ? `되돌리기 (기록 안 한 ${changedCount}건 사라짐)` : "되돌리기"}
                    </button>
                  ) : (
                    <button className="rc-btn" disabled={busy} onClick={() => setArming(c.hash)}>
                      이 지점으로
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="gx-hint">아직 남긴 지점이 없습니다 — 기록할 때마다 여기 쌓입니다</div>
          )}
        </div>
        {err ? <div className="gx-err">{err}</div> : null}
      </div>
      <div className="gx-mfoot">
        <button className="rc-btn" onClick={onClose}>
          닫기
        </button>
        <button
          className="rc-btn accent"
          disabled={busy || !changedCount}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            const m = msg.trim() || autoMsg();
            try {
              const r = await draftCommit(pkg, m);
              onDone(r.committed ? `기록됨: ${m} (${r.hash?.slice(0, 7)})` : `기록할 변경이 없습니다: ${r.note}`);
              onClose();
            } catch (e) {
              setErr(String(e instanceof Error ? e.message : e));
            } finally {
              setBusy(false);
            }
          }}
        >
          기록
        </button>
      </div>
    </Overlay>
  );
}

/** 실행 도구 준비 상태 한 줄 — 로그인 안 된 채로 적용하면 첫 대화에서야 실패한다 */
function HarnessReadiness({ pkg, installed, manifest }: { pkg: string; installed: boolean; manifest: Manifest | null }) {
  const [rows, setRows] = useState<HarnessVariantView[] | null>(null);
  const [failed, setFailed] = useState(false);
  const wanted = (manifest?.harness?.variants ?? []).map((v) => v.name);
  useEffect(() => {
    let on = true;
    // 설치본이면 그 패키지를, 첫 적용이면 같은 어댑터를 가진 콘솔 패키지를 실제로 돌려본다
    getHarness(installed ? pkg : "system", true)
      .then((r) => on && setRows(r.variants))
      .catch(() => on && setFailed(true));
    return () => {
      on = false;
    };
  }, [pkg, installed]);
  if (!wanted.length) return null;
  if (failed) return <div className="gx-hint">실행 도구 상태를 확인하지 못했습니다</div>;
  if (rows == null) return <div className="gx-hint">실행 도구 확인 중…</div>;
  const hit = wanted.map((n) => rows.find((r) => r.name === n) ?? null);
  const anyReady = hit.some((r) => r?.ready);
  return (
    <div className="gx-field">
      <span>실행 도구 — 이 앱의 대화를 움직이는 AI 프로그램</span>
      <div className={anyReady ? "gx-hint gx-setup-ok" : "gx-err"}>
        {wanted.map((n, i) => {
          const r = hit[i];
          const state = !r ? "알 수 없음" : r.ready ? `준비됨${r.account?.email ? ` · ${r.account.email}` : ""}` : `준비 안 됨${r.note ? ` — ${r.note}` : ""}`;
          return (
            <div key={n}>
              {n}: {state}
            </div>
          );
        })}
        {!anyReady ? (
          <div>
            지금 적용해도 되지만 첫 대화가 실패합니다.{" "}
            <a href="/pkg/system/view/?p=system&face=detail">로그인·설치 안내 열기</a>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** 첫 적용의 고지서 — 이 앱이 내 컴퓨터에서 쓰게 되는 것. 종전 화면 경로에는 이 확인이 없었다 */
function FirstInstallBill({ pkg, manifest }: { pkg: string; manifest: Manifest | null }) {
  const services = manifest?.services ?? [];
  const dirs = services.filter((s) => s.dir);
  const outward = services.filter((s) => s.url || s.api);
  const bins = manifest?.requires?.binaries ?? [];
  return (
    <div className="gx-field">
      <span>처음 적용 — 이 앱이 쓰게 되는 것</span>
      <div className="st-changes">
        <div>작업 폴더: ~/Relay/{pkg} (기본값 · 대화가 이 폴더 위에서 돕니다)</div>
        {dirs.map((s) => (
          <div key={s.name}>폴더 {s.name}: {String(s.dir)} (도구로만 열립니다)</div>
        ))}
        {outward.map((s) => (
          <div key={s.name}>밖으로 나가는 연결 {s.name}: {String(s.url ?? s.api)} (자격은 적용 뒤 연결 화면에서)</div>
        ))}
        {bins.map((b) => (
          <div key={b.name}>필요한 실행파일: {b.name}</div>
        ))}
      </div>
    </div>
  );
}

/** 적용 관문: diff 와 판정을 눈앞에 두고 버전을 확정한다. 판정 실패면 적용 버튼이 죽는다 */
export function PublishDialog({
  pkg,
  draftVersion,
  installed,
  manifest,
  onDone,
  onClose,
}: {
  pkg: string;
  draftVersion: string | null;
  installed: boolean;
  manifest: Manifest | null;
  onDone: (r: PublishOutcome) => void;
  onClose: () => void;
}) {
  const [issues, setIssues] = useState<string[] | null>(null);
  const [changes, setChanges] = useState<DraftChange[] | null>(null);
  const [diff, setDiff] = useState("");
  const [showDiff, setShowDiff] = useState(false);
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    void Promise.all([draftValidate(pkg), draftDiff(pkg)]).then(([v, d]) => {
      if (!on) return;
      setIssues(v.ok ? [] : v.issues);
      setChanges(d.changes);
      setDiff(d.diff);
    }).catch((e) => on && setErr(String(e instanceof Error ? e.message : e)));
    return () => {
      on = false;
    };
  }, [pkg]);

  const ready = issues != null && changes != null;
  const ok = ready && issues!.length === 0;

  return (
    <Overlay title={`적용: ${manifest?.display_name ?? pkg}`} onClose={onClose}>
      <div className="gx-mbody">
        {!ready && !err ? <div className="gx-hint">검사와 변경 내역을 모으는 중…</div> : null}
        {issues?.length ? (
          <div className="gx-field">
            <span>검사에 걸렸습니다 — 고쳐야 적용할 수 있습니다</span>
            <div className="gx-err">{issues.map((i) => "- " + i).join("\n")}</div>
          </div>
        ) : null}
        {ready && ok ? <div className="gx-hint gx-setup-ok">검사 통과</div> : null}
        {!installed ? <FirstInstallBill pkg={pkg} manifest={manifest} /> : null}
        <HarnessReadiness pkg={pkg} installed={installed} manifest={manifest} />
        {changes ? (
          <div className="gx-field">
            <span>기록하지 않은 변경 {changes.length}건 {changes.length ? "(적용할 때 함께 기록됩니다)" : ""}</span>
            {changes.length ? (
              <div className="st-changes">
                {changes.map((c) => (
                  <div key={c.file}>
                    <i className={`st-state ${c.state}`}>{c.state}</i> {c.file}
                  </div>
                ))}
              </div>
            ) : null}
            {diff ? (
              <button className="rc-btn" style={{ alignSelf: "flex-start" }} onClick={() => setShowDiff(!showDiff)}>
                {showDiff ? "바뀐 내용 접기" : "바뀐 내용 보기"}
              </button>
            ) : null}
            {showDiff ? <pre className="st-diff">{diff}</pre> : null}
          </div>
        ) : null}
        <div className="gx-field">
          <span>버전 (비우면 자동 — 지금 {draftVersion ?? "?"}, 이전 판이 있으면 끝자리를 올립니다)</span>
          <input value={version} placeholder="자동" onChange={(e) => setVersion(e.target.value)} />
        </div>
        {err ? <div className="gx-err">{err}</div> : null}
      </div>
      <div className="gx-mfoot">
        <button className="rc-btn" onClick={onClose}>
          취소
        </button>
        <button
          className="rc-btn accent"
          disabled={!ok || busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await draftPublish(pkg, version.trim() || undefined);
              onDone(r);
              onClose();
            } catch (e) {
              setErr(String(e instanceof Error ? e.message : e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "적용 중…" : "적용"}
        </button>
      </div>
    </Overlay>
  );
}

/**
 * 적용 결과 시트 — 종전에는 접힌 로그창에 "적용됨" 한 줄이라 성공했는지, 어디서 여는지 알 수 없었다.
 * 열기 버튼과 실행 도구 상태를 한 자리에 낸다.
 */
export function PublishedDialog({
  pkg,
  display,
  outcome,
  onClose,
}: {
  pkg: string;
  display: string;
  outcome: PublishOutcome;
  onClose: () => void;
}) {
  const setupLine = outcome.setup ? outcome.setup.out.split("\n")[0] : null;
  return (
    <Overlay title="적용됨" onClose={onClose}>
      <div className="gx-mbody">
        <div className="st-done">
          <div className="big">
            {display} v{outcome.version} 이(가) 돌아갑니다{outcome.fresh ? " — 홈과 사이드바에 카드가 생겼습니다" : ""}
          </div>
          {setupLine ? <div className={outcome.setup?.ok ? "ok" : "warn"}>{setupLine}{outcome.setup?.ok ? "" : " — 로그인하기 전에는 대화가 실패합니다"}</div> : null}
          {outcome.build && !outcome.build.ok ? <div className="warn">화면 빌드: {outcome.build.out}</div> : null}
          {(outcome.services ?? []).map((s) => (
            <div key={s}>{s}</div>
          ))}
        </div>
      </div>
      <div className="gx-mfoot">
        <button className="rc-btn" onClick={onClose}>
          계속 고치기
        </button>
        <a className="rc-btn accent" style={{ textDecoration: "none" }} href={`/pkg/${encodeURIComponent(pkg)}/view/`} target="_blank" rel="noreferrer">
          열기
        </a>
      </div>
    </Overlay>
  );
}

export function ReleasesDialog({ pkg, onDone, onClose }: { pkg: string; onDone: (line: string) => void; onClose: () => void }) {
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () =>
    releaseList(pkg)
      .then((r) => setReleases(r.releases))
      .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pkg]);

  return (
    <Overlay title="이전 판으로" onClose={onClose}>
      <div className="gx-mbody">
        <div className="gx-hint">실제로 돌아가는 판을 예전에 적용했던 판으로 바꿉니다. 스튜디오에서 고치던 내용은 그대로 남습니다.</div>
        {releases ? (
          <div className="lv">
            {releases.map((r) => (
              <div key={r.version} className="lv-row" style={{ cursor: "default" }}>
                <span className="lv-tx">
                  <span className="lv-t">
                    v{r.version} {r.live ? <span className="rc-chip">지금 돌아가는 판</span> : null}
                  </span>
                  <span className="lv-s">{new Date(r.time).toLocaleString()}</span>
                </span>
                {!r.live ? (
                  <button
                    className="rc-btn"
                    disabled={busy != null}
                    onClick={async () => {
                      setBusy(r.version);
                      setErr(null);
                      try {
                        await releaseRollback(pkg, r.version);
                        onDone(`이전 판으로 바꿨습니다: v${r.version}`);
                        await load();
                      } catch (e) {
                        setErr(String(e instanceof Error ? e.message : e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === r.version ? "바꾸는 중…" : "이 판으로"}
                  </button>
                ) : null}
              </div>
            ))}
            {!releases.length ? <div className="empty">아직 이전 판이 없습니다 — 적용할 때마다 여기 쌓입니다</div> : null}
          </div>
        ) : (
          <div className="gx-hint">불러오는 중…</div>
        )}
        {err ? <div className="gx-err">{err}</div> : null}
      </div>
      <div className="gx-mfoot">
        <button className="rc-btn" onClick={onClose}>
          닫기
        </button>
      </div>
    </Overlay>
  );
}

export function DiscardDialog({ pkg, installed, onDone, onClose }: { pkg: string; installed: boolean; onDone: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Overlay title="작업 사본 버리기 — 되돌릴 수 없습니다" onClose={onClose}>
      <div className="gx-mbody">
        <div className="gx-hint">
          <b>{pkg} 에서 고치던 내용과 그 이력이 모두 지워집니다. 복구할 수 없습니다.</b>
          {installed
            ? " 지금 돌아가는 판은 그대로 남습니다 — 다시 열면 그 판의 사본으로 새로 시작합니다."
            : " 이 패키지는 아직 한 번도 적용된 적이 없어, 작업한 것 전부가 사라집니다."}
        </div>
        {err ? <div className="gx-err">{err}</div> : null}
      </div>
      <div className="gx-mfoot">
        <button className="rc-btn" onClick={onClose}>
          취소
        </button>
        <button
          className="rc-btn"
          style={{ color: "var(--rc-err)", borderColor: "var(--rc-err)" }}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await draftDiscard(pkg);
              onDone();
            } catch (e) {
              setErr(String(e instanceof Error ? e.message : e));
              setBusy(false);
            }
          }}
        >
          버리기
        </button>
      </div>
    </Overlay>
  );
}

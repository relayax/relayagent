"use client";

import { useEffect, useState } from "react";
import {
  draftCommit,
  draftDiff,
  draftDiscard,
  draftPublish,
  draftValidate,
  releaseList,
  releaseRollback,
  type DraftChange,
  type PublishOutcome,
  type Release,
} from "@/lib/studio";

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

export function CommitDialog({ pkg, onDone, onClose }: { pkg: string; onDone: (line: string) => void; onClose: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Overlay title="기록" onClose={onClose}>
      <div className="gx-mbody">
        <div className="gx-field">
          <span>메시지</span>
          <input autoFocus value={msg} placeholder="무엇을 바꿨는지 한 줄" onChange={(e) => setMsg(e.target.value)} />
        </div>
        {err ? <div className="gx-err">{err}</div> : null}
      </div>
      <div className="gx-mfoot">
        <button className="rc-btn" onClick={onClose}>
          취소
        </button>
        <button
          className="rc-btn accent"
          disabled={busy || !msg.trim()}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              const r = await draftCommit(pkg, msg.trim());
              onDone(r.committed ? `기록됨: ${msg.trim()} (${r.hash?.slice(0, 7)})` : `기록할 변경이 없습니다: ${r.note}`);
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

/** 배포 관문: diff 와 판정을 눈앞에 두고 버전을 확정한다. 판정 실패면 배포 버튼이 죽는다 */
export function PublishDialog({
  pkg,
  draftVersion,
  onDone,
  onClose,
}: {
  pkg: string;
  draftVersion: string | null;
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
    <Overlay title={`적용: ${pkg}`} onClose={onClose}>
      <div className="gx-mbody">
        {!ready && !err ? <div className="gx-hint">검사와 변경 내역을 모으는 중…</div> : null}
        {issues?.length ? (
          <div className="gx-field">
            <span>검사에 걸렸습니다 — 고쳐야 적용할 수 있습니다</span>
            <div className="gx-err">{issues.map((i) => "- " + i).join("\n")}</div>
          </div>
        ) : null}
        {ready && ok ? <div className="gx-hint gx-setup-ok">검사 통과</div> : null}
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
                {showDiff ? "diff 접기" : "diff 보기"}
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
    <Overlay title={`되돌리기: ${pkg}`} onClose={onClose}>
      <div className="gx-mbody">
        {releases ? (
          <div className="lv">
            {releases.map((r) => (
              <div key={r.version} className="lv-row" style={{ cursor: "default" }}>
                <span className="lv-tx">
                  <span className="lv-t">
                    v{r.version} {r.live ? <span className="rc-chip">live</span> : null}
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
                        onDone(`롤백됨: v${r.version}`);
                        await load();
                      } catch (e) {
                        setErr(String(e instanceof Error ? e.message : e));
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {busy === r.version ? "전환 중…" : "이 버전으로"}
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
    <Overlay title="초기화 — 되돌릴 수 없습니다" onClose={onClose}>
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
          초기화
        </button>
      </div>
    </Overlay>
  );
}

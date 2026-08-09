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
    <Overlay title="커밋" onClose={onClose}>
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
              onDone(r.committed ? `커밋됨: ${msg.trim()} (${r.hash?.slice(0, 7)})` : `커밋 안 함: ${r.note}`);
              onClose();
            } catch (e) {
              setErr(String(e instanceof Error ? e.message : e));
            } finally {
              setBusy(false);
            }
          }}
        >
          커밋
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
    <Overlay title={`배포: ${pkg}`} onClose={onClose}>
      <div className="gx-mbody">
        {!ready && !err ? <div className="gx-hint">판정과 diff 를 모으는 중…</div> : null}
        {issues?.length ? (
          <div className="gx-field">
            <span>판정 실패 — 고쳐야 배포할 수 있다</span>
            <div className="gx-err">{issues.map((i) => "- " + i).join("\n")}</div>
          </div>
        ) : null}
        {ready && ok ? <div className="gx-hint gx-setup-ok">판정 통과</div> : null}
        {changes ? (
          <div className="gx-field">
            <span>미커밋 변경 {changes.length}건 {changes.length ? "(배포가 함께 커밋한다)" : ""}</span>
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
          <span>버전 (비우면 자동 — 현재 {draftVersion ?? "?"}, 릴리스가 이미 있으면 patch 범프)</span>
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
          {busy ? "배포 중…" : "배포"}
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
    <Overlay title={`릴리스: ${pkg}`} onClose={onClose}>
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
            {!releases.length ? <div className="empty">릴리스 없음 — 배포하면 여기 쌓인다</div> : null}
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
    <Overlay title="draft 폐기" onClose={onClose}>
      <div className="gx-mbody">
        <div className="gx-hint">
          {pkg} 의 draft 와 그 편집 이력을 지운다. 되돌릴 수 없다.
          {installed ? " 설치본(live)은 그대로 남는다 — 다시 열면 설치본 사본으로 새 draft 가 생긴다." : " 이 패키지는 아직 발행된 적이 없어 작업 전체가 사라진다."}
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
          폐기
        </button>
      </div>
    </Overlay>
  );
}

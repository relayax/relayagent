"use client";

import Link from "next/link";
import { useState } from "react";
import { draftOpen } from "@/lib/studio";
import { notifyNav } from "@/lib/useDraft";

/** 표시 이름에서 폴더 이름을 만든다 — 영문·숫자만 남기고 나머지는 하이픈. 한글만 있으면 빈 값 */
function slugOf(display: string): string {
  return display
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** 새 패키지 — 표시 이름과 한 줄 설명만 받는다. 폴더 이름은 표시 이름에서 만들고, 나머지는
 *  패키지 화면의 [＋ 만들기]로 붙여 나간다. 첫 화면부터 내부 용어(draft·스캐폴드·하네스)를
 *  쓰지 않는다 — 팔레트의 말투와 같아야 한다 */
export default function NewPackage({ onOpen }: { onOpen: (name: string) => void }) {
  const [display, setDisplay] = useState("");
  const [desc, setDesc] = useState("");
  const [dir, setDir] = useState("");
  const [dirTouched, setDirTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirValue = (dirTouched ? dir : slugOf(display)).trim();
  const valid = /^[a-z0-9][a-z0-9-]{0,39}$/.test(dirValue);
  const invalidDir = dirValue.length > 0 && !valid;
  const needsDir = display.trim().length > 0 && !dirTouched && !dirValue;

  return (
    <section className="pane">
      <header className="pane-head">
        <Link href="/" className="st-back">
          ◀ 홈
        </Link>
        <h2>새 패키지</h2>
      </header>
      <div className="pane-body">
        <div className="rc-card pad st-form" style={{ maxWidth: 520 }}>
          <label className="st-field">
            <span>이름</span>
            <input autoFocus placeholder="일기 비서" value={display} onChange={(e) => setDisplay(e.target.value)} />
          </label>
          <label className="st-field">
            <span>한 줄 설명 — 홈 카드에 그대로 보입니다</span>
            <input placeholder="하루를 정리해 일기로 남깁니다" value={desc} onChange={(e) => setDesc(e.target.value)} />
          </label>
          <label className="st-field">
            <span>폴더 이름 — 주소와 파일 위치에 쓰입니다 (영문 소문자, 숫자, 하이픈)</span>
            <input
              placeholder="diary"
              value={dirTouched ? dir : dirValue}
              onChange={(e) => {
                setDirTouched(true);
                setDir(e.target.value);
              }}
              aria-invalid={invalidDir}
              aria-describedby="new-package-dir-help"
            />
            <div id="new-package-dir-help" className={invalidDir ? "gx-err" : "st-hint"}>
              {invalidDir
                ? "영문 소문자, 숫자, 하이픈(-)만 쓸 수 있습니다. 한글은 폴더 이름에 쓸 수 없습니다."
                : needsDir
                  ? "이름이 한글이라 폴더 이름을 만들지 못했습니다 — 영문으로 짧게 적어 주세요 (예: diary)."
                  : "이름에서 자동으로 만듭니다. 고쳐도 됩니다."}
            </div>
          </label>
          <div className="st-hint">
            만들면 대화 상대 하나와 기본 실행 도구가 함께 준비됩니다. 화면, 기능, 폴더, 예약은 만든 뒤 [＋ 만들기]에서 붙입니다.
          </div>
          {err ? <div className="gx-err">{err}</div> : null}
          <button
            className="rc-btn accent"
            disabled={!valid || busy}
            onClick={async () => {
              const name = dirValue;
              const shown = display.trim() || name;
              setBusy(true);
              setErr(null);
              try {
                await draftOpen(name, {
                  manifest: {
                    schema: "relay/v1",
                    name: `@local/${name}`,
                    version: "0.1.0",
                    display_name: shown,
                    description: desc.trim() || shown,
                    agents: [{ name, persona: `agents/${name}/AGENT.md`, greeting: "무엇을 도와드릴까요?" }],
                  },
                });
                notifyNav();
                onOpen(name);
              } catch (e) {
                setErr(String(e instanceof Error ? e.message : e));
                setBusy(false);
              }
            }}
          >
            {busy ? "만드는 중…" : "만들기"}
          </button>
        </div>
      </div>
    </section>
  );
}

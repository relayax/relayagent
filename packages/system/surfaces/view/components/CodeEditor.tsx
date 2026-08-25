"use client";

import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { forceLinting, linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { parseDocument } from "yaml";

// 파일 하나 = 에디터 하나. 부모가 key={path} 로 마운트를 갈아 끼우는 계약이라
// 내부에서 파일 전환을 다루지 않는다. value 가 밖에서 바뀌면(폼 편집) 통짜 교체한다.

/** 서버 판정 한 줄이 앉을 자리 — line/col 은 1-기반(runner 의 locateIssues 와 같은 좌표계) */
export interface Mark {
  line: number;
  col: number | null;
  message: string;
}

/** 1-기반 (줄, 열) → 문서 오프셋. 문서가 그 사이 짧아졌으면 마지막 줄로 물러난다 */
function offsetOf(doc: { lines: number; line(n: number): { from: number; to: number } }, line: number, col: number | null): [number, number] {
  const l = doc.line(Math.min(Math.max(line, 1), doc.lines));
  const from = col != null ? Math.min(l.from + Math.max(col - 1, 0), l.to) : l.from;
  return [from, Math.max(l.to, from + 1)];
}

function langOf(path: string, marks: () => Mark[]): Extension[] {
  if (/\.ya?ml$/.test(path)) {
    // 두 판정이 한 거터에 앉는다. 문법 오류는 즉석에서(브라우저), 스키마 판정은 서버가 정본이라
    // [검사] 가 좌표를 실어 보낸다 — 콘솔에만 쌓이던 판정이 고치는 자리에 오는 것이 요점이다
    const yamlLint = linter((view) => {
      const out: Diagnostic[] = [];
      for (const e of parseDocument(view.state.doc.toString()).errors) {
        const [from, to] = e.pos ?? [0, 0];
        out.push({ from, to: Math.max(to, from + 1), severity: "error", message: e.message.split("\n")[0] });
      }
      for (const m of marks()) {
        const [from, to] = offsetOf(view.state.doc, m.line, m.col);
        out.push({ from, to, severity: "warning", source: "판정", message: m.message });
      }
      return out;
    });
    return [yaml(), yamlLint, lintGutter()];
  }
  if (/\.md$/.test(path)) return [markdown()];
  if (/\.(ts|tsx|js|mjs|jsx)$/.test(path)) return [javascript({ typescript: true, jsx: true })];
  return [];
}

const theme = EditorView.theme({
  "&": { fontSize: "12.5px", height: "100%", background: "var(--rc-bg)" },
  ".cm-scroller": { fontFamily: "var(--rc-mono)", lineHeight: "1.55", overflow: "auto" },
  "&.cm-focused": { outline: "none" },
  ".cm-gutters": { background: "var(--rc-ground)", border: "none", color: "var(--rc-faint)" },
  ".cm-activeLine": { background: "rgba(13, 148, 136, 0.05)" },
  ".cm-activeLineGutter": { background: "rgba(13, 148, 136, 0.08)" },
  ".cm-selectionBackground": { background: "rgba(13, 148, 136, 0.15) !important" },
});

export default function CodeEditor({
  path,
  value,
  onChange,
  readOnly = false,
  marks,
}: {
  path: string;
  value: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
  /** 서버 판정 — 바뀌면 거터가 다시 그려진다 */
  marks?: Mark[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  // 린터 클로저는 마운트 시점에 갇히므로 판정을 ref 로 나른다 — 배열을 직접 닫으면
  // 첫 판정만 영원히 보인다
  const marksRef = useRef<Mark[]>(marks ?? []);
  marksRef.current = marks ?? [];

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          theme,
          ...langOf(path, () => marksRef.current),
          EditorState.readOnly.of(readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // path/readOnly 변화 = 부모가 key 로 재마운트한다. value 초기값은 마운트 시점 것만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const cur = v.state.doc.toString();
    if (value !== cur) {
      v.dispatch({ changes: { from: 0, to: cur.length, insert: value } });
    }
  }, [value]);

  // 판정은 문서 변경 없이 도착한다([검사] 버튼) — 린터는 그것만으로는 다시 돌지 않는다
  useEffect(() => {
    if (view.current) forceLinting(view.current);
  }, [marks]);

  return <div ref={host} className="st-editor" />;
}

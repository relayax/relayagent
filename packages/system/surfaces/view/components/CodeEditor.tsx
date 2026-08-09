"use client";

import { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState, type Extension } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { parseDocument } from "yaml";

// 파일 하나 = 에디터 하나. 부모가 key={path} 로 마운트를 갈아 끼우는 계약이라
// 내부에서 파일 전환을 다루지 않는다. value 가 밖에서 바뀌면(폼 편집) 통짜 교체한다.

function langOf(path: string): Extension[] {
  if (/\.ya?ml$/.test(path)) {
    // YAML 문법 오류는 즉석에서. 스키마 판정(judge)은 서버가 정본이라 판정 버튼이 맡는다
    const yamlLint = linter((view) => {
      const out: Diagnostic[] = [];
      for (const e of parseDocument(view.state.doc.toString()).errors) {
        const [from, to] = e.pos ?? [0, 0];
        out.push({ from, to: Math.max(to, from + 1), severity: "error", message: e.message.split("\n")[0] });
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
}: {
  path: string;
  value: string;
  onChange?: (text: string) => void;
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          theme,
          ...langOf(path),
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

  return <div ref={host} className="st-editor" />;
}

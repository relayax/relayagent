import fs from "node:fs";
import path from "node:path";

const DOCS: Record<string, { file: string; header?: string }> = {
  script: { file: "script.md" },
  shotlist: { file: "shotlist.csv", header: "cut,type,seconds" },
  editplan: { file: "editplan.csv", header: "order,source,start" },
};

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)} — project-list 로 목록을 확인하세요`);
  return p;
}

// 프로젝트의 문서(대본 script.md, 촬영 리스트 shotlist.csv, 편집 계획 editplan.csv)를 저장한다.
// 화면과 에이전트와 사용자가 같은 파일을 본다 — 사용자가 폴더에서 직접 고쳐도 된다.
export default async function (
  input: { project: string; doc: "script" | "shotlist" | "editplan"; body: string },
  ctx: { dir(n: string): string },
) {
  const spec = DOCS[input.doc];
  if (!spec) throw new Error("doc 은 script | shotlist | editplan 중 하나입니다");
  const body = String(input.body ?? "");
  if (!body.trim()) throw new Error("body 가 비었습니다");
  if (spec.header && !body.trimStart().toLowerCase().startsWith(spec.header)) {
    throw new Error(`${spec.file} 은 머리글 '${spec.header},...' 로 시작해야 합니다. 규약을 지켜 다시 저장하세요.`);
  }
  const p = projectRoot(ctx, input.project);
  const file = path.join(p, spec.file);
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n");
  return { saved: spec.file, path: file };
}

import fs from "node:fs";
import path from "node:path";

const DOCS: Record<string, string> = {
  script: "script.md",
  shotlist: "shotlist.csv",
  editplan: "editplan.csv",
};

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)} — project-list 로 목록을 확인하세요`);
  return p;
}

// 프로젝트 문서(대본·촬영 리스트·편집 계획)를 읽는다.
export default async function (
  input: { project: string; doc: "script" | "shotlist" | "editplan" },
  ctx: { dir(n: string): string },
) {
  const file = DOCS[input.doc];
  if (!file) throw new Error("doc 은 script | shotlist | editplan 중 하나입니다");
  const p = projectRoot(ctx, input.project);
  const target = path.join(p, file);
  if (!fs.existsSync(target)) return { doc: input.doc, exists: false, body: null };
  return { doc: input.doc, exists: true, body: fs.readFileSync(target, "utf8") };
}

import fs from "node:fs";
import path from "node:path";

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)} — project-list 로 목록을 확인하세요`);
  return p;
}

function listDir(p: string, d: string) {
  const dir = path.join(p, d);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => !f.startsWith("."))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: d + "/" + f, size: st.size, updated: st.mtimeMs };
    })
    .sort((a, b) => b.updated - a.updated);
}

// 프로젝트 하나의 재고 조사: 대본·촬영 리스트·편집 계획·푸티지·그래픽·렌더가 각각 어디까지 왔는지.
export default async function (input: { project: string }, ctx: { dir(n: string): string }) {
  const p = projectRoot(ctx, input.project);
  const meta = JSON.parse(fs.readFileSync(path.join(p, "project.json"), "utf8"));
  const csvRows = (f: string) => {
    const file = path.join(p, f);
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length - 1;
  };
  return {
    project: path.basename(p),
    path: p,
    meta,
    script: fs.existsSync(path.join(p, "script.md")),
    shotlistCuts: csvRows("shotlist.csv"),
    editplanRows: csvRows("editplan.csv"),
    footage: listDir(p, "footage"),
    assets: listDir(p, "assets"),
    renders: listDir(p, "render"),
  };
}

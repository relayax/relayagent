import fs from "node:fs";
import path from "node:path";

// 프로젝트(영상 한 편)들의 진행 상태를 한눈에 본다.
export default async function (_input: unknown, ctx: { dir(n: string): string }) {
  const root = path.join(ctx.dir("studio"), "projects");
  if (!fs.existsSync(root)) return { projects: [], dir: root };
  const projects = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((e) => {
      const p = path.join(root, e.name);
      const metaFile = path.join(p, "project.json");
      if (!fs.existsSync(metaFile)) return [];
      let meta: any = {};
      try { meta = JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch { /* 깨진 메타 — 이름만 */ }
      const count = (d: string) => {
        const dir = path.join(p, d);
        return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => !f.startsWith(".")).length : 0;
      };
      return [{
        project: e.name,
        format: meta.format ?? null,
        hasScript: fs.existsSync(path.join(p, "script.md")),
        hasShotlist: fs.existsSync(path.join(p, "shotlist.csv")),
        hasEditplan: fs.existsSync(path.join(p, "editplan.csv")),
        footage: count("footage"),
        assets: count("assets"),
        renders: count("render"),
        created: meta.created ?? null,
      }];
    })
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
  return { projects, dir: root };
}

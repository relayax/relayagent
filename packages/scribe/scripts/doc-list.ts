import fs from "node:fs";
import path from "node:path";

export default async function (_input: unknown, ctx: { dir(n: string): string }) {
  const root = ctx.dir("docs");
  if (!fs.existsSync(root)) return { docs: [] };
  const docs = fs
    .readdirSync(root)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const st = fs.statSync(path.join(root, f));
      return { name: f.slice(0, -3), updated: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.updated - a.updated);
  return { docs };
}

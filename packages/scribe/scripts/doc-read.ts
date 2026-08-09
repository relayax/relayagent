import fs from "node:fs";
import path from "node:path";

export default async function (input: { name?: string }, ctx: { dir(n: string): string }) {
  const root = ctx.dir("docs");
  const name = String(input.name ?? "").replace(/[/\\]/g, "").replace(/\.\./g, "").trim();
  if (!name) throw new Error("문서 이름이 비었습니다");
  const file = path.join(root, name + ".md");
  if (!fs.existsSync(file)) throw new Error(`문서 없음: ${name}`);
  return { name, body: fs.readFileSync(file, "utf8") };
}

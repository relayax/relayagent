import fs from "node:fs";
import path from "node:path";

function safe(name: unknown): string {
  const n = String(name ?? "")
    .replace(/[/\\]/g, " ")
    .replace(/\.\./g, " ")
    .replace(/[\u0000-\u001f]/g, "")
    .trim();
  return (n || "무제").slice(0, 80);
}

// 문서 = 파일 하나. 제목이 곧 파일 이름이라 사용자가 폴더에서 그대로 알아본다.
// 제목이 바뀌면 새 이름으로 쓰고 이전 파일을 지운다(이름 바꾸기).
export default async function (input: { name?: string; title?: string; body?: string }, ctx: { dir(n: string): string }) {
  const root = ctx.dir("docs");
  fs.mkdirSync(root, { recursive: true });
  const title = safe(input.title);
  const prev = input.name ? safe(input.name) : null;
  fs.writeFileSync(path.join(root, title + ".md"), String(input.body ?? ""));
  if (prev && prev !== title) {
    const old = path.join(root, prev + ".md");
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
  return { name: title };
}

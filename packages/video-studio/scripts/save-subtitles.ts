import fs from "node:fs";
import path from "node:path";

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)} — project-list 로 목록을 확인하세요`);
  return p;
}

function safe(n: unknown, fallback: string): string {
  const s = String(n ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return (s || fallback).slice(0, 80);
}

// 완성 자막(SRT)을 render 폴더에 저장한다. 문장은 대본, 타이밍은 음성 인식 결과를 쓰는 것이 원칙.
export default async function (
  input: { project: string; name?: string; body: string },
  ctx: { dir(n: string): string },
) {
  const body = String(input.body ?? "");
  if (!body.includes("-->")) throw new Error("SRT 형식이 아닙니다. '00:00:01,000 --> 00:00:03,200' 같은 타임코드 줄이 있어야 합니다.");
  const root = projectRoot(ctx, input.project);
  const name = safe(input.name, "subtitles") .replace(/\.srt$/i, "");
  const file = path.join(root, "render", name + ".srt");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body.endsWith("\n") ? body : body + "\n");
  return { file: "render/" + name + ".srt", path: file };
}

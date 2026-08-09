import fs from "node:fs";
import path from "node:path";

const FORMATS: Record<string, { width: number; height: number }> = {
  reel: { width: 1080, height: 1920 }, // 숏폼 세로 9:16
  wide: { width: 1920, height: 1080 }, // 롱폼 가로 16:9
};

function safe(n: unknown, fallback: string): string {
  const s = String(n ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return (s || fallback).slice(0, 80);
}

// 영상 한 편 = 프로젝트 폴더 하나. 대본·촬영 리스트·푸티지·그래픽·완성본이 전부 여기 앉는다.
export default async function (
  input: { name?: string; format?: "reel" | "wide"; fps?: number; script?: string },
  ctx: { dir(n: string): string },
) {
  const format = input.format ?? "reel";
  const dim = FORMATS[format];
  if (!dim) throw new Error("format 은 reel(숏폼 세로 9:16) 또는 wide(롱폼 가로 16:9)만 됩니다");

  const name = safe(input.name, "project-" + new Date().toISOString().slice(0, 10));
  const root = path.join(ctx.dir("studio"), "projects", name);
  if (fs.existsSync(path.join(root, "project.json"))) throw new Error(`이미 있는 프로젝트입니다: ${name}`);

  for (const d of ["footage", "assets", "render"]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const meta = {
    name,
    format,
    width: dim.width,
    height: dim.height,
    fps: Math.max(24, Math.min(60, Number(input.fps ?? 30))),
    created: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(root, "project.json"), JSON.stringify(meta, null, 2));
  if (input.script) fs.writeFileSync(path.join(root, "script.md"), String(input.script));

  return { project: name, path: root, footageDir: path.join(root, "footage"), ...meta };
}

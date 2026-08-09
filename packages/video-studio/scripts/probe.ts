import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)} — project-list 로 목록을 확인하세요`);
  return p;
}

function inProject(root: string, rel: unknown): string {
  const t = path.normalize(path.join(root, String(rel ?? "")));
  if (t === root || !t.startsWith(root + path.sep)) throw new Error("프로젝트 밖 경로는 다룰 수 없습니다");
  return t;
}

// 프로젝트 안 미디어 파일(footage/..., assets/..., render/...)의 길이·해상도·코덱을 확인한다.
export default async function (input: { project: string; file: string }, ctx: { dir(n: string): string }) {
  if (!input.file) throw new Error("file(프로젝트 기준 상대경로)이 필요합니다. 예: footage/c01.mp4");
  const root = projectRoot(ctx, input.project);
  const f = inProject(root, input.file);
  if (!fs.existsSync(f)) throw new Error(`파일이 없습니다: ${input.file}`);
  const out: string = await new Promise((resolve, reject) =>
    execFile("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", f], { maxBuffer: 1 << 24 }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || String(err)).slice(-2000))) : resolve(stdout),
    ),
  );
  const j = JSON.parse(out);
  const v = (j.streams || []).find((s: any) => s.codec_type === "video");
  const a = (j.streams || []).find((s: any) => s.codec_type === "audio");
  return {
    file: input.file,
    duration: Number(j.format?.duration) || null,
    size: Number(j.format?.size) || null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: v?.r_frame_rate ?? null,
    vcodec: v?.codec_name ?? null,
    acodec: a?.codec_name ?? null,
    hasAudio: Boolean(a),
  };
}

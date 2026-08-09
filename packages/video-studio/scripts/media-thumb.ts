import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)}`);
  return p;
}

function inProject(root: string, rel: unknown): string {
  const t = path.normalize(path.join(root, String(rel ?? "")));
  if (t === root || !t.startsWith(root + path.sep)) throw new Error(`프로젝트 밖 경로: ${rel}`);
  return t;
}

// 영상의 한 프레임을 작은 jpg 로 뽑아 data URI 로 돌려준다. 화면의 썸네일용.
export default async function (
  input: { project: string; file: string; at?: number; width?: number },
  ctx: { dir(n: string): string },
) {
  if (!input.file) throw new Error("file(프로젝트 기준 상대경로)이 필요합니다");
  const root = projectRoot(ctx, input.project);
  const src = inProject(root, input.file);
  if (!fs.existsSync(src)) throw new Error(`파일이 없습니다: ${input.file}`);

  const at = Math.max(0, Number(input.at ?? 0.5));
  const width = Math.max(120, Math.min(640, Number(input.width ?? 480)));
  const tmp = path.join(os.tmpdir(), `vs-thumb-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`);

  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        "ffmpeg",
        ["-hide_banner", "-y", "-ss", String(at), "-i", src, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "5", tmp],
        { maxBuffer: 1 << 24 },
        (err, _o, stderr) => (err ? reject(new Error((stderr || String(err)).slice(-1500))) : resolve()),
      ),
    );
    const data = fs.readFileSync(tmp);
    return { thumb: "data:image/jpeg;base64," + data.toString("base64"), at, width };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

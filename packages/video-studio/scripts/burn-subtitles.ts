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
  if (t === root || !t.startsWith(root + path.sep)) throw new Error(`프로젝트 밖 경로: ${rel}`);
  return t;
}

const DEFAULT_STYLE =
  "FontName=Apple SD Gothic Neo,FontSize=16,Bold=1,Outline=1,Shadow=0,MarginV=60,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&";

// SRT 자막을 영상에 새겨(번인) render/<이름>-final.mp4 를 만든다. 숏폼 릴의 기본 마무리.
export default async function (
  input: { project: string; video: string; srt: string; style?: string },
  ctx: { dir(n: string): string },
) {
  if (!input.video || !input.srt) throw new Error("video 와 srt(프로젝트 기준 상대경로)가 필요합니다. 예: render/내영상-cut.mp4, render/subtitles.srt");
  const root = projectRoot(ctx, input.project);
  const video = inProject(root, input.video);
  const srt = inProject(root, input.srt);
  if (!fs.existsSync(video)) throw new Error(`영상이 없습니다: ${input.video}`);
  if (!fs.existsSync(srt)) throw new Error(`자막 파일이 없습니다: ${input.srt}`);

  // ffmpeg 자막 필터는 경로의 쉼표·콜론·따옴표를 구분자로 오해한다 — 상대경로로 넘기고 금지 문자를 막는다
  const srtRel = path.relative(root, srt);
  if (/[,:'"]/.test(srtRel)) throw new Error(`자막 파일 이름에 쉼표·콜론·따옴표를 쓸 수 없습니다: ${srtRel} — save-subtitles 로 다시 저장하세요`);

  const style = String(input.style ?? DEFAULT_STYLE).replace(/'/g, "");
  const outName = path.parse(video).name.replace(/-cut$/, "") + "-final.mp4";
  const out = path.join(root, "render", outName);
  const vf = `subtitles=${srtRel.split(path.sep).join("/")}:force_style='${style}'`;

  await new Promise<void>((resolve, reject) =>
    execFile(
      "ffmpeg",
      ["-hide_banner", "-y", "-i", video, "-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-movflags", "+faststart", out],
      { cwd: root, maxBuffer: 1 << 26 },
      (err, _o, stderr) => (err ? reject(new Error(("자막 번인 실패: " + (stderr || String(err))).slice(-3000))) : resolve()),
    ),
  );
  const st = fs.statSync(out);
  return { file: "render/" + outName, path: out, size: st.size };
}

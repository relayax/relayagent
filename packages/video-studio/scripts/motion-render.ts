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

function safe(n: unknown, fallback: string): string {
  const s = String(n ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return (s || fallback).slice(0, 80);
}

// Remotion 컴포지션(Title, Transition, EndCard 또는 직접 추가한 것)을 프로젝트 assets 폴더에 mp4 로 렌더한다.
// 프로젝트 형식(reel/wide)이 props.format 으로 자동 주입되어 해상도가 맞춰진다.
export default async function (
  input: { project: string; comp: string; name?: string; seconds?: number; props?: Record<string, unknown> },
  ctx: { dir(n: string): string },
) {
  if (!input.comp) throw new Error("comp(컴포지션 이름)이 필요합니다. 기본 제공: Title, Transition, EndCard");
  const root = projectRoot(ctx, input.project);
  const meta = JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8"));
  const motion = path.join(ctx.dir("studio"), "motion");
  if (!fs.existsSync(path.join(motion, "package.json"))) throw new Error("Remotion 작업장이 없습니다. motion-init 을 먼저 실행하세요.");
  if (!fs.existsSync(path.join(motion, "node_modules"))) throw new Error("Remotion 의존성이 없습니다. motion-init 또는 motion 폴더에서 npm install 을 실행하세요.");

  const outName = safe(input.name, safe(input.comp, "graphic")) + ".mp4";
  const out = path.join(root, "assets", outName);
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const props = { format: meta.format ?? "reel", durationSec: Number(input.seconds ?? 3), ...(input.props ?? {}) };
  const propsFile = path.join(motion, ".relay-props.json");
  fs.writeFileSync(propsFile, JSON.stringify(props));

  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        "npx",
        ["remotion", "render", "src/index.ts", input.comp, out, `--props=${propsFile}`],
        { cwd: motion, maxBuffer: 1 << 27, env: process.env },
        (err, _o, stderr) => (err ? reject(new Error(("렌더 실패: " + (stderr || String(err))).slice(-4000))) : resolve()),
      ),
    );
  } finally {
    fs.rmSync(propsFile, { force: true });
  }
  return { file: "assets/" + outName, path: out, comp: input.comp, seconds: props.durationSec };
}

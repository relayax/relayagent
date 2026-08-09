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

// 완성본을 화면에서 바로 재생할 수 있게 파일 교환 무대(stage)의 preview 폴더로 복사한다.
// 무대는 이 패키지의 파일이 브라우저로 나가는 유일한 문이다 (/pkg/<이름>/file/<경로>).
// 오래된 미리보기는 6개까지만 남기고 정리해 무대가 붇지 않게 한다.
export default async function (
  input: { project: string; file: string },
  ctx: { pkg: string; dir(n: string): string },
) {
  if (!input.file) throw new Error("file(프로젝트 기준 상대경로)이 필요합니다. 예: render/내영상-final.mp4");
  const root = projectRoot(ctx, input.project);
  const src = inProject(root, input.file);
  if (!fs.existsSync(src)) throw new Error(`파일이 없습니다: ${input.file}`);

  const stage = path.join(os.homedir(), "Relay", ".stage", ctx.pkg, "preview");
  fs.mkdirSync(stage, { recursive: true });

  const name = path.basename(root) + "__" + path.basename(src);
  const dest = path.join(stage, name);
  const st = fs.statSync(src);
  // 같은 파일(크기·수정시각 동일)이면 다시 복사하지 않는다 — 새로고침마다 수십 MB 복사 방지
  const cached = fs.existsSync(dest) && fs.statSync(dest).size === st.size && fs.statSync(dest).mtimeMs >= st.mtimeMs;
  if (!cached) fs.copyFileSync(src, dest);

  const keep = fs
    .readdirSync(stage)
    .map((f) => ({ f, t: fs.statSync(path.join(stage, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const old of keep.slice(6)) fs.rmSync(path.join(stage, old.f), { force: true });

  return { path: "preview/" + name, size: st.size, cached };
}

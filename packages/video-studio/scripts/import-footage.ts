import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mts"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)}`);
  return p;
}

function safe(n: unknown, fallback: string): string {
  const s = String(n ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return (s || fallback).slice(0, 100);
}

// 화면에서 올린 파일(파일 교환 무대의 uploads)을 프로젝트 footage 폴더로 들인다.
// cut 을 주면 이름 규칙(c01_t1.mp4)에 맞춰 저장하고 테이크 번호는 자동으로 잇는다.
// cut 이 없으면 원래 이름 그대로 저장한다 — 보드의 "컷 번호 없는 파일" 목록에 떠서 나중에 배치한다.
export default async function (
  input: { project: string; staged: string; cut?: number | string },
  ctx: { pkg: string; dir(n: string): string },
) {
  if (!input.staged) throw new Error("staged(업로드 경로)가 필요합니다");
  const stageRoot = path.join(os.homedir(), "Relay", ".stage", ctx.pkg);
  const src = path.normalize(path.join(stageRoot, String(input.staged)));
  if (!src.startsWith(path.join(stageRoot, "uploads") + path.sep)) throw new Error("uploads 밖 경로는 들일 수 없습니다");
  if (!fs.existsSync(src)) throw new Error(`업로드 파일이 없습니다: ${input.staged}`);

  const ext = path.extname(src).toLowerCase();
  if (!VIDEO_EXT.has(ext) && !IMAGE_EXT.has(ext)) {
    throw new Error(`지원하지 않는 형식입니다: ${ext} — 영상(mp4·mov 등)과 사진(jpg·png·webp)만 푸티지로 들일 수 있습니다`);
  }

  const root = projectRoot(ctx, input.project);
  const dir = path.join(root, "footage");
  fs.mkdirSync(dir, { recursive: true });

  let name: string;
  let take: number | null = null;
  const cut = input.cut != null && String(input.cut).trim() !== "" ? Number(String(input.cut).replace(/[^0-9]/g, "")) : null;
  if (cut != null && Number.isFinite(cut) && cut > 0) {
    // 같은 컷의 기존 테이크 수를 세어 다음 번호를 붙인다
    const re = new RegExp(`^c?0*${cut}(?=[._\\-\\s(]|$)`, "i");
    const existing = fs.readdirSync(dir).filter((f) => re.test(path.parse(f).name)).length;
    take = existing + 1;
    name = `c${String(cut).padStart(2, "0")}_t${take}${ext}`;
  } else {
    name = safe(path.basename(src, ext), "footage-" + Date.now()) + ext;
  }

  let dest = path.join(dir, name);
  if (fs.existsSync(dest)) {
    dest = path.join(dir, path.basename(name, ext) + "-" + Date.now().toString(36) + ext);
  }
  try {
    fs.renameSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
    fs.rmSync(src, { force: true });
  }
  return { file: "footage/" + path.basename(dest), cut, take, still: IMAGE_EXT.has(ext) };
}

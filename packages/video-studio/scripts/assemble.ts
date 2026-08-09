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

function safe(n: unknown, fallback: string): string {
  const s = String(n ?? "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim();
  return (s || fallback).slice(0, 80);
}

function run(cmd: string, args: string[], opts: object = {}): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 1 << 26, ...opts }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || String(err)).slice(-3000))) : resolve(stdout),
    ),
  );
}

async function hasAudio(file: string): Promise<boolean> {
  try {
    const out = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-print_format", "json", file]);
    return ((JSON.parse(out).streams || []) as unknown[]).length > 0;
  } catch {
    return false;
  }
}

interface PlanRow { order: number; source: string; start: number | null; end: number | null; note: string }

// editplan.csv 를 읽는다. 규약: order,source,start,end,note — note(마지막 열)에만 쉼표 허용.
function readPlan(root: string): PlanRow[] {
  const file = path.join(root, "editplan.csv");
  if (!fs.existsSync(file)) throw new Error("editplan.csv 가 없습니다. save-doc 으로 편집 계획을 먼저 저장하세요.");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: PlanRow[] = [];
  for (const line of lines.slice(1)) {
    const cols = line.split(",");
    if (cols.length < 2) continue;
    const order = Number(cols[0]);
    if (!Number.isFinite(order)) throw new Error(`editplan.csv 순서(order)가 숫자가 아닙니다: "${line}"`);
    const start = String(cols[2] ?? "").trim();
    const end = String(cols[3] ?? "").trim();
    rows.push({
      order,
      source: String(cols[1] ?? "").trim(),
      start: start === "" ? null : Number(start),
      end: end === "" ? null : Number(end),
      note: cols.slice(4).join(",").trim(),
    });
  }
  if (!rows.length) throw new Error("editplan.csv 에 편집할 행이 없습니다");
  return rows.sort((a, b) => a.order - b.order);
}

// 편집 계획대로 각 클립을 잘라 프로젝트 형식(해상도·fps)으로 통일한 뒤 순서대로 이어붙인다.
// 결과는 render/<이름>-cut.mp4. 원본 푸티지는 건드리지 않는다.
export default async function (input: { project: string; output?: string }, ctx: { dir(n: string): string }) {
  const root = projectRoot(ctx, input.project);
  const meta = JSON.parse(fs.readFileSync(path.join(root, "project.json"), "utf8"));
  const W = Number(meta.width) || 1080;
  const H = Number(meta.height) || 1920;
  const FPS = Number(meta.fps) || 30;
  const plan = readPlan(root);

  // 시작 전에 원본 실재를 전부 확인한다 — 중간 실패보다 사전 fail-loud 가 낫다
  for (const row of plan) {
    const src = inProject(root, row.source);
    if (!fs.existsSync(src)) throw new Error(`편집 계획의 원본이 없습니다: ${row.source} (order ${row.order})`);
    if (row.start != null && row.end != null && row.end <= row.start) {
      throw new Error(`구간이 뒤집혔습니다: order ${row.order} start=${row.start} end=${row.end}`);
    }
  }

  const parts = path.join(root, "render", ".parts");
  fs.rmSync(parts, { recursive: true, force: true });
  fs.mkdirSync(parts, { recursive: true });

  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS}`;
  const partFiles: string[] = [];
  let idx = 0;
  for (const row of plan) {
    const src = inProject(root, row.source);
    const part = path.join(parts, `part_${String(idx).padStart(3, "0")}.mp4`);
    const audio = await hasAudio(src);

    const args: string[] = ["-hide_banner", "-y"];
    if (row.start != null && row.start > 0) args.push("-ss", String(row.start));
    args.push("-i", src);
    if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
    const dur = row.end != null ? (row.start != null ? row.end - row.start : row.end) : null;
    if (dur != null) args.push("-t", String(dur));
    args.push("-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0");
    if (!audio) args.push("-shortest");
    args.push("-vf", vf, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p");
    args.push("-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2", part);

    try {
      await run("ffmpeg", args);
    } catch (e) {
      fs.rmSync(parts, { recursive: true, force: true });
      throw new Error(`구간 처리 실패 (order ${row.order}, ${row.source}): ${(e as Error).message}`);
    }
    partFiles.push(path.basename(part));
    idx++;
  }

  const list = path.join(parts, "list.txt");
  fs.writeFileSync(list, partFiles.map((f) => `file '${f}'`).join("\n") + "\n");
  const outName = safe(input.output, path.basename(root)) + "-cut.mp4";
  const out = path.join(root, "render", outName);
  try {
    await run("ffmpeg", ["-hide_banner", "-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", out], { cwd: parts });
  } catch (e) {
    throw new Error(`이어붙이기 실패: ${(e as Error).message}`);
  } finally {
    fs.rmSync(parts, { recursive: true, force: true });
  }

  const st = fs.statSync(out);
  return { file: "render/" + outName, path: out, segments: plan.length, size: st.size, width: W, height: H, fps: FPS };
}

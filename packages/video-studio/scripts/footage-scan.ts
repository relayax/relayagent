import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MEDIA_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mts"]);

function projectRoot(ctx: { dir(n: string): string }, project: unknown): string {
  const root = path.join(ctx.dir("studio"), "projects");
  const p = path.normalize(path.join(root, path.basename(String(project ?? ""))));
  if (p === root || !p.startsWith(root + path.sep)) throw new Error("프로젝트 이름이 필요합니다");
  if (!fs.existsSync(path.join(p, "project.json"))) throw new Error(`프로젝트가 없습니다: ${path.basename(p)} — project-list 로 목록을 확인하세요`);
  return p;
}

// 파일 이름 앞머리에서 컷 번호를 읽는다: c01.mp4, C3_t2.mov, 01_인트로.mp4 → 1, 3, 1
function cutNumber(filename: string): number | null {
  const m = path.parse(filename).name.match(/^c?0*(\d{1,3})(?=[._\-\s(]|$)/i);
  return m ? Number(m[1]) : null;
}

function probeOne(file: string): Promise<{ duration: number | null; width: number | null; height: number | null }> {
  return new Promise((resolve) =>
    execFile(
      "ffprobe",
      ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file],
      { maxBuffer: 1 << 24 },
      (err, stdout) => {
        if (err) return resolve({ duration: null, width: null, height: null });
        try {
          const j = JSON.parse(stdout);
          const v = (j.streams || []).find((s: any) => s.codec_type === "video");
          resolve({ duration: Number(j.format?.duration) || null, width: v?.width ?? null, height: v?.height ?? null });
        } catch {
          resolve({ duration: null, width: null, height: null });
        }
      },
    ),
  );
}

// footage 폴더의 촬영본을 컷 번호로 분류하고, 촬영 리스트와 대조해 빈 컷을 찾는다.
export default async function (input: { project: string }, ctx: { dir(n: string): string }) {
  const p = projectRoot(ctx, input.project);
  const dir = path.join(p, "footage");
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => MEDIA_EXT.has(path.extname(f).toLowerCase()))
    : [];

  const byCut = new Map<number, { file: string; duration: number | null; width: number | null; height: number | null }[]>();
  const unmatched: string[] = [];
  for (const f of files) {
    const cut = cutNumber(f);
    const info = await probeOne(path.join(dir, f));
    if (cut == null) { unmatched.push(f); continue; }
    if (!byCut.has(cut)) byCut.set(cut, []);
    byCut.get(cut)!.push({ file: "footage/" + f, ...info });
  }

  // 촬영 리스트에서 필요한 컷 목록을 읽는다 (graphic 컷은 촬영 대상이 아니다)
  const needed: { cut: number; type: string; seconds: number | null }[] = [];
  const shotlist = path.join(p, "shotlist.csv");
  if (fs.existsSync(shotlist)) {
    const lines = fs.readFileSync(shotlist, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(1);
    for (const line of lines) {
      const cols = line.split(",");
      const cut = Number(String(cols[0] ?? "").replace(/[^0-9]/g, ""));
      if (!cut) continue;
      needed.push({ cut, type: String(cols[1] ?? "").trim().toLowerCase(), seconds: Number(cols[2]) || null });
    }
  }

  const cuts = [...byCut.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cut, takes]) => ({ cut, takes: takes.sort((a, b) => a.file.localeCompare(b.file)) }));
  const shootable = needed.filter((n) => n.type !== "graphic");
  const missing = shootable.filter((n) => !byCut.has(n.cut)).map((n) => n.cut);
  const graphicCuts = needed.filter((n) => n.type === "graphic").map((n) => n.cut);

  return {
    project: path.basename(p),
    footageDir: dir,
    cuts,
    missing,
    graphicCuts,
    unmatched,
    hasShotlist: fs.existsSync(shotlist),
  };
}

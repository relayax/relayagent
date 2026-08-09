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

function run(cmd: string, args: string[], opts: object = {}): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { maxBuffer: 1 << 26, ...opts }, (err: any, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || String(err)).slice(-3000)) as Error & { code?: string };
        e.code = err.code;
        return reject(e);
      }
      resolve(stdout);
    }),
  );
}

const MODEL_GUIDE =
  "음성 인식 모델이 없습니다. 한 번만 내려받으면 됩니다 (한국어 권장: large-v3-turbo, 약 1.6GB):\n" +
  "  mkdir -p ~/Relay/video-studio/models\n" +
  "  curl -L -o ~/Relay/video-studio/models/ggml-large-v3-turbo.bin \\\n" +
  "    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin\n" +
  "용량이 부담되면 small(약 466MB, 한국어 정확도는 낮음): ggml-small.bin 으로 같은 방식.";

// 영상의 음성을 whisper.cpp 로 인식해 타이밍 있는 문장 목록과 초안 SRT 를 만든다.
// 자막 문장은 대본을 쓰는 것이 원칙 — 이 결과는 "어느 말이 몇 초에 나오는지" 타이밍 근거로 쓴다.
export default async function (
  input: { project: string; file: string; language?: string; model?: string },
  ctx: { dir(n: string): string },
) {
  if (!input.file) throw new Error("file(프로젝트 기준 상대경로)이 필요합니다. 예: render/내영상-cut.mp4");
  const root = projectRoot(ctx, input.project);
  const src = inProject(root, input.file);
  if (!fs.existsSync(src)) throw new Error(`파일이 없습니다: ${input.file}`);

  // 모델 찾기: studio/models/ggml-*.bin — model 파라미터가 있으면 그 이름 우선, 없으면 가장 큰 파일
  const modelsDir = path.join(ctx.dir("studio"), "models");
  const candidates = fs.existsSync(modelsDir)
    ? fs.readdirSync(modelsDir).filter((f) => f.startsWith("ggml-") && f.endsWith(".bin"))
    : [];
  let modelFile: string | null = null;
  if (input.model) {
    const want = `ggml-${String(input.model).replace(/^ggml-|\.bin$/g, "")}.bin`;
    modelFile = candidates.includes(want) ? want : null;
    if (!modelFile) throw new Error(`요청한 모델(${want})이 models 폴더에 없습니다.\n` + MODEL_GUIDE);
  } else {
    modelFile = candidates.sort((a, b) => fs.statSync(path.join(modelsDir, b)).size - fs.statSync(path.join(modelsDir, a)).size)[0] ?? null;
  }
  if (!modelFile) throw new Error(MODEL_GUIDE);

  // 16kHz 모노 wav 로 추출 (whisper.cpp 입력 규격)
  const renderDir = path.join(root, "render");
  fs.mkdirSync(renderDir, { recursive: true });
  const wav = path.join(renderDir, ".whisper-input.wav");
  await run("ffmpeg", ["-hide_banner", "-y", "-i", src, "-vn", "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);

  const base = path.parse(src).name + "-asr";
  const outBase = path.join(renderDir, base);
  try {
    await run("whisper-cli", [
      "-m", path.join(modelsDir, modelFile),
      "-f", wav,
      "-l", String(input.language ?? "ko"),
      "-osrt", "-oj",
      "-of", outBase,
    ]);
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err.code === "ENOENT") {
      throw new Error(
        "음성 인식 도구(whisper.cpp)가 설치되어 있지 않습니다. 설치:\n  brew install whisper-cpp\n설치 후 모델도 필요합니다.\n" + MODEL_GUIDE,
      );
    }
    throw new Error("음성 인식 실패: " + err.message);
  } finally {
    fs.rmSync(wav, { force: true });
  }

  // whisper.cpp json: { transcription: [{ offsets: {from,to}(ms), text }] }
  let segments: { from: number; to: number; text: string }[] = [];
  const jsonFile = outBase + ".json";
  try {
    const j = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
    segments = (j.transcription ?? [])
      .map((s: any) => ({
        from: Math.round(Number(s.offsets?.from ?? 0)) / 1000,
        to: Math.round(Number(s.offsets?.to ?? 0)) / 1000,
        text: String(s.text ?? "").trim(),
      }))
      .filter((s: any) => s.text)
      .slice(0, 400);
  } catch { /* json 파싱 실패 — srt 는 남아 있으니 계속 */ }

  return {
    srt: "render/" + base + ".srt",
    json: "render/" + base + ".json",
    model: modelFile,
    language: String(input.language ?? "ko"),
    segments,
    note: "segments 의 타이밍에 대본 문장을 얹어 최종 자막을 만드세요 (save-subtitles).",
  };
}

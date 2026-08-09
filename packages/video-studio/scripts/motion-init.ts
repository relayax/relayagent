import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "motion-template");

// 패키지에 동봉된 Remotion 작업장(타이틀·트랜지션·엔드카드 컴포지션)을 studio/motion 에 깐다.
// 최초 한 번이면 충분하다. 의존성 설치(npm install)까지 수행한다 — 몇 분 걸릴 수 있다.
export default async function (
  input: { force?: boolean; skipInstall?: boolean },
  ctx: { dir(n: string): string },
) {
  const dest = path.join(ctx.dir("studio"), "motion");
  const exists = fs.existsSync(path.join(dest, "package.json"));
  if (exists && !input.force) {
    const installed = fs.existsSync(path.join(dest, "node_modules"));
    return { path: dest, copied: false, installed, note: installed ? "이미 준비된 작업장이 있습니다" : "작업장은 있으나 의존성이 없습니다 — motion 폴더에서 npm install 을 실행하세요" };
  }
  if (!fs.existsSync(TEMPLATE)) throw new Error("동봉 템플릿을 찾지 못했습니다: motion-template");
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(TEMPLATE)) {
    fs.cpSync(path.join(TEMPLATE, f), path.join(dest, f), { recursive: true });
  }

  let installed = false;
  let note = "";
  if (!input.skipInstall) {
    try {
      await new Promise<void>((resolve, reject) =>
        execFile("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dest, maxBuffer: 1 << 26 }, (err, _o, stderr) =>
          err ? reject(new Error((stderr || String(err)).slice(-2000))) : resolve(),
        ),
      );
      installed = true;
    } catch (e) {
      note = `의존성 설치가 실패했습니다 — motion 폴더에서 npm install 을 직접 실행해 마무리하세요: ${(e as Error).message}`;
    }
  }
  return { path: dest, copied: true, installed, note };
}

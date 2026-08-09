import fs from "node:fs";
import path from "node:path";

const SKIP = ["node_modules", ".git", ".relay", ".next", "out"];

// 스킬은 agents/<이름>/skills/<스킬>/SKILL.md 로 깊이 4에 앉는다. 깊이 3에서 자르면 안 보인다
function tree(dir: string, prefix = "", depth = 0): string[] {
  if (depth > 5) return [];
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.includes(e.name)) continue;
    out.push(prefix + e.name + (e.isDirectory() ? "/" : ""));
    if (e.isDirectory()) out.push(...tree(path.join(dir, e.name), prefix + "  ", depth + 1));
  }
  return out;
}

export default async function (input: { name: string; file?: string }, ctx: any) {
  if (!ctx.host) throw new Error("ring-0 전용");
  const reg = ctx.host.registry();
  const p = reg.packages.find((x: any) => x.name === input.name);
  if (!p) throw new Error(`미설치 패키지: ${input.name}`);
  if (input.file) {
    const root = path.normalize(p.path);
    const target = path.normalize(path.join(root, input.file));
    // startsWith(root) 만으로는 이름이 접두인 형제 패키지(../<name>-old/relay.yaml)가 통과한다
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`경로 탈출: ${input.file}`);
    return { file: input.file, content: fs.readFileSync(target, "utf8") };
  }
  return {
    manifest: fs.readFileSync(path.join(p.path, "relay.yaml"), "utf8"),
    tree: tree(p.path),
  };
}

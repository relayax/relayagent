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

// 선택 meta 수출 — 세션 문(tools/list)이 이 서술과 입력 형을 싣는다. 이름은 파일명이 정본이라
// 여기 없고, 스키마는 광고일 뿐 기판이 검증하지 않는다(입력 판정은 아래 본문의 몫)
export const meta = {
  description:
    "설치된 패키지의 코드를 읽는다. file 없이 부르면 relay.yaml 원문과 파일 트리, file 을 주면 그 파일 원문. 패키지 루트 밖 경로는 거부한다.",
  input: {
    type: "object",
    required: ["name"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "설치 이름 (pkg-list 의 name)" },
      file: { type: "string", description: "패키지 루트 상대경로. 생략하면 relay.yaml + 트리" },
    },
  },
};

export default async function (input: { name: string; file?: string }, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  const reg = await ctx.host.registry();
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

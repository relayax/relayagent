// dirs.ts — dir 서비스의 문. 선언된 폴더 하나가 세션에는 MCP 도구 넷으로, 동사에는
// ctx.service 손잡이로 선다. 감금(jail)과 연산은 **여기 한 벌**이다 — 세션 문(dir__*)과
// 동사 문(ctx.service)이 같은 판정을 지나야 하기 때문이다(callEdgeTool 과 같은 자리).
//
// 이 파일이 생긴 이유는 두 자리가 갈려 있었기 때문이다. 세션은 자기 땅(workspace)의 파일만
// 네이티브 도구로 만질 수 있어서 선언된 폴더에는 닿을 길이 아예 없었고, 동사에게는 절대경로
// 문자열만 주어져 감금 판정이 저작물의 몫이었다(조직 기판 콘솔이 그 판정을 자기 안에 복제해
// 갖고 있었다). 문을 기판이 세우면 둘 다 없어진다:
//   · 에이전트가 **서는** 곳 = workspace (cwd). 경로를 안다.
//   · 에이전트가 **부르는** 곳 = dir. 도구로만 닿고 절대경로를 모른다.
// 세션에 절대경로를 흘리지 않는 것은 취향이 아니다. 흘리면 도구를 우회해 파일시스템을 직접
// 만지려는 시도가 따라오고, 그 경로는 조직 기판에서 아무 데도 아니다.
import fs from "node:fs";
import path from "node:path";
import { expandHome, type Ledger } from "../supply/ledger.ts";
import { loadManifest, type Manifest } from "../supply/manifest.ts";
import { dirToolName } from "../protocol.ts";
import type { McpToolInfo } from "./mcp.ts";

/** 이 문이 아는 연산의 전부. 목록·집행·문서가 이 배열 하나를 본다 */
export const DIR_OPS = ["list", "read", "write", "remove"] as const;
export type DirOp = (typeof DIR_OPS)[number];

/** 한 번에 돌려주는 항목 상한 — 넘으면 잘라 보내되 truncated 로 **말한다**(무음 절단 금지) */
const LIST_CAP = 500;
/** 한 번에 읽는 파일 상한. 넘으면 크기를 실어 거절한다 — 세션이 다음 수를 고를 수 있어야 한다 */
const READ_CAP = 1 << 20;

/**
 * 몸 주소 이음새(ServiceIO)와 같은 결의 주입점 — "이 패키지의 이 dir 선언이 실제로 어디인가"의
 * 답 하나. 로컬 기판은 설치 결재(dirBindings)를 푼 호스트 경로로 답하고, 조직 기판은 같은
 * 이름을 자기 볼륨 좌표로 푼다. **`per`(인스턴스당이냐 사람당이냐)은 이 구현 안쪽의 정책이다** —
 * 1인 기판에는 사람 축이 없으므로 상류 문법이 그 단어를 알면 조직 형상이 문법으로 올라온다.
 */
export interface DirIO {
  /** null = 세울 자리 없음 → 부르는 쪽이 fail-loud */
  root(pkg: string, name: string): string | null;
}

/**
 * 선언된 dir 의 로컬 좌표. 상대경로는 패키지 트리 안(자기 소유), `~` 경로는 신청이고
 * 설치 결재(dirBindings)가 그것을 실제 폴더에 묶는다 — 매니페스트의 값은 기본 바인딩이다.
 */
export function resolveDirService(ledger: Ledger, pkg: string, m: Manifest, name: string): string {
  const svc = (m.services ?? []).find((s) => s.name === name);
  if (!svc || !("dir" in svc) || svc.dir == null) throw new Error(`dir 서비스 아님: ${name}`);
  const bound = ledger.packages[pkg]?.dirBindings?.[name] ?? svc.dir;
  const expanded = expandHome(bound);
  return expanded.startsWith("/") ? expanded : path.join(ledger.packages[pkg].path, expanded);
}

export function localDirIO(ledger: Ledger): DirIO {
  return {
    root: (pkg, name) => {
      const rec = ledger.packages[pkg];
      if (!rec) return null;
      try {
        return resolveDirService(ledger, pkg, loadManifest(rec.path), name);
      } catch {
        return null;
      }
    },
  };
}

/** 선언된 dir 서비스 이름 전부 */
export function declaredDirs(m: Manifest): string[] {
  return (m.services ?? []).filter((s) => "dir" in s && s.dir != null).map((s) => s.name);
}

/**
 * 폴더는 여는 시점에 생긴다 — workspaceDir 와 같은 관용구다. 고지서가 "만들고 읽고 씁니다"
 * 라고 약속하는데 만드는 손이 없으면 그 줄은 지킬 수 없는 약속이다.
 */
export function ensureDirRoot(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * 감금 — 인자 경로는 **상대만**이다. 절대경로·`..` 등반·심링크 탈출이 한 판정으로 막힌다.
 * 마지막 축이 realpath 인 이유: path.resolve 는 심링크를 따라가지 않으므로, 폴더 안에 바깥을
 * 가리키는 링크 하나만 있으면 앞의 두 검사를 모두 통과한 채 밖으로 나간다.
 */
export function jail(root: string, rel: unknown): string {
  const s = String(rel ?? "").trim();
  if (s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s)) {
    throw new Error(`절대경로는 받지 않습니다: ${s} — 이 문의 경로는 폴더 기준 상대경로입니다`);
  }
  const abs = path.resolve(root, s);
  const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + path.sep);
  if (!within(abs, path.resolve(root))) throw new Error(`폴더 밖 경로: ${s}`);
  // 실재하는 가장 깊은 조상까지 올라가 realpath 로 비교한다(아직 없는 파일을 쓰는 경우 포함)
  let probe = abs;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  try {
    if (!within(fs.realpathSync(probe), fs.realpathSync(root))) throw new Error(`폴더 밖 경로(심링크): ${s}`);
  } catch (e) {
    if (String(e).includes("폴더 밖")) throw e; // 판정 실패는 그대로, 좌표 조회 실패는 아래 연산이 답한다
  }
  return abs;
}

/** 세션이 보는 도구 넷. 서술에 실제 좌표를 싣지 않는다 — 세션은 이름으로만 이 폴더를 안다 */
export function dirToolInfos(service: string): McpToolInfo[] {
  const rel = { type: "string", description: "폴더 기준 상대경로(절대경로·.. 불가)" };
  return [
    {
      name: dirToolName(service, "list"),
      description: `'${service}' 폴더의 항목을 나열한다. 이 폴더는 세션의 작업 폴더 밖에 있어 파일 도구로는 닿지 않는다 — 이 문이 유일한 길이다.`,
      inputSchema: {
        type: "object",
        properties: {
          path: { ...rel, description: "나열할 하위 경로(미지정 = 폴더 뿌리)" },
          depth: { type: "number", description: "내려갈 깊이(기본 1, 최대 5)" },
        },
      },
    },
    {
      name: dirToolName(service, "read"),
      description: `'${service}' 폴더의 파일 하나를 읽는다.`,
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: {
          path: rel,
          encoding: { type: "string", enum: ["utf8", "base64"], description: "기본 utf8. 이미지 등 이진 파일은 base64" },
        },
      },
    },
    {
      name: dirToolName(service, "write"),
      description: `'${service}' 폴더에 파일을 쓴다(없는 상위 폴더는 만든다).`,
      inputSchema: {
        type: "object",
        required: ["path", "content"],
        properties: { path: rel, content: { type: "string" }, encoding: { type: "string", enum: ["utf8", "base64"] } },
      },
    },
    {
      name: dirToolName(service, "remove"),
      description: `'${service}' 폴더의 파일이나 하위 폴더를 지운다. 폴더 뿌리 자체는 지울 수 없다.`,
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: rel, recursive: { type: "boolean", description: "하위까지 지운다(폴더일 때 필수)" } },
      },
    },
  ];
}

function listAt(root: string, base: string, depth: number, out: { path: string; dir: boolean; bytes?: number }[]): void {
  if (depth <= 0 || out.length >= LIST_CAP) return;
  for (const e of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= LIST_CAP) return;
    const abs = path.join(base, e.name);
    const isDir = e.isDirectory();
    const st = isDir ? null : fs.statSync(abs, { throwIfNoEntry: false });
    out.push({ path: path.relative(root, abs), dir: isDir, ...(st ? { bytes: st.size } : {}) });
    if (isDir) listAt(root, abs, depth - 1, out);
  }
}

/**
 * 연산 집행 — 세션 문과 동사 문이 함께 부르는 한 벌. 미지 연산은 조용히 통과시키지 않는다:
 * 이름을 지어낸 호출이 빈 결과로 성공하면 그 오해가 다음 턴까지 산다.
 */
export async function dirCall(root: string, op: string, args: Record<string, unknown>): Promise<unknown> {
  ensureDirRoot(root);
  switch (op) {
    case "list": {
      const base = jail(root, args.path ?? "");
      const depth = Math.min(Math.max(Number(args.depth ?? 1) || 1, 1), 5);
      if (!fs.existsSync(base)) throw new Error(`없는 경로: ${String(args.path ?? "")}`);
      if (!fs.statSync(base).isDirectory()) throw new Error(`폴더가 아닙니다: ${String(args.path ?? "")}`);
      const entries: { path: string; dir: boolean; bytes?: number }[] = [];
      listAt(root, base, depth, entries);
      return { entries, ...(entries.length >= LIST_CAP ? { truncated: LIST_CAP } : {}) };
    }
    case "read": {
      const abs = jail(root, args.path);
      const st = fs.statSync(abs, { throwIfNoEntry: false });
      if (!st) throw new Error(`없는 파일: ${String(args.path)}`);
      if (st.isDirectory()) throw new Error(`폴더입니다(파일이 아닙니다): ${String(args.path)} — 목록은 list 연산`);
      if (st.size > READ_CAP) throw new Error(`파일이 큽니다: ${st.size} 바이트(상한 ${READ_CAP}) — 필요한 조각만 다루세요`);
      const enc = args.encoding === "base64" ? "base64" : "utf8";
      return { path: String(args.path), bytes: st.size, encoding: enc, content: fs.readFileSync(abs).toString(enc) };
    }
    case "write": {
      const abs = jail(root, args.path);
      if (typeof args.content !== "string") throw new Error("content: 문자열 필수");
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const buf = Buffer.from(args.content, args.encoding === "base64" ? "base64" : "utf8");
      fs.writeFileSync(abs, buf);
      return { path: String(args.path), bytes: buf.length };
    }
    case "remove": {
      const abs = jail(root, args.path);
      if (abs === path.resolve(root)) throw new Error("폴더 뿌리는 지울 수 없습니다 — 이 문이 사는 자리입니다");
      const st = fs.statSync(abs, { throwIfNoEntry: false });
      if (!st) throw new Error(`없는 경로: ${String(args.path)}`);
      if (st.isDirectory() && args.recursive !== true) throw new Error(`폴더입니다: ${String(args.path)} — 하위까지 지우려면 recursive: true`);
      fs.rmSync(abs, { recursive: st.isDirectory(), force: false });
      return { path: String(args.path), removed: true };
    }
    default:
      throw new Error(`dir 문에 없는 연산: ${op} (${DIR_OPS.join(" · ")})`);
  }
}

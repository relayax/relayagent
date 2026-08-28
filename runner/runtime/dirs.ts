// dirs.ts — dir 서비스의 문. 선언된 폴더 하나가 동사에 ctx.service 손잡이로 선다. 감금(jail)과
// 연산은 **여기 한 벌**이다 — 동사에게 절대경로 문자열만 주면 감금 판정이 저작물의 몫이 되고
// (조직 기판 콘솔이 그 판정을 자기 안에 복제해 갖고 있었다), 문을 기판이 세우면 그것이 없어진다.
//
// 세션은 이 문을 보지 않는다. 2026-08-25~28 사이 선언된 폴더가 세션에 MCP 도구 넷
// (dir__<이름>__{list,read,write,remove})으로 섰는데, 그것은 "서비스는 동사가 감싸서만 소비된다"
// 는 계약의 유일한 예외였다 — 폴더를 raw 로 만지는 에이전트는 저작자가 정한 저장 규약 밖에서
// 쓴다. 은퇴했다. 에이전트가 **서는** 곳은 workspace(cwd) 하나이고, 그 밖의 폴더는 그 폴더를
// 다루는 **동사**로만 닿는다. 세션에 절대경로를 흘리지 않는 것은 취향이 아니다: 흘리면 도구를
// 우회해 파일시스템을 직접 만지려는 시도가 따라오고, 그 경로는 조직 기판에서 아무 데도 아니다.
import fs from "node:fs";
import path from "node:path";
import { expandHome, type Ledger } from "../supply/ledger.ts";
import type { Manifest } from "../supply/manifest.ts";

/** 이 문이 아는 연산의 전부. 목록·집행·문서가 이 배열 하나를 본다 */
export const DIR_OPS = ["list", "read", "write", "remove"] as const;
export type DirOp = (typeof DIR_OPS)[number];

/** 한 번에 돌려주는 항목 상한 — 넘으면 잘라 보내되 truncated 로 **말한다**(무음 절단 금지) */
const LIST_CAP = 500;
/** 한 번에 읽는 파일 상한. 넘으면 크기를 실어 거절한다 — 세션이 다음 수를 고를 수 있어야 한다 */
const READ_CAP = 1 << 20;

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
 * 연산 집행 — 동사 문(ctx.service)이 부르는 한 벌. 미지 연산은 조용히 통과시키지 않는다:
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

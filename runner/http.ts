// http.ts — HTTP 응답 관용구 한 벌. 문(daemon)·채팅 계약(runtime/wire)·화면 서빙
// (runtime/view)·스토어(supply/store)가 같은 사본을 쓰던 것을 여기로 모은다.
// 종전에 wire 가 자체 사본을 든 이유는 순환(wire → daemon)이었다 — 아래에 깔면 순환이 없다.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

export const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".md": "text/markdown; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".wasm": "application/wasm",
};

export function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** HTML 삽입용 이스케이프 — 데몬이 직접 굽는 화면(설치 동의·진단)이 쓴다 */
export function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  // 설치 동의는 자바스크립트 없는 폼에서 온다 — 그 몸통은 JSON 이 아니다
  if (/^application\/x-www-form-urlencoded/.test(String(req.headers["content-type"] ?? ""))) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
}


export function streamFile(file: string, res: http.ServerResponse): void {
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
}

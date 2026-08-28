// 선택 자격(auth.required: false)의 동사 — 키가 있으면 그 기능을, 없으면 대체 경로를.
// 자격은 손에 쥐지 않는다: 있는지 묻고(connected), 비밀 아닌 칸만 읽고(fields), 부른다(fetch —
// Authorization 은 기판이 붙인다). 매니페스트의 선언은 SKILL.md 의 unsplash 예와 같다.
interface Ctx {
  service(name: string): {
    fetch(path: string, init?: RequestInit): Promise<Response>;
    connected(): Promise<boolean>;
    fields(): Promise<Record<string, string | string[]>>;
  };
}

const OPENVERSE = "https://api.openverse.org/v1/images/";

export const meta = {
  description: "사진 검색 — Unsplash 키가 연결돼 있으면 Unsplash, 없으면 무료 저장소(Openverse)",
  input: { type: "object", required: ["q"], properties: { q: { type: "string" }, count: { type: "number" } } },
};

export default async function (input: { q: string; count?: number }, ctx: Ctx) {
  const q = String(input?.q ?? "").trim();
  if (!q) throw new Error("검색어(q)가 필요하다");
  const count = Math.min(Math.max(Number(input?.count) || 4, 1), 10);

  const photos = ctx.service("unsplash");
  if (!(await photos.connected())) {
    // 없으면 그 기능만 끈다 — 화면은 같은 상태를 {base}/services 로 읽어 "연결하러 가기" 를 그린다
    const r = await fetch(`${OPENVERSE}?q=${encodeURIComponent(q)}&page_size=${count}&license_type=commercial`);
    if (!r.ok) throw new Error(`Openverse ${r.status}`);
    return { source: "openverse", hits: (await r.json()).results };
  }

  const { app_id } = await photos.fields(); // 비밀 아닌 칸 — header(access_key) 는 절대 오지 않는다
  const res = await photos.fetch(`/search/photos?query=${encodeURIComponent(q)}&per_page=${count}`);
  if (res.status === 401) throw new Error("Unsplash 가 자격을 거부했다 — 연결 화면에서 [검증] 을 눌러 보라 (접두는 Client-ID)");
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  return { source: "unsplash", app_id, hits: (await res.json()).results };
}

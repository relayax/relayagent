import type { Manifest } from "./types";

// 얼굴에 관한 **판정은 기판이 소유한다**(runner/runtime/shell.ts). 전역 사이드바와 이 콘솔이
// 같은 응답(/shell/nav)을 읽으므로 "사이드바에는 화면으로 뜨는데 여기서는 부품" 같은 갈라짐이
// 생기지 않는다. 이 파일에 남는 것은 판정이 아니라 **표시와 읽기**뿐이다.
export type Face = "view" | "chat" | "live" | "parts";

export const FACE_LABEL: Record<Face, string> = {
  view: "화면",
  chat: "대화",
  live: "상주",
  parts: "부품",
};

/**
 * 착지 에이전트 — 상세 화면의 "착지 — 대화의 문" 라벨 하나를 위한 읽기다.
 * 규칙 자체는 기판(manifest.ts landingAgentName)이 정본이고, 여기서는 그 결과를 이름표로만 쓴다.
 */
export function landingAgent(m: Manifest | null | undefined): string | null {
  const agents = m?.agents ?? [];
  const explicit = agents.find((a) => a.default === true);
  if (explicit) return explicit.name;
  const short = (m?.name ?? "").split("/").pop() ?? "";
  return short && agents.some((a) => a.name === short) ? short : null;
}

/** 상주 화면이 늘어놓을 선언들 — 판정이 아니라 매니페스트를 그대로 읽는 것이다.
 *  서비스는 source 형만 뜬다(기판 services.ts 가 스폰하는 형): dir 은 폴더를 만들고 끝이고,
 *  url·api 는 밖으로 나가는 문이라 띄울 프로세스가 없다 */
export function residentDecls(m: Manifest | null | undefined) {
  return {
    channels: m?.surfaces?.channels ?? [],
    triggers: m?.triggers ?? [],
    services: (m?.services ?? []).filter((s) => s.source != null),
  };
}

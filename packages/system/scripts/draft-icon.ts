import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface Input {
  name: string;
  /** 이모지 한 글자 (예: "📒"). 여러 글자·ZWJ 조합·피부색 변형은 받지 않는다 */
  emoji: string;
}

// 시스템 패키지가 품은 Tossface(토스페이스) 낱장 SVG — 파일명은 코드포인트(u1F4D2.svg).
// 라이선스는 같은 폴더의 LICENSE (재배포 허용, 저작권 안내 동봉 조건)
const GLYPHS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "tossface");

export const meta = {
  description:
    "열린 draft 에 패키지 대표 아이콘을 앉힌다. 이모지 하나를 고르면 그 Tossface 그림을 assets/icon.svg 로 쓰고 relay.yaml 의 icon 에 선언한다. 새 패키지마다 반드시 한 번 부른다 — 아이콘 없는 패키지는 목록에서 글자로만 보인다.",
  input: {
    type: "object",
    required: ["name", "emoji"],
    additionalProperties: false,
    properties: {
      name: { type: "string", description: "draft 를 연 패키지 이름 (draft-open 의 name)" },
      emoji: { type: "string", description: "이모지 한 글자. 패키지가 하는 일을 한눈에 말하는 것으로 (가계부 💰, 일정 📅, 독서 📖)" },
    },
  },
};

/** 이모지 → Tossface 파일명. 변형 선택자(FE0F)는 파일명에 없다 */
function glyphFile(emoji: string): string {
  const cps = Array.from(emoji.trim())
    .map((ch) => ch.codePointAt(0)!)
    .filter((cp) => cp !== 0xfe0f);
  if (!cps.length) throw new Error("emoji 가 비었습니다");
  return cps.map((cp) => "u" + cp.toString(16).toUpperCase()).join("_") + ".svg";
}

export default async function (input: Input, ctx: any) {
  if (!ctx.host) throw new Error(`ring-0 전용 — "${ctx.pkg}" 이 ring-0 설치가 아닙니다: relay list 로 경로를 확인해 relay install <경로> --ring0 (기존 결재·설정은 보존됩니다)`);
  const file = glyphFile(input.emoji);
  const src = path.join(GLYPHS, file);
  if (!fs.existsSync(src)) {
    throw new Error(`Tossface 에 없는 이모지: ${input.emoji} (${file}) — 조합·피부색·깃발이 아닌 낱글자 이모지를 고르세요`);
  }
  const svg = fs.readFileSync(src, "utf8");

  // relay.yaml 의 icon 선언 — 이미 있으면 그 경로에 쓰고, 없으면 name: 다음 줄에 앉힌다.
  // yaml 을 수입하지 않는다(동사는 의존이 없다는 계약, draft.ts openDraft 참조) — 최상위 한 줄만 다룬다
  const manifest = ctx.host.draftRead(input.name, "relay.yaml") as { content: string; hash: string };
  const lines = manifest.content.split("\n");
  let icon = "assets/icon.svg";
  const at = lines.findIndex((l) => /^icon:\s*\S/.test(l));
  if (at >= 0) {
    icon = lines[at].replace(/^icon:\s*/, "").trim().replace(/^["']|["']$/g, "");
  } else {
    const nameAt = lines.findIndex((l) => /^name:\s*\S/.test(l));
    if (nameAt < 0) throw new Error("relay.yaml 에 최상위 name: 이 없습니다");
    lines.splice(nameAt + 1, 0, `icon: ${icon}`);
  }
  const files: Record<string, string> = { [icon]: svg };
  if (at < 0) files["relay.yaml"] = lines.join("\n");
  const r = ctx.host.draftWrite(input.name, files, [], { "relay.yaml": manifest.hash });
  return { ...(r as object), icon, emoji: input.emoji, glyph: file };
}

import React from "react";
import { Composition } from "remotion";
import { Title } from "./Title";
import { Transition } from "./Transition";
import { EndCard } from "./EndCard";

export const FPS = 30;

// 렌더 동사가 props.format(reel|wide)과 props.durationSec 을 자동 주입한다.
// 여기서 그 값을 읽어 해상도와 길이를 정한다 — 컴포지션 하나로 두 형식을 다 낸다.
const SIZES: Record<string, { width: number; height: number }> = {
  reel: { width: 1080, height: 1920 },
  wide: { width: 1920, height: 1080 },
};

const meta = ({ props }: { props: { format?: string; durationSec?: number } }) => {
  const size = SIZES[props.format ?? "reel"] ?? SIZES.reel;
  return {
    width: size.width,
    height: size.height,
    durationInFrames: Math.max(1, Math.round((props.durationSec ?? 3) * FPS)),
  };
};

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="Title"
        component={Title}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={90}
        defaultProps={{ format: "reel", durationSec: 3, title: "제목을 넣으세요", subtitle: "", background: "#0b0b0f", color: "#ffffff" }}
        calculateMetadata={meta}
      />
      <Composition
        id="Transition"
        component={Transition}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={15}
        defaultProps={{ format: "reel", durationSec: 0.5, look: "flash" as const, color: "#ffffff" }}
        calculateMetadata={meta}
      />
      <Composition
        id="EndCard"
        component={EndCard}
        width={1080}
        height={1920}
        fps={FPS}
        durationInFrames={90}
        defaultProps={{ format: "reel", durationSec: 3, title: "끝까지 봐주셔서 고마워요", cta: "팔로우하면 다음 편이 이어집니다", handle: "", background: "#0b0b0f", color: "#ffffff" }}
        calculateMetadata={meta}
      />
    </>
  );
};

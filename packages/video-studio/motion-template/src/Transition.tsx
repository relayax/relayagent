import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame, useVideoConfig } from "remotion";

export interface TransitionProps {
  format?: string;
  durationSec?: number;
  /** flash = 밝게 번쩍, black = 어둠으로 숨 고르기, wipe = 색 띠가 쓸고 지나감 */
  look?: "flash" | "black" | "wipe";
  color?: string;
}

// 컷 사이에 끼워 넣는 짧은 전환 클립. 편집 계획(editplan.csv)에 한 행으로 삽입해 쓴다.
export const Transition: React.FC<TransitionProps> = ({ look = "flash", color = "#ffffff" }) => {
  const frame = useCurrentFrame();
  const { durationInFrames, width } = useVideoConfig();
  const t = durationInFrames <= 1 ? 1 : frame / (durationInFrames - 1);

  if (look === "black") {
    return <AbsoluteFill style={{ backgroundColor: "#000000" }} />;
  }

  if (look === "wipe") {
    const x = interpolate(t, [0, 1], [-width, width]);
    return (
      <AbsoluteFill style={{ backgroundColor: "#000000", overflow: "hidden" }}>
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            width: width * 1.2,
            transform: `translateX(${x}px) skewX(-12deg)`,
            backgroundColor: color,
          }}
        />
      </AbsoluteFill>
    );
  }

  // flash: 중간에 가장 밝았다가 잦아든다
  const opacity = interpolate(t, [0, 0.5, 1], [0, 1, 0]);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      <AbsoluteFill style={{ backgroundColor: color, opacity }} />
    </AbsoluteFill>
  );
};

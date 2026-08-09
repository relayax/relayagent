import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface TitleProps {
  format?: string;
  durationSec?: number;
  title: string;
  subtitle?: string;
  background?: string;
  color?: string;
}

// 타이틀 카드: 큰 제목이 아래에서 떠오르고, 끝에서 부드럽게 사라진다.
export const Title: React.FC<TitleProps> = ({ title, subtitle, background = "#0b0b0f", color = "#ffffff" }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();
  const appear = spring({ frame, fps, config: { damping: 200 } });
  const fadeOut = interpolate(
    frame,
    [Math.max(0, durationInFrames - Math.round(fps * 0.4)), durationInFrames - 1],
    [1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const y = interpolate(appear, [0, 1], [40, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        alignItems: "center",
        justifyContent: "center",
        opacity: fadeOut,
        fontFamily: "'Apple SD Gothic Neo', 'Pretendard', sans-serif",
        padding: width * 0.08,
        textAlign: "center",
      }}
    >
      <div
        style={{
          color,
          fontSize: width * 0.085,
          fontWeight: 800,
          lineHeight: 1.25,
          opacity: appear,
          transform: `translateY(${y}px)`,
          wordBreak: "keep-all",
        }}
      >
        {title}
      </div>
      {subtitle ? (
        <div
          style={{
            color,
            opacity: appear * 0.65,
            fontSize: width * 0.04,
            marginTop: width * 0.03,
            fontWeight: 500,
            wordBreak: "keep-all",
          }}
        >
          {subtitle}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

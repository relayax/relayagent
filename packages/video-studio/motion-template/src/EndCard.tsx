import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface EndCardProps {
  format?: string;
  durationSec?: number;
  title: string;
  cta?: string;
  handle?: string;
  background?: string;
  color?: string;
}

// 엔드 카드: 마무리 문구와 행동 유도(팔로우·구독), 계정 이름.
export const EndCard: React.FC<EndCardProps> = ({ title, cta, handle, background = "#0b0b0f", color = "#ffffff" }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const appear = spring({ frame, fps, config: { damping: 200 } });
  const ctaAppear = spring({ frame: frame - Math.round(fps * 0.3), fps, config: { damping: 200 } });
  const y = interpolate(appear, [0, 1], [30, 0]);

  return (
    <AbsoluteFill
      style={{
        backgroundColor: background,
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'Apple SD Gothic Neo', 'Pretendard', sans-serif",
        padding: width * 0.08,
        textAlign: "center",
      }}
    >
      <div
        style={{
          color,
          fontSize: width * 0.065,
          fontWeight: 800,
          lineHeight: 1.3,
          opacity: appear,
          transform: `translateY(${y}px)`,
          wordBreak: "keep-all",
        }}
      >
        {title}
      </div>
      {cta ? (
        <div
          style={{
            color: background,
            backgroundColor: color,
            opacity: Math.max(0, ctaAppear),
            fontSize: width * 0.038,
            fontWeight: 700,
            marginTop: width * 0.05,
            padding: `${width * 0.018}px ${width * 0.045}px`,
            borderRadius: 999,
            wordBreak: "keep-all",
          }}
        >
          {cta}
        </div>
      ) : null}
      {handle ? (
        <div style={{ color, opacity: Math.max(0, ctaAppear) * 0.6, fontSize: width * 0.032, marginTop: width * 0.035 }}>
          {handle}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};

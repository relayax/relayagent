import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Relay",
  description: "기판 관리 셸",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        {children}
        {/* 콘솔도 여느 패키지 view 와 같은 한 줄이다 — /assets 로드 = 자동 마운트로
            URL(/pkg/system/view)의 system 에이전트 부유 위젯이 우측 하단에 뜬다 */}
        <script type="module" src="/assets/chat-widget.js" async />
      </body>
    </html>
  );
}

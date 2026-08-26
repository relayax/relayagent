"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// 스튜디오는 패키지 화면의 층이 되었다(docs/superpowers/specs/2026-08-26-package-screen-merge-design.md).
// 같은 패키지가 두 화면(콘솔 상세 = 설치본, 스튜디오 = draft)에 있던 것을 하나로 합쳤다 —
// 읽기·고치기·파일이 /?p=<이름>&face=detail 의 세 층이다. 옛 주소를 들고 오는 링크(빌더의
// 답, 북마크)를 새 자리로 보낸다. sec · item · file 은 그대로 옮긴다 — 깊이의 규약이 같다.
export default function StudioRedirect() {
  return (
    <Suspense fallback={null}>
      <Go />
    </Suspense>
  );
}

function Go() {
  const router = useRouter();
  const sp = useSearchParams();
  useEffect(() => {
    if (sp.get("new") === "1") {
      router.replace("/?new=1");
      return;
    }
    const pkg = sp.get("pkg");
    if (!pkg) {
      router.replace("/");
      return;
    }
    const q = new URLSearchParams({ p: pkg, face: "detail" });
    for (const k of ["sec", "item", "file"]) {
      const v = sp.get(k);
      if (v) q.set(k, v);
    }
    router.replace(`/?${q.toString()}`);
  }, [router, sp]);
  return null;
}

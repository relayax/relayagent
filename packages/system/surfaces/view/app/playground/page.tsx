"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 일회성 생성 폼이던 playground 는 은퇴했다. 만들기는 홈의 입력 상자(빌더)가 맡는다
export default function Playground() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/");
  }, [router]);
  return null;
}

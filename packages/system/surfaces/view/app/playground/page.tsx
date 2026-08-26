"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

// 일회성 생성 폼이던 playground 는 은퇴했다. 저작은 수정 레이어 위의 스튜디오가 맡는다
export default function Playground() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/?new=1");
  }, [router]);
  return null;
}

/*!
 * attach.ts — 파일 첨부의 공용부: 스테이징(useAttachments)과 끌어놓기(useFileDrop·useDropGuard).
 *
 * 첨부를 받는 자리가 둘이 됐다 — 사이드 챗의 컴포저(Composer.tsx)와 홈의 "무엇을 만들까요?"
 * 입력(Home.tsx). 두 자리가 같은 규칙을 따라야 하는 이유는 취향이 아니라 계약이다: 인라인/
 * 사이드밴드 분기, 용량 상한, 업로드 참조(path)의 모양이 어긋나면 홈에서 붙인 첨부가 대화에
 * 착지할 때만 다르게 취급된다. 그래서 규칙은 여기 한 벌만 산다.
 *
 * 바이트만 다룬다 — 어느 경로에서 왔든(피커·드롭·붙여넣기) 원본 파일시스템 경로는 절대
 * 만들지도, 싣지도 않는다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { loadAttTotalLimit, uploadAttachment } from "./runtime";
import { fmtSize, type PendingAtt } from "./parts";

let _attSeq = 0;

/** File(출처 무관) → PendingAtt. 클립보드 이미지는 이름이 없는 경우가 잦아 여기서 지어 준다
 *  (`pasted-…`) — 바이트 경로가 원본 파일시스템 경로에 절대 기대지 않게. */
export function readFileAsAtt(file: File): Promise<PendingAtt> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      let name = file.name;
      if (!name) {
        const ext = (file.type.split("/")[1] || "bin").replace("jpeg", "jpg");
        name = `pasted-${Date.now()}-${_attSeq}.${ext}`;
      }
      resolve({ id: `a${++_attSeq}`, name, mime: file.type || "application/octet-stream",
                dataUrl: String(reader.result || ""), size: file.size });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** 인라인(파일당) 상한 — 이하이면 base64 인라인(왕복 없음·per-turn Secret ≈1MB etcd 상한 안),
 *  초과하면 사이드밴드 업로드(스트리밍 — Secret 비경유)로 자동 전환. */
const ATT_INLINE_FILE_LIMIT = 500 * 1024;
/** 인라인 합계 상한 — Secret 상한 방어(소형 여러 개도 합치면 넘칠 수 있다). 넘치는 파일은
 *  개별 크기와 무관하게 사이드밴드로 밀어낸다. */
const ATT_INLINE_TOTAL_LIMIT = 700 * 1024;
/** 첨부 총량 상한(인라인+사이드밴드)의 **폴백** — 서버(Setting KV chat_limits, fleet 이 편집)가
 *  정본이고 이 상수는 서버 미도달/미배선 때만 쓰인다(loadEffort 의 CLAUDE_CODE_DEFAULT_EFFORT
 *  폴백과 같은 관용구). control-ts ChatLimitsService.DEFAULT_TOTAL_BYTES 와 같은 값 —
 *  한쪽만 바꾸면 미설정 org 와 오프라인 폴백이 서로 다른 상한을 갖게 된다.
 *
 *  주의: 이건 UX 노브지 보안 경계가 아니다. 바이트 fail-closed 는 서버 안전망
 *  (RELAY_UPLOAD_MAX_BYTES, 기본 1GiB — deployd·엔진·control 3곳)이 따로 집행한다. */
const ATT_TOTAL_LIMIT_FALLBACK = 30 * 1024 * 1024;

export type Attachments = {
  atts: PendingAtt[];
  /** 피커·드롭·붙여넣기 공통 입구. 실패는 던지지 않고 error 에 남긴다. */
  addFiles: (files: FileList | File[]) => Promise<void>;
  removeAtt: (id: string) => void;
  /** 발송 뒤 비우기 */
  clear: () => void;
  /** 첨부 실패/거절 사유 — alert 대신 인라인 배너로 always-visible.
   *  (sandbox 에 allow-modals 가 없으면 window.alert 는 무음 증발한다.) */
  error: string | null;
  setError: (e: string | null) => void;
  /** 아직 올라가는 중인 첨부가 있는가 — 전송 버튼을 잠그는 자리 */
  uploading: boolean;
};

/** 첨부 스테이징 — 소형(≤500KB, 인라인 합계 700KB 안)은 base64 인라인, 그 외는 사이드밴드
 *  업로드(진행률 칩 → 완료 시 참조 승격). */
export function useAttachments(): Attachments {
  const [atts, setAtts] = useState<PendingAtt[]>([]);
  const [error, setError] = useState<string | null>(null);
  // 총량 상한 — 서버가 정본. 도달 전/실패 시 폴백 상수로 동작하고 도착하면 갱신된다.
  // state 가 아니라 ref 인 이유: 렌더에 안 쓰이고 addFiles(async) 안에서만 읽힌다.
  const limitRef = useRef(ATT_TOTAL_LIMIT_FALLBACK);
  useEffect(() => {
    let alive = true;
    loadAttTotalLimit(ATT_TOTAL_LIMIT_FALLBACK).then((n) => { if (alive) limitRef.current = n; });
    return () => { alive = false; };
  }, []);

  // 현재 목록은 ref 로도 들고 있는다 — addFiles 는 []deps 로 고정하고 싶은데(리스너·핸들러가
  // 잡아 두므로) 누계 계산에는 최신 목록이 필요하다.
  const attsRef = useRef(atts);
  attsRef.current = atts;

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files);
    if (!arr.length) return;
    setError(null);

    const cur = attsRef.current;
    const current = cur.reduce((s, a) => s + a.size, 0);
    const incoming = arr.reduce((s, f) => s + f.size, 0);
    const limit = limitRef.current;
    if (current + incoming > limit) {
      setError(`첨부 용량이 너무 커요 (합계 최대 ${fmtSize(limit)}). 일부 파일을 빼 주세요.`);
      return;
    }

    let inlineTotal = cur.reduce((s, a) => (a.path || a.uploading ? s : s + a.size), 0);
    for (const f of arr) {
      const inline = f.size <= ATT_INLINE_FILE_LIMIT && inlineTotal + f.size <= ATT_INLINE_TOTAL_LIMIT;
      if (inline) {
        inlineTotal += f.size;
        try {
          const att = await readFileAsAtt(f);
          setAtts((prev) => [...prev, att]);
        } catch (e: any) {
          setError(`"${f.name || "첨부"}" 읽기 실패: ${e?.message ?? e}`);
        }
        continue;
      }
      // 사이드밴드 — 플레이스홀더 칩을 먼저 올리고 업로드 진행률을 흘린다.
      const id = `a${++_attSeq}`;
      const name = f.name || `pasted-${Date.now()}-${_attSeq}`;
      setAtts((prev) => [...prev, {
        id, name, mime: f.type || "application/octet-stream", dataUrl: "", size: f.size,
        uploading: true, progress: 0,
      }]);
      const patch = (p: Partial<PendingAtt>) =>
        setAtts((prev) => prev.map((a) => (a.id === id ? { ...a, ...p } : a)));
      try {
        const up = await uploadAttachment(f, name, (pct) => patch({ progress: pct }));
        patch({ path: up.path, uploading: false, progress: 100 });
      } catch (e: any) {
        setAtts((prev) => prev.filter((a) => a.id !== id));
        setError(`"${name}" 업로드 실패: ${e?.message ?? e}`);
      }
    }
  }, []);

  const removeAtt = useCallback((id: string) => setAtts((prev) => prev.filter((a) => a.id !== id)), []);
  const clear = useCallback(() => setAtts([]), []);

  return { atts, addFiles, removeAtt, clear, error, setError, uploading: atts.some((a) => a.uploading) };
}

// ── 끌어놓기 ────────────────────────────────────────────────────────────────

/** DataTransfer → File[] — files 가 비면 items(kind="file")로 폴백한다. 붙여넣기와 드롭이
 *  같은 추출기를 쓴다(WebKit 은 자리에 따라 둘 중 한쪽만 채운다). */
export function filesFrom(dt: DataTransfer | null | undefined): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files && dt.files.length) {
    for (let i = 0; i < dt.files.length; i++) out.push(dt.files[i]);
    return out;
  }
  const items = dt.items;
  for (let i = 0; i < (items ? items.length : 0); i++) {
    const it = items[i];
    if (it.kind === "file") { const f = it.getAsFile(); if (f) out.push(f); }
  }
  return out;
}

/** 지금 끌려오는 것이 파일인가 — 글자 선택·탭 DnD(text/plain)에는 반응하지 않는다. */
export const dragHasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes("Files");

// 판 밖으로 빗나간 파일 드롭의 기본 동작을 막는 창 수준 가드.
//
// 브라우저·웹뷰의 기본값은 "떨어뜨린 파일로 문서를 갈아치우기"다. 데스크톱 웹뷰에는 주소창도
// 뒤로가기도 없어 그렇게 날아간 화면으로는 되돌아올 길이 없다. 그래서 dragover/drop 의 기본
// 동작만 죽인다(전파는 막지 않는다 — 임베드 호스트의 제 드롭 처리는 그대로 산다).
// 드롭을 받는 자리가 하나라도 살아 있는 동안만 걸고, 마지막 자리가 내려가면 흔적 없이 뗀다.
let _dropGuardRefs = 0;
const _dropGuard = (e: DragEvent) => { if (dragHasFiles(e)) e.preventDefault(); };
export function useDropGuard(): void {
  useEffect(() => {
    if (_dropGuardRefs++ === 0) {
      window.addEventListener("dragover", _dropGuard);
      window.addEventListener("drop", _dropGuard);
    }
    return () => {
      if (--_dropGuardRefs === 0) {
        window.removeEventListener("dragover", _dropGuard);
        window.removeEventListener("drop", _dropGuard);
      }
    };
  }, []);
}

/** 판 전체를 표적으로 삼는 파일 드롭.
 *
 *  사람은 화면 한가운데에 파일을 떨어뜨리지, 높이 몇 십 px 짜리 입력 카드를 조준하지 않는다.
 *  표적이 입력 카드뿐이면 대부분의 드롭이 빗나가고, 빗나간 드롭은 문서를 그 파일로 갈아치운다
 *  (가드는 useDropGuard 가 진다).
 *
 *  `hostOf` 는 표적 판을 고른다 — 컴포저는 채팅 판(.rc-root), 홈은 홈 판. 리스너를 React
 *  합성 이벤트가 아니라 네이티브로 다는 이유: 그 판이 대개 이 컴포넌트의 **조상**이라
 *  props 로는 못 건다.
 *
 *  돌려주는 dropHost 는 드롭 표시를 포탈할 자리다 — 표시가 표적보다 좁으면, 실제로는 어디든
 *  되는데도 사람이 조준하게 만든다. */
export function useFileDrop(
  hostOf: () => HTMLElement | null,
  addFiles: (files: FileList | File[]) => void,
): { dragging: boolean; dropHost: HTMLElement | null } {
  const [dragging, setDragging] = useState(false);
  const [dropHost, setDropHost] = useState<HTMLElement | null>(null);
  const depth = useRef(0); // dragenter/leave 는 자식마다 뜬다 — 계수로 깜빡임을 막는다
  const addRef = useRef(addFiles);
  addRef.current = addFiles;
  const hostRef = useRef(hostOf);
  hostRef.current = hostOf;

  useEffect(() => {
    const host = hostRef.current();
    if (!host) return;
    setDropHost(host);
    const onEnter = (e: DragEvent) => { if (!dragHasFiles(e)) return; e.preventDefault(); depth.current++; setDragging(true); };
    const onOver = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      if (depth.current > 0 && --depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = filesFrom(e.dataTransfer);
      if (files.length) addRef.current(files);
    };
    // 끌던 것이 창 밖에서 놓이거나(Esc·취소) 창이 포커스를 잃으면 dragleave 가 짝을 못 맞춰
    // 오버레이가 굳는다 — 계수를 0 으로 되돌린다.
    const reset = () => { depth.current = 0; setDragging(false); };
    host.addEventListener("dragenter", onEnter);
    host.addEventListener("dragover", onOver);
    host.addEventListener("dragleave", onLeave);
    host.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    window.addEventListener("blur", reset);
    return () => {
      host.removeEventListener("dragenter", onEnter);
      host.removeEventListener("dragover", onOver);
      host.removeEventListener("dragleave", onLeave);
      host.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", reset);
      window.removeEventListener("blur", reset);
    };
  }, []);

  return { dragging, dropHost };
}

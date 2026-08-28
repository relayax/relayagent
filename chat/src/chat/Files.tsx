/*!
 * Files.tsx — 파일·이미지 표면: deliver_file 다운로드 카드(FileCard), 무대 산출물(StageFiles),
 * 사용자 첨부 이미지 칩(AttOpenChip)과 라이트박스(ImageLightbox), 기본 이미지 렌더 억제.
 * 그림은 shadcn Attachment / Dialog 가 맡고, 여기선 데이터 해석과 다운로드 링크만 다룬다.
 */
import { useState } from "react";
import { DownloadIcon, FileTextIcon, ImageIcon, TriangleAlertIcon } from "lucide-react";
import { fileDownloadUrl, IMAGE_NAME_RE } from "./runtime";
import { useRelayCtx } from "./ctx";
import { resultText, fmtSize, type AnyPart } from "./parts";
import {
  Attachment, AttachmentActions, AttachmentContent, AttachmentDescription,
  AttachmentGroup, AttachmentMedia, AttachmentTitle, AttachmentTrigger,
} from "@/components/ui/attachment";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

/** 파일명으로 미디어 아이콘 고르기 — 이미지 확장자면 ImageIcon, 나머지는 문서 아이콘.
 *  잣대(IMAGE_NAME_RE)는 이력 재생과 공유한다 — 한쪽만 바꾸면 재생된 첨부와 아이콘이 갈린다. */
function FileIcon({ name }: { name: string }) {
  return IMAGE_NAME_RE.test(name) ? <ImageIcon /> : <FileTextIcon />;
}

/** 다운로드 한 장 — 카드 전체가 다운로드 링크(AttachmentTrigger 가 `<a download>` 로 렌더).
 *  우측 화살표는 장식(aria-hidden): 실제 클릭 표면은 카드 전체라 액션을 따로 두면 탭 정지점만 는다. */
function DownloadAttachment({ name, href, bytes, size = "default" }: {
  name: string; href: string; bytes?: number; size?: "default" | "sm";
}) {
  return (
    <Attachment size={size} className="w-full max-w-[420px]">
      <AttachmentMedia><FileIcon name={name} /></AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
        {bytes !== undefined && <AttachmentDescription>{fmtSize(bytes)}</AttachmentDescription>}
      </AttachmentContent>
      <AttachmentActions>
        <span aria-hidden className="flex size-6 items-center justify-center text-primary"><DownloadIcon className="size-4" /></span>
      </AttachmentActions>
      <AttachmentTrigger render={<a href={href} download={name} />} title={`${name} 다운로드`} aria-label={`${name} 다운로드`} />
    </Attachment>
  );
}

/** deliver_file 파일 카드 — 에이전트가 건넨 workspace 파일(스냅샷)의 다운로드 표면.
 *  카드 데이터의 정본은 tool result(control JSON {ok, files:[{name,path,bytes}]} 원문) —
 *  결과 전(스트리밍)엔 args.paths 로 스켈레톤을 그린다. 링크는 deployd /api/fs/download
 *  프록시(세션 쿠키 인가 — control WorkspaceFsScopeGuard 판정)라 같은 URL 이라도 남의
 *  파일은 열리지 않는다. 스냅샷은 .uploads GC(7일) 뒤 만료 — 그 후 클릭은 404. */
export function FileCard({ part }: { part: AnyPart }) {
  const ctx = useRelayCtx();
  let files: Array<{ name: string; path: string; bytes: number }> = [];
  if (!part.isError && part.result !== undefined) {
    try {
      const j = JSON.parse(resultText(part.result));
      if (Array.isArray(j?.files)) files = j.files.filter((f: any) => f && f.name && f.path);
    } catch { /* 결과 미완/비정형 — 스켈레톤 유지 */ }
  }
  if (part.isError) {
    const msg = resultText(part.result);
    return (
      <Attachment state="error" className="max-w-[420px]">
        <AttachmentMedia><TriangleAlertIcon /></AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>파일 전달 실패</AttachmentTitle>
          {msg && <AttachmentDescription>{msg.slice(0, 200)}</AttachmentDescription>}
        </AttachmentContent>
      </Attachment>
    );
  }
  if (files.length === 0) {
    const names = Array.isArray(part.args?.paths)
      ? part.args.paths.map((p: any) => String(p).split("/").pop()).filter(Boolean).join(", ")
      : "";
    return (
      <Attachment state="processing" className="max-w-[420px]" role="status">
        <AttachmentMedia><Spinner aria-label="파일 전달 중" /></AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>파일 전달 중…</AttachmentTitle>
          {names && <AttachmentDescription>{names}</AttachmentDescription>}
        </AttachmentContent>
      </Attachment>
    );
  }
  // file.download(§5.4-27) — path 는 불투명 참조, URL 조립은 transport 소유(구 /api/fs/download 은퇴).
  return (
    <div className="flex flex-col gap-1.5">
      {files.map((f, i) => (
        <DownloadAttachment key={i} name={f.name} href={fileDownloadUrl(ctx, f.path)} bytes={f.bytes || 0} />
      ))}
    </div>
  );
}

/** 무대 산출물 카드 — 에이전트가 이 턴에 파일 교환 무대에 놓은 파일(봉투 `file` 이벤트 §6-35,
 *  기판이 턴 전후 무대 diff 로 발견해 알린다). 위의 FileCard 와 달리 **툴콜이 없다**: 파일을
 *  건네는 데 도구가 필요하지 않은 기판(무대에 놓기만 하면 되는 기판)에서는 알림이 턴 메타로 온다.
 *
 *  이걸 안 그리던 동안 기판은 알리고 계약은 날랐는데 화면만 버렸다 — 그래서 에이전트가 만든
 *  파일을 사용자가 받을 길이 없었고, "터미널에서 cp 해 주세요"가 유일한 안내였다(2026-08-25).
 *  크기를 모르니 작은 카드(size=sm)를 세로로 쌓는다 — 가로 스크롤 그룹은 이름이 잘려 못 읽는다. */
export function StageFiles({ paths }: { paths: readonly string[] }) {
  const ctx = useRelayCtx();
  if (!paths.length) return null;
  return (
    <AttachmentGroup className="flex-col gap-1.5 overflow-visible snap-none">
      {paths.map((p, i) => {
        const name = p.split("/").pop() || p;
        return <DownloadAttachment key={i} size="sm" name={name} href={fileDownloadUrl(ctx, p)} />;
      })}
    </AttachmentGroup>
  );
}

/** 사용자 메시지의 이미지 파트(+저작 시 실은 filename 확장) — 첨부 칩·라이트박스가 소비. */
export type UserImagePart = { type: "image"; image: string; filename?: string };

/** 첨부 이미지 칩 — [썸네일][파일명] 한 줄. 클릭 = 라이트박스(크게 보기).
 *  실측 W×H 는 칩에서 뺐다(2026-08-28): "하하" 한 마디에 두 줄짜리 칩이 붙으면 첨부가 말보다
 *  무거워 보인다. 치수는 크게 보기에서만 — 거기선 실제로 궁금한 정보다. */
export function AttOpenChip({ part, onOpen }: { part: UserImagePart; onOpen: () => void }) {
  const name = part.filename || "image";
  return (
    <Attachment size="xs" className="max-w-[240px] min-w-0 cursor-zoom-in">
      <AttachmentMedia variant="image">
        {/* 전역 .rc-bubble img(260px 썸네일 규칙)가 이기지 못하게 크기는 인라인으로 못 박는다 */}
        <img src={part.image} alt="" aria-hidden
             style={{ width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", objectFit: "cover", borderRadius: 0 }} />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{name}</AttachmentTitle>
      </AttachmentContent>
      <AttachmentTrigger onClick={onOpen} title={(part.filename || "이미지") + " — 클릭해서 크게 보기"} aria-label={(part.filename || "이미지") + " 크게 보기"} />
    </Attachment>
  );
}

/** 이미지 라이트박스 — Dialog(body 포털). 우상단 X·배경 클릭·Escape 닫기는 Dialog 가 맡는다.
 *  마운트 = 열림(Messages 가 조건부로 그린다) — 닫힘 신호만 onClose 로 올린다.
 *
 *  두 가지를 라이트박스에서만 다르게 잡는다(2026-08-28):
 *  ① 뒷배경은 짙게(overlayClassName) — 전역 dialog 의 bg-black/10 은 흰 화면 위에서 거의 티가
 *     안 나, 53×68 같은 작은 첨부를 열면 "모달"이 아니라 화면 한복판에 떠 있는 흰 조각으로 읽혔다.
 *  ② 최소 240×240 + object-contain — 원본 크기 그대로 띄우면 작은 이미지는 손톱만 하게 뜬다.
 *     contain 이라 작은 건 비율 유지한 채 키우고, 큰 건 예전대로 원본/뷰포트 상한을 따른다. */
export function ImageLightbox({ src, name, onClose }: { src: string; name?: string; onClose: () => void }) {
  const [dim, setDim] = useState("");
  // border-0 인 이유: 위젯 CSS 가 body 로 포탈되는 팝업(popover·dropdown·tooltip·dialog)에
  // `border: 1px solid` 를 준다(preflight 를 안 싣는 대가 — 색은 currentColor). 배경이 있는
  // 창에선 평범한 테두리지만, 배경 없는 이 창에선 사진과 캡션을 두르는 **검은 사각 선**으로
  // 남는다(2026-08-28). 전역 규칙은 다른 팝업이 쓰므로 여기서만 끈다.
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        overlayClassName="bg-black/55"
        className="flex w-auto max-w-[min(1400px,94vw)] flex-col items-center gap-2 border-0 bg-transparent p-0 ring-0 shadow-none sm:max-w-[min(1400px,94vw)] [&_[data-slot=dialog-close]]:top-2 [&_[data-slot=dialog-close]]:right-2 [&_[data-slot=dialog-close]]:rounded-full [&_[data-slot=dialog-close]]:bg-black/55 [&_[data-slot=dialog-close]]:text-white [&_[data-slot=dialog-close]]:hover:bg-black/75"
        aria-label={name || "이미지 크게 보기"}
      >
        <DialogTitle className="sr-only">{name || "이미지 크게 보기"}</DialogTitle>
        <img src={src} alt={name || ""}
             onLoad={(e) => { const im = e.currentTarget; if (im.naturalWidth) setDim(im.naturalWidth + "×" + im.naturalHeight); }}
             className="block h-auto max-h-[86vh] w-auto max-w-full min-h-[240px] min-w-[240px] rounded-[10px] bg-white object-contain shadow-[0_12px_48px_rgba(0,0,0,0.5)]" />
        {(name || dim) && (
          <div className="max-w-[90vw] truncate rounded-full bg-black/60 px-3 py-1 text-xs text-white">
            {name}{dim ? <span className="text-white/60">{name ? " · " : ""}{dim}</span> : null}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Parts 의 기본 이미지 렌더 억제 — 첨부는 위 칩 행이 전담(세로 나열 방지). */
export const NullImagePart = () => null;

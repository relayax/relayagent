// @relay/ui — RelayOS blessed UI 세트.
//
// 두 층이다:
//   src/ui/*   = shadcn 카탈로그 생성물(`cd lib/relay-ui && npx shadcn@latest add <name>`).
//                밀도만 우리 값으로 재조정했다(button h-8·input h-8·table p-3 — 업무 화면은
//                한 화면에 들어가는 행 수가 곧 생산성이다). API 는 스톡 그대로라 upstream
//                예제·shadcn/skills 지식이 그대로 통한다.
//   src/*      = 카탈로그에 대응물이 없어 우리가 소유하는 것(layout 골격 분자 — 카탈로그는
//                원자에서 멈추므로 페이지 골격층은 우리가 저작한다).
//
// 브랜드는 컴포넌트가 아니라 tokens.css 한 곳에서 갈아끼운다(governed-boundaries §5).
// 생성물에 손댄 곳은 DELTAS.md 가 전량 목록이다 — add --overwrite 로 되받으면 거기부터 본다.
// cn 은 @relay/relayjs 단일 소스 — 생성물의 "@/lib/utils" 는 받은 직후 그쪽으로 정정한다.

// 토스트는 카탈로그의 sonner 다(구 자체구현 toast.tsx 은퇴 — 같은 일을 하는 두 번째 어휘를
// 남기지 않는다). 호출은 레벨별 함수: toast.success/error/warning/info.
export { Toaster } from "./ui/sonner";
export { toast } from "sonner";

// ── 페이지 골격 분자 (src/layout.tsx — 우리 소유) ────────────────────────────
// 화면은 여백 값을 고르지 않는다 — 골격은 이 분자들을 조립하고, 여백 리듬은 여기서 굳는다.
export { Page, PageHeader, Toolbar, ListDetail, StatRow, StatTile } from "./layout";

// ⚠ combobox 는 뺐다 — base-ui 기반이라 className 이 함수(state=>string)로 오는데 우리 cn 은
//    문자열 합성기라 그 함수를 조용히 버린다(타입도 안 맞고 동작도 틀린다). 콤보박스가 필요하면
//    upstream 정본 레시피 그대로 Popover + Command 조합을 쓴다(Radix 기반이라 정합).
// ── shadcn 카탈로그 (src/ui/ — `npx shadcn@latest add <name>` 산출물) ─────────
// 생성물은 손으로 고치지 않는다: 고쳐야 하면 위 9종처럼 src/ 최상위로 승격해 소유한다
// (승격하면 CLI 재생성 대상에서 빠지므로 components.json 주석의 --overwrite 금지 목록에 추가).
export * from "./ui/badge";
export * from "./ui/button";
export * from "./ui/card";
export * from "./ui/dialog";
export * from "./ui/input";
export * from "./ui/label";
export * from "./ui/select";
export * from "./ui/table";
export * from "./ui/tabs";
export * from "./ui/accordion";
export * from "./ui/alert";
export * from "./ui/alert-dialog";
export * from "./ui/aspect-ratio";
export * from "./ui/attachment";
export * from "./ui/avatar";
export * from "./ui/breadcrumb";
export * from "./ui/bubble";
export * from "./ui/button-group";
export * from "./ui/calendar";
export * from "./ui/carousel";
export * from "./ui/chart";
export * from "./ui/checkbox";
export * from "./ui/collapsible";
export * from "./ui/command";
export * from "./ui/context-menu";
export * from "./ui/direction";
export * from "./ui/drawer";
export * from "./ui/dropdown-menu";
export * from "./ui/empty";
export * from "./ui/field";
export * from "./ui/form";
export * from "./ui/hover-card";
export * from "./ui/input-group";
export * from "./ui/input-otp";
export * from "./ui/item";
export * from "./ui/kbd";
export * from "./ui/marker";
export * from "./ui/menubar";
export * from "./ui/message";
export * from "./ui/message-scroller";
export * from "./ui/native-select";
export * from "./ui/navigation-menu";
export * from "./ui/pagination";
export * from "./ui/popover";
export * from "./ui/progress";
export * from "./ui/radio-group";
export * from "./ui/resizable";
export * from "./ui/scroll-area";
export * from "./ui/separator";
export * from "./ui/sheet";
export * from "./ui/sidebar";
export * from "./ui/skeleton";
export * from "./ui/slider";
export * from "./ui/sonner";
export * from "./ui/spinner";
export * from "./ui/switch";
export * from "./ui/textarea";
export * from "./ui/toggle";
export * from "./ui/toggle-group";
export * from "./ui/tooltip";

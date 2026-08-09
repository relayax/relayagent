import type { ChatClient } from "./index.js";

export interface MountOptions {
  pkg: string;
  /** float = 우측하단 부유(기본), inline = target 컨테이너를 채우는 컴포넌트형 */
  mode?: "float" | "inline";
  /** inline 모드의 마운트 대상 */
  target?: HTMLElement;
  slot?: string;
  agent?: string;
}

export interface MountHandle {
  client: ChatClient;
  root: HTMLElement;
  remove(): void;
}

export function mount(opts: MountOptions): MountHandle;

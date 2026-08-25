export interface AgentDecl {
  name: string;
  /** main 슬롯 착지점 — 최대 1. "짧은 이름과 같은 에이전트" 관례의 상위 호환 */
  default?: boolean;
  persona?: string;
  /** 빈 대화의 첫 줄 — 창구가 아니라 말하는 쪽 소속이다 */
  greeting?: string;
  skills?: string;
  commands?: string;
  dispatch?: string[];
  scripts?: string[];
  /** 세션에서 여는 폴더 — services[] 의 dir 선언 이름. 하나가 도구 넷이 된다. 미선언 = 안 보인다 */
  dirs?: string[];
}

export interface ServiceDecl {
  name: string;
  url?: string;
  /** REST 베이스 — 자격이 이 접두 안에서만 나가는 형 */
  api?: string;
  dir?: string;
  source?: string;
  dockerfile?: string;
  entry?: string;
  tools?: string[];
  port?: number;
  disk?: string;
  auth?: { kind?: string; env?: string };
}

/** 밖으로 나가는 두 형(url = MCP 문, api = REST 베이스)만 자격 축을 갖는다 — runner 의
 *  outwardService 와 같은 판정이다. source(몸)·dir(폴더)에는 auth 자리가 없다 */
export const isOutward = (s: ServiceDecl): boolean => s.url != null || s.api != null;

export interface EdgeDecl {
  provider: string;
  tools?: string[];
  mission?: string;
  /** 제공자의 자립 번들을 이 패키지 화면이 마운트한다 — true 만. tools·mission 과 배타 */
  components?: true;
}

/** 채널이 요구하는 자격의 **형태** — 값이 아니다. 화면이 이 선언으로 입력 칸을 그린다 */
export interface CredentialField {
  key?: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  list?: boolean;
  required?: boolean;
}

export interface ChannelDecl {
  name: string;
  source: string;
  entry: string;
  icon?: string;
  credential?: { fields: CredentialField[]; help?: { url?: string; note?: string } };
}

export interface TriggerDecl {
  id: string;
  when: { cron?: string; tz?: string; event?: string; filter?: Record<string, unknown>; debounce_ms?: number };
  then: { agent?: string; prompt?: string; route?: string; delivery?: string; script?: string };
}

export interface Manifest {
  schema?: string;
  name?: string;
  version?: string;
  display_name?: string;
  description?: string;
  icon?: string;
  requires?: {
    os?: string[];
    binaries?: { name: string; install?: string }[];
    apps?: { name: string; install?: string }[];
  };
  surfaces?: {
    view?: { source: string; out?: string };
    /** 다른 패키지의 화면이 마운트하는 자립 번들. 계약은 수출 하나 — mount(el, props) */
    components?: { source: string; out?: string };
    channels?: ChannelDecl[];
  };
  harness?: {
    variants?: { name: string; source: string; entry?: string; icon?: string; llm?: { provider?: string; icon?: string } }[];
    workdir?: string;
  };
  agents?: AgentDecl[];
  scripts?: { source: string };
  services?: ServiceDecl[];
  triggers?: TriggerDecl[];
  missions?: { name: string; description?: string }[];
  edges?: EdgeDecl[];
  /** 이 패키지의 동사가 부를 수 있는 host.* 의 캡. 미선언 = 전체(ring-0 결재가 유일한 경계) */
  host_methods?: string[];
  org?: unknown;
}

export interface Pkg {
  name: string;
  path: string;
  workspace: string;
  ring: number | null;
  model: string | null;
  harness: string | null;
  manifest: Manifest | null;
  error: string | null;
}

export interface Grant {
  consumer: string;
  provider: string;
  tools?: string[];
  mission?: string;
}

export interface Registry {
  packages: Pkg[];
  grants: Grant[];
}

/** 선언(edges) 한 줄에 결재 여부를 붙인 것 */
export interface EdgeView {
  consumer: string;
  provider: string | null;
  ref: string;
  tools?: string[];
  mission?: string;
  granted: boolean;
}

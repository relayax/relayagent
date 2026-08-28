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
  auth?: ServiceAuth;
}

/** services[].auth — 값이 아니라 계약이다. 칸(fields)은 채널 credential.fields 와 같은 어휘에 header 하나가 더 있다 */
export interface ServiceAuth {
  kind?: string;
  env?: string;
  /** Authorization 접두 — 미선언 = Bearer */
  scheme?: string;
  /** 없으면 주 기능이 서지 않는가 — 미선언 = true. false 면 없어도 돌고 그 기능만 꺼진다 */
  required?: boolean;
  fields?: CredentialField[];
  help?: { url?: string; note?: string };
  verify?: { url: string; headers?: Record<string, string> };
  client?: string;
}

/** 밖으로 나가는 두 형(url = MCP 문, api = REST 베이스)만 자격 축을 갖는다 — runner 의
 *  outwardService 와 같은 판정이다. source(몸)·dir(폴더)에는 auth 자리가 없다 */
export const isOutward = (s: ServiceDecl): boolean => s.url != null || s.api != null;

export type ServiceForm = "url" | "api" | "dir" | "container" | "process";

/** 서비스 네 형(문법: source | url | api | dir)의 화면 이름 — source 는 dockerfile 유무로 컨테이너·프로그램
 *  둘로 읽는다. 판정을 자리마다 삼항으로 다시 쓰면 한 형이 빠진다(2026-08-28: 지도와 상세가 api 형을
 *  "process" 로 그렸다). 형을 묻는 자리는 전부 이 하나를 부른다 */
export function serviceForm(s: ServiceDecl): ServiceForm {
  if (s.url != null) return "url";
  if (s.api != null) return "api";
  if (s.dir != null) return "dir";
  return s.dockerfile ? "container" : "process";
}

export const SERVICE_FORM_LABEL: Record<ServiceForm, string> = {
  url: "바깥 도구",
  api: "바깥 서비스",
  dir: "폴더",
  container: "컨테이너",
  process: "프로그램",
};

export interface EdgeDecl {
  provider: string;
  tools?: string[];
  mission?: string;
  /** 제공자의 자립 번들을 이 패키지 화면이 마운트한다 — true 만. tools·mission 과 배타 */
  components?: true;
}

/** 자격 입력 칸 하나의 **형태** — 값이 아니다. 채널 credential.fields 와 서비스 auth.fields 가 같은 어휘를
 *  쓰고, 화면이 이 선언으로 입력 칸을 그린다. header 만 서비스 전용이다(그 칸의 값이 Authorization 으로 나간다) */
export interface CredentialField {
  key?: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  list?: boolean;
  required?: boolean;
  header?: boolean;
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

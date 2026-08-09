export interface AgentDecl {
  name: string;
  persona?: string;
  skills?: string;
  commands?: string;
  dispatch?: string[];
  scripts?: string[];
}

export interface ServiceDecl {
  name: string;
  url?: string;
  dir?: string;
  source?: string;
  dockerfile?: string;
  entry?: string;
  tools?: string[];
  port?: number;
  disk?: string;
  auth?: { kind?: string; env?: string };
}

export interface EdgeDecl {
  provider: string;
  tools?: string[];
  mission?: string;
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
    chat?: { mode: string; greeting?: string };
    channels?: { name: string; source: string; entry: string; icon?: string }[];
  };
  harness?: {
    variants?: { name: string; source: string; entry?: string; icon?: string; llm?: { provider?: string; icon?: string } }[];
    workdir?: string;
  };
  hooks?: { deny?: string[] };
  agents?: AgentDecl[];
  scripts?: { source: string };
  services?: ServiceDecl[];
  triggers?: TriggerDecl[];
  missions?: { name: string; description?: string }[];
  edges?: EdgeDecl[];
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

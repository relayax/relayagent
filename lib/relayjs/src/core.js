/* chat core - UI 없는 하네스 호출 클라이언트. 콘솔(React)과 위젯(vanilla)이 같은 모듈을 소비한다.
   모든 호출은 throw 하지 않는다. 실패는 { error: { code, message } } 로 돌아온다 */

async function call(path, body) {
  try {
    const res = await fetch(path, body === undefined ? undefined : {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error != null) {
      const e = data.error;
      return { error: e && typeof e === "object" ? e : { code: "E_HTTP_" + res.status, message: String(e ?? res.status + " " + path) } };
    }
    return { data };
  } catch (e) {
    return { error: { code: "E_NETWORK", message: String(e) } };
  }
}

export function createChat(opts) {
  const pkg = String(opts.pkg);
  let slot = opts.slot || "console";
  const agent = opts.agent;
  const P = (rest) => "/pkg/" + encodeURIComponent(pkg) + rest;

  const history = [];
  const listeners = {};
  const queue = [];
  let busy = false;
  let pumping = false;
  let metaCache = null;
  let cmdCache = null;

  const emit = (ev, arg) => { for (const f of listeners[ev] || []) f(arg); };
  const on = (ev, fn) => {
    (listeners[ev] = listeners[ev] || []).push(fn);
    return () => { listeners[ev] = (listeners[ev] || []).filter((x) => x !== fn); };
  };
  const push = (role, text, files) => {
    const m = { role, text, ...(files && files.length ? { files } : {}) };
    history.push(m);
    emit("message", m);
    return m;
  };
  const setBusy = (b) => { busy = b; emit("busy", b); };

  async function meta() {
    if (metaCache) return metaCache;
    const r = await call("/registry");
    const p = r.data ? (r.data.packages || []).find((x) => x.name === pkg) : null;
    const agents = ((p && p.manifest && p.manifest.agents) || []).map((a) => a.name);
    // 세션이 착지할 에이전트: 명시(agent 옵션)가 없으면 착지 에이전트(패키지 짧은 이름과 같은 것).
    // 기판 landingAgentName 과 같은 판정 — 없으면 null (범용 페르소나 세션)
    const short = String((p && p.manifest && p.manifest.name) || "").split("/").pop() || "";
    metaCache = {
      found: !!p,
      display_name: (p && p.manifest && p.manifest.display_name) || pkg,
      chat: (p && p.manifest && p.manifest.surfaces && p.manifest.surfaces.chat) || null,
      greeting: (p && p.manifest && p.manifest.surfaces && p.manifest.surfaces.chat && p.manifest.surfaces.chat.greeting) || "",
      harness: (p && p.manifest && p.manifest.harness) || null,
      model: (p && p.model) || null,
      effort: (p && p.effort) || null,
      agents,
      agent: agent || (agents.includes(short) ? short : null),
    };
    emit("meta", metaCache);
    return metaCache;
  }
  const ready = meta();

  // busy 중의 send 는 버리지 않고 줄 세운다. 같은 slot 에 세션이 동시에 뜨면 충돌하기 때문.
  // busy 는 큐가 빌 때까지 한 번만 켜진다 — 항목 사이에서 깜빡이면 대기 표시가 끊긴다
  async function pump() {
    if (pumping) return;
    pumping = true;
    setBusy(true);
    while (queue.length) {
      const item = queue.shift();
      // 이 항목이 지금 발사됐다 — 화면이 "전송 대기 중" 표시를 풀 유일한 신호다.
      // busy 는 큐 전체에 한 번만 켜지므로 항목 경계는 이 이벤트로만 알 수 있다
      emit("turn", { remaining: queue.length });
      // 진행 이벤트 폴링 — 봉투 어댑터의 delta·tool 이 events.jsonl 로 흐른다.
      // 폴링인 이유: /chat 은 종결까지 붙드는 단일 POST 라 사이드밴드로 진행을 읽는다
      let seen = 0;
      let polling = false;
      const poll = setInterval(async () => {
        if (polling) return;
        polling = true;
        const pr = await call(P("/session/" + encodeURIComponent(slot) + "/events"));
        const evs = pr.data && Array.isArray(pr.data.events) ? pr.data.events : [];
        for (; seen < evs.length; seen++) emit("progress", evs[seen]);
        polling = false;
      }, 900);
      const r = await call(P("/chat"), {
        message: item.text,
        slot,
        ...((item.agent || agent) ? { agent: item.agent || agent } : {}),
        ...(item.atts.length ? { attachments: item.atts } : {}),
      });
      clearInterval(poll);
      if (r.error) {
        push("sys", "오류: " + r.error.message);
        item.resolve({ error: r.error });
      } else {
        push("bot", r.data.reply || "(빈 응답)", Array.isArray(r.data.files) && r.data.files.length ? r.data.files : undefined);
        if (r.data.usage || r.data.model) emit("usage", { usage: r.data.usage || null, model: r.data.model || null });
        item.resolve({ reply: r.data.reply || "" });
      }
    }
    setBusy(false);
    pumping = false;
  }

  function send(text, opts) {
    const t = String(text ?? "").trim();
    const atts = Array.isArray(opts && opts.attachments) ? opts.attachments.filter((a) => a && a.path) : [];
    if (!t && !atts.length) return Promise.resolve({ error: { code: "E_EMPTY", message: "빈 메시지" } });
    const msg = t || "첨부 파일을 확인해줘";
    // 말풍선은 보낸 즉시 그린다. 큐에 있는 동안 보이지 않으면 유실처럼 보인다.
    // display 는 화면용 원문(@멘션 포함), msg 는 실제 프롬프트 — 멘션 라우팅이 갈라놓는다
    push("user", (opts && opts.display) || msg, atts.map((a) => ({ name: a.name || String(a.path).split("/").pop(), path: a.path })));
    return new Promise((resolve) => {
      queue.push({ text: msg, atts, resolve, agent: (opts && opts.agent) || null });
      pump();
    });
  }

  // 진행 중 턴 중단 — 봉투 cancel 제어(stdin) 1순위, 기판이 신호 그물을 겹친다
  async function cancel() {
    const r = await call(P("/session/" + encodeURIComponent(slot) + "/cancel"), {});
    return r.error ? { error: r.error } : r.data;
  }

  // 첨부는 세 입력 경로(파일선택·드래그·붙여넣기) 전부 바이트로 환원해 사이드밴드로 올린다.
  // 원본 파일시스템 경로는 절대 싣지 않는다 — 반환된 workspace 상대경로가 유일한 참조다
  function upload(file, onProgress) {
    return new Promise((resolve) => {
      try {
        const name = (file && file.name) || "file";
        const xhr = new XMLHttpRequest();
        xhr.open("POST", P("/upload?name=" + encodeURIComponent(name)));
        xhr.setRequestHeader("content-type", (file && file.type) || "application/octet-stream");
        if (xhr.upload && onProgress) {
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
          };
        }
        xhr.onload = () => {
          let body = null;
          try { body = JSON.parse(xhr.responseText || "null"); } catch { body = null; }
          if (xhr.status >= 200 && xhr.status < 300 && body && body.path) {
            if (onProgress) onProgress(100);
            resolve({ path: body.path, size: body.size ?? (file ? file.size : 0), name: body.name || name });
            return;
          }
          const e = body && body.error;
          resolve({ error: e && typeof e === "object" ? e : { code: "E_UPLOAD", message: String(e || "업로드 실패(HTTP " + xhr.status + ")") } });
        };
        xhr.onerror = () => resolve({ error: { code: "E_NETWORK", message: "업로드 실패(네트워크)" } });
        xhr.send(file);
      } catch (e) {
        resolve({ error: { code: "E_UPLOAD", message: String(e) } });
      }
    });
  }

  const fileUrl = (rel, dl) =>
    P("/file/" + String(rel).split("/").map(encodeURIComponent).join("/")) + (dl ? "?dl=1" : "");

  async function reset() {
    const r = await call(P("/session/reset"), { slot });
    history.length = 0;
    emit("reset");
    return r.error ? { error: r.error } : { ok: true };
  }

  // ── 세션 관리 — 기판의 세션 장부(history.jsonl)를 소비한다 ──────────────
  async function loadHistory() {
    const r = await call(P("/session/" + encodeURIComponent(slot) + "/history"));
    if (r.error) return { error: r.error };
    history.length = 0;
    for (const m of Array.isArray(r.data.messages) ? r.data.messages : []) {
      if (m && m.role && m.text != null) {
        // 빈 답변 기록은 새로고침하면 아무것도 아닌 것이 되어 대화에서 통째로 증발한다.
        // 무슨 일이 있었는지는 남겨야 한다 — 빈 자리는 빈 자리라고 말해준다
        const text = String(m.text);
        history.push({
          role: m.role === "user" ? "user" : m.role === "bot" ? "bot" : "sys",
          text: m.role === "bot" && !text.trim() ? "(응답이 저장되지 않은 턴입니다)" : text,
          ...(Array.isArray(m.files) && m.files.length ? { files: m.files } : {}),
          ...(m.usage ? { usage: m.usage } : {}),
          ...(m.model ? { model: m.model } : {}),
        });
      }
    }
    emit("history");
    return { messages: history.length };
  }
  loadHistory();

  const sessions = {
    async list() {
      const r = await call(P("/sessions"));
      if (r.error) return { error: r.error, sessions: [] };
      return { sessions: Array.isArray(r.data.sessions) ? r.data.sessions : [] };
    },
    async open(s) {
      slot = String(s);
      history.length = 0;
      emit("session", slot);
      await loadHistory();
      return { slot };
    },
    create() {
      // 새 대화 = 새 slot. 디렉토리는 첫 발화 때 기판이 만든다
      slot = "c-" + Date.now().toString(36);
      history.length = 0;
      emit("session", slot);
      emit("history");
      return { slot };
    },
    async rename(s, label) {
      const r = await call(P("/session/" + encodeURIComponent(s) + "/label"), { label });
      return r.error ? { error: r.error } : { ok: true };
    },
    // 보관/복원 — 이력은 그대로 두고 목록의 자리만 옮긴다 (list 의 archived 필드)
    async archive(s, on) {
      const r = await call(P("/session/" + encodeURIComponent(s) + "/archive"), { archived: !!on });
      return r.error ? { error: r.error } : { ok: true, archived: !!on };
    },
    // 고정/해제 — 목록 맨 위로 (list 의 pinned 필드, 서버가 고정 우선으로 정렬한다)
    async pin(s, on) {
      const r = await call(P("/session/" + encodeURIComponent(s) + "/pin"), { pinned: !!on });
      return r.error ? { error: r.error } : { ok: true, pinned: !!on };
    },
    async remove(s) {
      const r = await call(P("/session/" + encodeURIComponent(s) + "/delete"), {});
      if (r.error) return { error: r.error };
      if (String(s) === slot) sessions.create();
      return { ok: true };
    },
  };

  const harness = {
    async models() {
      const [r, m] = await Promise.all([call(P("/harness/models")), meta()]);
      if (r.error) return { error: r.error };
      return { models: Array.isArray(r.data.value) ? r.data.value : [], current: m.model };
    },
    async setModel(model) {
      const r = await call(P("/model"), { model: model == null ? "" : String(model) });
      if (r.error) return { error: r.error };
      if (metaCache) metaCache.model = r.data.model || null;
      return { model: r.data.model || null, known: r.data.known ?? null };
    },
    async setEffort(level) {
      const r = await call(P("/model"), { effort: level == null ? "" : String(level) });
      if (r.error) return { error: r.error };
      if (metaCache) metaCache.effort = r.data.effort || null;
      return { effort: r.data.effort || null };
    },
    async setup() {
      const r = await call(P("/harness/setup"));
      return r.error ? { error: r.error } : r.data; // { ok, out }
    },
    async info() {
      const r = await call(P("/harness/info"));
      return r.error ? { error: r.error } : r.data; // { ok, value: { name, provider, verbs, protocol, capabilities } }
    },
    async commands() {
      if (cmdCache) return { commands: cmdCache };
      const r = await call(P("/harness/commands"));
      if (r.error) return { error: r.error, commands: [] };
      cmdCache = Array.isArray(r.data.value) ? r.data.value : [];
      return { commands: cmdCache };
    },
    async variants(probe) {
      // probe = variant 전수 실행: 행별 ready·note·account·capabilities 가 실린다 (설정 시트용)
      const r = await call(P("/harness" + (probe ? "?probe=1" : "")));
      return r.error ? { error: r.error } : r.data; // { active, variants: [{ name, provider, ready?, ... }] }
    },
    async connect(token) {
      // token 자격형 — vault 에 provider 소속으로 앉는다
      const r = await call(P("/harness/connect"), { token: String(token ?? "") });
      return r.error ? { error: r.error } : r.data; // { ok, setup }
    },
    // headless 로그인 중계 — 출력은 read 로 당기고 입력은 input 으로 넣는다.
    // 자격은 도구가 만든다. 기판도 화면도 토큰을 보관하지 않는다
    async loginRead(from) {
      const r = await call(P("/harness/login/read?from=" + (from || 0)));
      return r.error ? { error: r.error } : r.data; // { lines, from, done, code, running }
    },
    async loginInput(text) {
      const r = await call(P("/harness/login/input"), { text: String(text ?? "") });
      return r.error ? { error: r.error } : r.data;
    },
    async loginStop() {
      const r = await call(P("/harness/login/stop"), {});
      return r.error ? { error: r.error } : r.data;
    },
    async login(opts) {
      // 대화형 자격 — 기판이 터미널 창을 열어 login 동사를 돌린다. 인증은 그 창이 소유한다.
      // switch = 기존 자격을 비우고 다시 로그인 (계정 갈아타기)
      const r = await call(P("/harness/login"), {
        switch: !!(opts && opts.switch),
        ...(opts && opts.mode ? { mode: opts.mode } : {}),
      });
      return r.error ? { error: r.error } : r.data; // { launched, command, note }
    },
    async setVariant(name) {
      const r = await call(P("/harness"), { name });
      if (r.error) return { error: r.error };
      // 하네스가 바뀌면 커맨드와 모델은 새 어댑터 소관이다
      cmdCache = null;
      metaCache = null;
      return r.data; // { active, setup: { ok, out } }
    },
  };

  return {
    pkg, history, on, send, cancel, reset, meta, ready, harness, sessions, upload, fileUrl,
    get slot() { return slot; },
    get busy() { return busy; },
  };
}

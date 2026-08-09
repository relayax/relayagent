// 구 경로 호환 shim — 코어는 기판 자산으로 이사했다. 정본: /assets/chat-core.js (lib/relayjs)
import("/assets/chat-core.js").then((m) => {
  window.RelayChat = { create: m.createChat };
});

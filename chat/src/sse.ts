/*!
 * sse.ts — SSE(text/event-stream) 프레이밍 파서. 순수 모듈: 전송 계획·경로 어휘·에러 봉투와
 * 무결합이다. 신 클라이언트 계약(docs/client-protocol.md)의 턴 스트림이 이 프레이밍 위에 선다.
 *
 * 출처(Phase 0-a 상륙, 2026-08-17): relayos-claude chat/src/chat/transport.ts
 *   - SSEParser: transport.ts:207-246
 *   - decodeSSEData: transport.ts:181-187
 * 상륙 후 이 사본이 정본이다 — relayos 원본은 손 편집 금지(upstream-first).
 *
 * 절제 목록 — 원본 transport.ts 에서 가져오지 않은 것과 그 이유:
 *   - reshapeSSEData / Reshaped (transport.ts:179-205): deployd/control 프레임 전제
 *     ({type:"result"} 터미널 후보 · {data:<line>} 래핑 — 브리지 rpc_event 동형 재성형).
 *     org wire 결합부라 상륙 대상이 아니다. 신 계약은 봉투 이벤트를 SSE data 한 줄에
 *     그대로 싣으므로 재성형 층 자체가 없다.
 *   - HTTP 매핑표 (transport.ts:26-138): 브리지 method 명 → 파사드 요청 계획으로 번역하는
 *     계획 함수와 그 타입·보조들 — Phase 1-b 에서 신 계약 wire 로 재작성되며 은퇴하는 어휘.
 *   - parseErrorBody·toError (transport.ts:140-175): deployd writeJSONError·control
 *     HttpException 봉투 결합.
 *   - HTTP 실행부·협업 push 구독 (transport.ts:248-392): 쿠키 세션 재시도·인스턴스 헤더·
 *     EventSource 이벤트 파사드 결합.
 */

/** 터미널 data 가 JSON 문자열이면 파싱해 반환(bridge.go decodeSSEData 미러). */
export function decodeSSEData(v: unknown): unknown {
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { /* 문자열 그대로 = 최종 텍스트 폴백 */ }
  }
  return v;
}

/**
 * SSEParser — 바이트 청크를 SSE 메시지 경계(빈 줄)로 조립. data: 라인만 축적,
 * event:/id:/retry:/주석은 무시(bridge.go 스캐너와 동일 규칙 — 의미는 data JSON 안에 있다).
 */
export class SSEParser {
  private tail = "";
  private dataBuf: string[] = [];

  private pushData(line: string): void {
    let v = line.slice(5); // "data:" 제거
    if (v.startsWith(" ")) v = v.slice(1);
    this.dataBuf.push(v);
  }

  /** feed — 청크 소화, 완성된 메시지들의 data(개행 병합) 배열 반환. */
  feed(chunk: string): string[] {
    const out: string[] = [];
    const lines = (this.tail + chunk).split("\n");
    this.tail = lines.pop() ?? "";
    for (let line of lines) {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        if (this.dataBuf.length) { out.push(this.dataBuf.join("\n")); this.dataBuf = []; }
        continue;
      }
      if (line.startsWith("data:")) this.pushData(line);
    }
    return out;
  }

  /** flush — EOF: 개행 없이 끝난 잔여 메시지(터미널이 마지막인 경우) 반환. */
  flush(): string | null {
    let line = this.tail;
    this.tail = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.startsWith("data:")) this.pushData(line);
    if (this.dataBuf.length) { const m = this.dataBuf.join("\n"); this.dataBuf = []; return m; }
    return null;
  }
}

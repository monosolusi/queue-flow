import '@testing-library/jest-dom/vitest';

// jsdom doesn't implement WebSocket. The QueueSocket accepts an injected
// constructor, so tests pass a fake via socketOptions/QueueSocketOptions. This
// global stub is only a safety net for any code path that falls back to the
// default WebSocket — it is never the transport under test.
class FakeWebSocketStub {
  static instances: FakeWebSocketStub[] = [];
  static clear() {
    FakeWebSocketStub.instances = [];
  }
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocketStub.instances.push(this);
  }
  close() {
    this.readyState = 3;
  }
}

const globalObj = globalThis as unknown as { WebSocket?: unknown };
if (!globalObj.WebSocket) {
  globalObj.WebSocket = FakeWebSocketStub;
}

export { FakeWebSocketStub };
import '@testing-library/jest-dom/vitest';

// jsdom has no global WebSocket. The TV realtime client takes an injectable
// `WebSocketCtor` (the transport-constructor seam — see CLAUDE.md frontend
// conventions), so a test-injected fake transport works without a global.
// The audio path takes an injectable `AudioCtor` for the same reason (jsdom
// has no HTMLAudioElement playback), so no global Audio stub is needed either.
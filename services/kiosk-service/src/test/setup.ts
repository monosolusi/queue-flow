import '@testing-library/jest-dom/vitest';

// The kiosk does not consume the WebSocket surface in QUE-17 (it is a
// ticket-issuing device, not a queue monitor — SRP), so unlike caller-service
// there is no global WebSocket stub here. If a realtime client is added later,
// mirror the caller-service setup.ts stub + the options-injection seam.
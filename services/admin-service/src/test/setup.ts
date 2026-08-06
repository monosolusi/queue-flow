import '@testing-library/jest-dom/vitest';

// The admin panel does not consume the WebSocket surface (SRP): it is a
// config/wizard/analytics tool that QUE-44 expands into a read-only
// operational monitor via REST polling (no realtime participation), so there
// is no global WebSocket stub here. fetch is provided by jsdom; tests that need
// to stub network calls inject a fake IAdminApi into the components directly
// (the seam is the API interface, not the global fetch).
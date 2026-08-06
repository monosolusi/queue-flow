-- QUE-43 opaque session tokens. The raw bearer token is NEVER stored — only its
-- SHA-256 `token_hash` is persisted, so a DB leak cannot authenticate a session.
-- `token_hash` is UNIQUE and indexed (the per-request `AuthGuard` lookup is an
-- indexed PK hit, well within the p99<100ms budget, NFR-PERF-01). Real
-- revocation: `DELETE` the row on logout / user delete — the token is instantly
-- invalid, no JWT blocklist needed. `ON DELETE CASCADE` from `users` keeps
-- sessions clean when a user is deleted (the use case also calls
-- `deleteByUserId` explicitly, but the cascade is the durable backstop).
-- `expires_at` is epoch-ms BIGINT; `findActiveByTokenHash` filters
-- `expires_at > now` so expired sessions are skipped (and `deleteExpired`
-- sweeps them). `CREATE TABLE IF NOT EXISTS` keeps this idempotent.

CREATE TABLE IF NOT EXISTS sessions (
  id          UUID    PRIMARY KEY,
  user_id     UUID    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT    UNIQUE NOT NULL,
  expires_at  BIGINT  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_idx
  ON sessions (token_hash);
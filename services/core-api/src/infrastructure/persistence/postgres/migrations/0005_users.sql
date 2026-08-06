-- QUE-43 Identity bounded context: local user accounts for AuthN/AuthZ.
-- Users exist ONLY for the caller and admin services; kiosk and TV have no
-- users and no auth on their endpoints. Two roles: `admin` (admin-service) and
-- `caller-staff` (caller-service) — the CHECK constraint mirrors the closed
-- `Role` enum in the domain, so a hand-crafted insert with an unknown role is
-- rejected at the DB too (defense-in-depth). `username` is UNIQUE (the login
-- lookup key + the `DuplicateUserException` guard). `password_hash` stores the
-- encoded `scrypt:<saltHex>:<hashHex>` string — never the plain password.
-- `CREATE TABLE IF NOT EXISTS` keeps this idempotent against the migration
-- runner's SHA-256 re-apply guard. Timestamps are epoch-ms BIGINT to match the
-- rest of the schema (tickets, audit_log).

CREATE TABLE IF NOT EXISTS users (
  id            UUID         PRIMARY KEY,
  username      TEXT         UNIQUE NOT NULL,
  password_hash TEXT         NOT NULL,
  role          TEXT         NOT NULL CHECK (role IN ('admin', 'caller-staff')),
  created_at    BIGINT       NOT NULL,
  updated_at    BIGINT       NOT NULL
);
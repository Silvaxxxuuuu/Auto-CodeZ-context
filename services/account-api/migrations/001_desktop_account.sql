CREATE TABLE IF NOT EXISTS desktop_account (
  user_id TEXT PRIMARY KEY,
  primary_email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  username TEXT UNIQUE,
  avatar_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled', 'pending_deletion')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS desktop_identity (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES desktop_account(user_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'microsoft', 'passkey', 'magic_link')),
  provider_account_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  linked_at TIMESTAMPTZ NOT NULL,
  last_used_at TIMESTAMPTZ,
  UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS desktop_auth_flow (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('oauth', 'magic_link', 'passkey')),
  device_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'microsoft', 'passkey', 'magic_link')),
  outer_state TEXT NOT NULL,
  outer_nonce TEXT,
  code_challenge TEXT NOT NULL,
  requested_email TEXT,
  user_id TEXT,
  user_email TEXT,
  user_name TEXT,
  user_image TEXT,
  one_time_hash TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  one_time_expires_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS desktop_auth_flow_expires_at_idx
  ON desktop_auth_flow(expires_at);

CREATE TABLE IF NOT EXISTS desktop_session (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES desktop_account(user_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'github', 'microsoft', 'passkey', 'magic_link')),
  created_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  refresh_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS desktop_session_user_device_idx
  ON desktop_session(user_id, device_id);

CREATE TABLE IF NOT EXISTS desktop_refresh_token (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES desktop_session(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS desktop_refresh_token_session_idx
  ON desktop_refresh_token(session_id);

CREATE TABLE IF NOT EXISTS device_registry (
  device_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES desktop_account(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  app_version TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS device_registry_user_idx
  ON device_registry(user_id);

CREATE TABLE IF NOT EXISTS device_registration (
  registration_id UUID PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES desktop_account(user_id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES desktop_session(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  app_version TEXT NOT NULL,
  public_key TEXT NOT NULL,
  challenge TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS device_registration_expires_idx
  ON device_registration(expires_at);

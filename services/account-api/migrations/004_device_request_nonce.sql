CREATE TABLE IF NOT EXISTS device_request_nonce (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (user_id, device_id, nonce),
  CONSTRAINT device_request_nonce_device_fkey
    FOREIGN KEY (user_id, device_id)
    REFERENCES device_registry(user_id, device_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS device_request_nonce_expires_at_idx
  ON device_request_nonce(expires_at);

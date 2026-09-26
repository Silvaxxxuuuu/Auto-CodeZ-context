ALTER TABLE IF EXISTS device_registration
  DROP CONSTRAINT IF EXISTS device_registration_session_id_fkey;

ALTER TABLE IF EXISTS device_registration
  DROP CONSTRAINT IF EXISTS device_registration_user_id_fkey;

ALTER TABLE IF EXISTS device_registry
  DROP CONSTRAINT IF EXISTS device_registry_user_id_fkey;

ALTER TABLE IF EXISTS device_registration
  DROP COLUMN IF EXISTS session_id;

-- Add credentials for the custom username/password authentication path.
-- Nullable columns preserve existing Cognito-provisioned and local-dev users.

ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(32);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(256);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(256);

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON users (username)
  WHERE username IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON users (email)
  WHERE email IS NOT NULL;

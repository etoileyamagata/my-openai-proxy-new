-- Additive migration. Existing administrator sessions remain valid.
CREATE TABLE IF NOT EXISTS ail_ebay_staff (
  staff_id text PRIMARY KEY CHECK (staff_id ~ '^[0-9]{3}$'),
  code_hash text NOT NULL UNIQUE CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ail_ebay_browsers (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  credential_stamp text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '90 days',
  revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS ail_ebay_staff_sessions (
  session_hash text PRIMARY KEY REFERENCES ail_ebay_sessions(token_hash) ON DELETE CASCADE,
  staff_id text NOT NULL REFERENCES ail_ebay_staff(staff_id),
  staff_version integer NOT NULL,
  browser_id text NOT NULL REFERENCES ail_ebay_browsers(id)
);

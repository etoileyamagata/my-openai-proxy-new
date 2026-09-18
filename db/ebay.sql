-- Run once against a dedicated PostgreSQL database. Never use a per-PC database.
CREATE TABLE IF NOT EXISTS ail_ebay_settings (
  environment text PRIMARY KEY CHECK (environment IN ('sandbox','production')),
  revision integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO ail_ebay_settings(environment) VALUES ('sandbox'),('production') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ail_ebay_drafts (
  id text PRIMARY KEY,
  content_key text NOT NULL UNIQUE,
  revision integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ail_ebay_submissions (
  environment text NOT NULL,
  seller text NOT NULL,
  sku text NOT NULL,
  draft_id text NOT NULL REFERENCES ail_ebay_drafts(id),
  attempt text NOT NULL,
  state text NOT NULL CHECK (state IN ('sending','unknown','failed','published')),
  item_id text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(environment,seller,sku)
);
CREATE TABLE IF NOT EXISTS ail_ebay_oauth (
  state_hash text PRIMARY KEY,
  session_hash text NOT NULL,
  environment text NOT NULL,
  revision integer NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE IF NOT EXISTS ail_ebay_rates (
  key text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS ail_ebay_sessions (
  token_hash text PRIMARY KEY, csrf text NOT NULL, credential_stamp text NOT NULL,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '8 hours'
);
CREATE TABLE IF NOT EXISTS ail_ebay_uploads (
  id text PRIMARY KEY, draft_id text NOT NULL REFERENCES ail_ebay_drafts(id),
  revision integer NOT NULL, settings_revision integer NOT NULL, size integer NOT NULL CHECK(size>0 AND size<=12582912),
  name text NOT NULL, consumed boolean NOT NULL DEFAULT false,
  expires_at timestamptz NOT NULL DEFAULT now()+interval '30 minutes'
);
CREATE TABLE IF NOT EXISTS ail_ebay_chunks (
  upload_id text NOT NULL REFERENCES ail_ebay_uploads(id) ON DELETE CASCADE,
  part integer NOT NULL CHECK(part>=0 AND part<12),
  data bytea NOT NULL CHECK(octet_length(data)>0 AND octet_length(data)<=1048576),
  PRIMARY KEY(upload_id,part)
);

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

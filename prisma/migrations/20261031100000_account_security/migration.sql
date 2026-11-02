-- Account security: password-reset tokens and auth throttling counters.
-- Additive only: two new tables, no change to existing data.

CREATE TABLE "password_reset_token" (
  "id"           UUID         NOT NULL DEFAULT gen_random_uuid(),
  "org_id"       UUID         NOT NULL,
  "user_id"      UUID         NOT NULL,
  "token_hash"   TEXT         NOT NULL,
  "created_at"   timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at"   timestamp(3) NOT NULL,
  "used_at"      timestamp(3),
  "requested_ip" TEXT,
  CONSTRAINT "password_reset_token_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "password_reset_token_expiry_check" CHECK ("expires_at" > "created_at")
);
CREATE UNIQUE INDEX "password_reset_token_token_hash_key" ON "password_reset_token"("token_hash");
CREATE INDEX "password_reset_token_user_id_idx" ON "password_reset_token"("user_id");
ALTER TABLE "password_reset_token"
  ADD CONSTRAINT "password_reset_token_org_id_user_id_fkey"
  FOREIGN KEY ("org_id", "user_id") REFERENCES "app_user"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "auth_throttle" (
  "key"          TEXT         NOT NULL,
  "window_start" timestamp(3) NOT NULL,
  "count"        INTEGER      NOT NULL,
  CONSTRAINT "auth_throttle_pkey" PRIMARY KEY ("key"),
  CONSTRAINT "auth_throttle_count_check" CHECK ("count" >= 0)
);

-- The app's runtime role is created outside Prisma (docs/db-roles-and-security.sql), so grant only
-- when it exists, exactly like earlier migrations. Neither table is a protected ledger.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mops_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON password_reset_token, auth_throttle TO mops_runtime;
  END IF;
END
$$;

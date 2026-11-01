CREATE TABLE "alexa_auth_codes" (
    "id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "code_challenge" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "alexa_auth_codes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "alexa_grants" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "access_token_hash" TEXT NOT NULL,
    "access_expires_at" TIMESTAMP(3) NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    CONSTRAINT "alexa_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "alexa_auth_codes_code_hash_key" ON "alexa_auth_codes"("code_hash");
CREATE INDEX "alexa_auth_codes_expires_at_idx" ON "alexa_auth_codes"("expires_at");
CREATE UNIQUE INDEX "alexa_grants_access_token_hash_key" ON "alexa_grants"("access_token_hash");
CREATE UNIQUE INDEX "alexa_grants_refresh_token_hash_key" ON "alexa_grants"("refresh_token_hash");
CREATE INDEX "alexa_grants_household_id_user_id_idx" ON "alexa_grants"("household_id", "user_id");

ALTER TABLE "alexa_auth_codes" ADD CONSTRAINT "alexa_auth_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alexa_auth_codes" ADD CONSTRAINT "alexa_auth_codes_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alexa_grants" ADD CONSTRAINT "alexa_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "alexa_grants" ADD CONSTRAINT "alexa_grants_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

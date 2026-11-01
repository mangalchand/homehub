-- AlterTable
ALTER TABLE "users" ADD COLUMN "approval_status" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "approval_token_hash" TEXT;

-- AlterTable
ALTER TABLE "households" ADD COLUMN "approval_status" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "approval_token_hash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "users_approval_token_hash_key" ON "users"("approval_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "households_approval_token_hash_key" ON "households"("approval_token_hash");

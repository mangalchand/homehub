BEGIN;

-- CreateTable
CREATE TABLE "attachment_object_cleanups" (
    "id" UUID NOT NULL,
    "attachment_id" UUID,
    "storage_key" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachment_object_cleanups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "attachment_object_cleanups_storage_key_key" ON "attachment_object_cleanups"("storage_key");
CREATE INDEX "attachment_object_cleanups_next_attempt_at_idx" ON "attachment_object_cleanups"("next_attempt_at");

ALTER TABLE "attachment_object_cleanups"
  ADD CONSTRAINT "attachment_object_cleanups_attempts" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "attachment_object_cleanups_storage_key" CHECK (length("storage_key") > 0);

COMMIT;

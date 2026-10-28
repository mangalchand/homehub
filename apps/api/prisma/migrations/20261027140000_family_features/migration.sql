BEGIN;

-- CreateEnum
CREATE TYPE "DailySummaryStatus" AS ENUM ('PENDING', 'CLAIMED', 'SENT', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "emergency_sessions" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "source_member_id" UUID,
    "source_device_id" UUID,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "accuracy_meters" DOUBLE PRECISION,
    "location_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "stopped_at" TIMESTAMP(3),

    CONSTRAINT "emergency_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "author_member_id" UUID,
    "author_device_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "task_id" UUID,
    "note_id" UUID,
    "uploader_member_id" UUID,
    "uploader_device_id" UUID,
    "storage_key" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "household_feature_settings" (
    "household_id" UUID NOT NULL,
    "daily_summary_enabled" BOOLEAN NOT NULL DEFAULT true,
    "daily_summary_time" TEXT NOT NULL DEFAULT '20:30',
    "whatsapp_call_url" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "household_feature_settings_pkey" PRIMARY KEY ("household_id")
);

-- CreateTable
CREATE TABLE "daily_summary_runs" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "local_date" DATE NOT NULL,
    "status" "DailySummaryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimed_at" TIMESTAMP(3),
    "lease_token" UUID,
    "lease_expires_at" TIMESTAMP(3),
    "next_attempt_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "daily_summary_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "emergency_sessions_household_id_stopped_at_expires_at_idx" ON "emergency_sessions"("household_id", "stopped_at", "expires_at");

-- CreateIndex
CREATE INDEX "emergency_sessions_household_id_source_member_id_created_at_idx" ON "emergency_sessions"("household_id", "source_member_id", "created_at");

-- CreateIndex
CREATE INDEX "emergency_sessions_household_id_source_device_id_created_at_idx" ON "emergency_sessions"("household_id", "source_device_id", "created_at");

-- CreateIndex
CREATE INDEX "emergency_sessions_expires_at_idx" ON "emergency_sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "emergency_sessions_household_id_id_key" ON "emergency_sessions"("household_id", "id");

-- CreateIndex
CREATE INDEX "notes_household_id_updated_at_idx" ON "notes"("household_id", "updated_at");

-- CreateIndex
CREATE INDEX "notes_household_id_author_member_id_idx" ON "notes"("household_id", "author_member_id");

-- CreateIndex
CREATE INDEX "notes_household_id_author_device_id_idx" ON "notes"("household_id", "author_device_id");

-- CreateIndex
CREATE UNIQUE INDEX "notes_household_id_id_key" ON "notes"("household_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_household_id_task_id_created_at_idx" ON "attachments"("household_id", "task_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_household_id_note_id_created_at_idx" ON "attachments"("household_id", "note_id", "created_at");

-- CreateIndex
CREATE INDEX "attachments_household_id_uploader_member_id_idx" ON "attachments"("household_id", "uploader_member_id");

-- CreateIndex
CREATE INDEX "attachments_household_id_uploader_device_id_idx" ON "attachments"("household_id", "uploader_device_id");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_household_id_id_key" ON "attachments"("household_id", "id");

-- CreateIndex
CREATE INDEX "daily_summary_runs_status_next_attempt_at_idx" ON "daily_summary_runs"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "daily_summary_runs_status_lease_expires_at_idx" ON "daily_summary_runs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "daily_summary_runs_household_id_local_date_key" ON "daily_summary_runs"("household_id", "local_date");

-- CreateIndex
CREATE UNIQUE INDEX "household_members_household_id_id_key" ON "household_members"("household_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "devices_household_id_id_key" ON "devices"("household_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_household_id_id_key" ON "tasks"("household_id", "id");

-- AddForeignKey
ALTER TABLE "emergency_sessions" ADD CONSTRAINT "emergency_sessions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emergency_sessions" ADD CONSTRAINT "emergency_sessions_household_id_source_member_id_fkey" FOREIGN KEY ("household_id", "source_member_id") REFERENCES "household_members"("household_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "emergency_sessions" ADD CONSTRAINT "emergency_sessions_household_id_source_device_id_fkey" FOREIGN KEY ("household_id", "source_device_id") REFERENCES "devices"("household_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_household_id_author_member_id_fkey" FOREIGN KEY ("household_id", "author_member_id") REFERENCES "household_members"("household_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_household_id_author_device_id_fkey" FOREIGN KEY ("household_id", "author_device_id") REFERENCES "devices"("household_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_household_id_task_id_fkey" FOREIGN KEY ("household_id", "task_id") REFERENCES "tasks"("household_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_household_id_note_id_fkey" FOREIGN KEY ("household_id", "note_id") REFERENCES "notes"("household_id", "id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_household_id_uploader_member_id_fkey" FOREIGN KEY ("household_id", "uploader_member_id") REFERENCES "household_members"("household_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_household_id_uploader_device_id_fkey" FOREIGN KEY ("household_id", "uploader_device_id") REFERENCES "devices"("household_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "household_feature_settings" ADD CONSTRAINT "household_feature_settings_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_summary_runs" ADD CONSTRAINT "daily_summary_runs_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express these CHECK constraints. Keep them when regenerating migrations.
ALTER TABLE "emergency_sessions"
  ADD CONSTRAINT "emergency_sessions_source_xor" CHECK (num_nonnulls("source_member_id", "source_device_id") = 1),
  ADD CONSTRAINT "emergency_sessions_location_complete" CHECK (
    ("latitude" IS NULL AND "longitude" IS NULL AND "accuracy_meters" IS NULL AND "location_at" IS NULL)
    OR ("latitude" IS NOT NULL AND "longitude" IS NOT NULL AND "location_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "emergency_sessions_location_range" CHECK (
    "latitude" BETWEEN -90 AND 90 AND "longitude" BETWEEN -180 AND 180
    AND ("accuracy_meters" IS NULL OR ("accuracy_meters" >= 0 AND "accuracy_meters" < 'Infinity'::float8))
  ),
  ADD CONSTRAINT "emergency_sessions_times" CHECK (
    "expires_at" > "created_at" AND ("stopped_at" IS NULL OR "stopped_at" >= "created_at")
  );

ALTER TABLE "notes"
  ADD CONSTRAINT "notes_author_xor" CHECK (num_nonnulls("author_member_id", "author_device_id") = 1),
  ADD CONSTRAINT "notes_text_limits" CHECK (length(trim("title")) BETWEEN 1 AND 200 AND length("body") <= 10000);

ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_parent_xor" CHECK (num_nonnulls("task_id", "note_id") = 1),
  ADD CONSTRAINT "attachments_uploader_xor" CHECK (num_nonnulls("uploader_member_id", "uploader_device_id") = 1),
  ADD CONSTRAINT "attachments_image_metadata" CHECK (
    "mime_type" IN ('image/jpeg', 'image/png', 'image/webp')
    AND "size_bytes" BETWEEN 1 AND 10485760
    AND length("storage_key") > 0
    AND (("width" IS NULL AND "height" IS NULL) OR ("width" > 0 AND "height" > 0 AND "width" IS NOT NULL AND "height" IS NOT NULL))
  );

ALTER TABLE "household_feature_settings"
  ADD CONSTRAINT "household_feature_settings_time" CHECK ("daily_summary_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "household_feature_settings_call_url" CHECK (
    "whatsapp_call_url" IS NULL OR (
      length("whatsapp_call_url") <= 500
      AND "whatsapp_call_url" ~ '^https://call[.]whatsapp[.]com/(voice|video)/[A-Za-z0-9_-]+$'
    )
  );

ALTER TABLE "daily_summary_runs"
  ADD CONSTRAINT "daily_summary_runs_attempts" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "daily_summary_runs_lease" CHECK (
    ("status" = 'CLAIMED' AND "lease_token" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "claimed_at" IS NOT NULL AND "lease_expires_at" > "claimed_at")
    OR ("status" <> 'CLAIMED' AND "lease_token" IS NULL AND "lease_expires_at" IS NULL)
  ),
  ADD CONSTRAINT "daily_summary_runs_payload_object" CHECK ("payload" IS NULL OR jsonb_typeof("payload") = 'object');

-- Preserve existing household JSON and provide the feature defaults for existing homes.
INSERT INTO "household_feature_settings" ("household_id", "updated_at")
SELECT "id", CURRENT_TIMESTAMP FROM "households";

COMMIT;

ALTER TABLE "announcements"
  ADD COLUMN "month_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "daily_times" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "last_notified_slot" TEXT;

UPDATE "announcements"
SET "last_notified_slot" = to_char("last_notified_local_date", 'YYYY-MM-DD') || 'T' || "daily_time"
WHERE "last_notified_local_date" IS NOT NULL AND "daily_time" IS NOT NULL;

ALTER TABLE "notes"
  ADD COLUMN "repeat_daily" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "repeat_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "month_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "daily_times" TEXT[] DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "last_notified_slot" TEXT;

CREATE INDEX "notes_repeat_daily_idx" ON "notes"("repeat_daily");

ALTER TABLE "tasks"
  ADD COLUMN "times_per_day" INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT "tasks_times_per_day_check" CHECK ("times_per_day" BETWEEN 1 AND 6);

ALTER TABLE "household_feature_settings"
  ADD COLUMN "call_groups" JSONB NOT NULL DEFAULT '[]';

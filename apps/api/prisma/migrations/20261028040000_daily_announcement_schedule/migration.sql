ALTER TABLE "announcements"
  ADD COLUMN "repeat_daily" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "daily_time" TEXT,
  ADD COLUMN "last_notified_local_date" DATE;

ALTER TABLE "announcements"
  ADD CONSTRAINT "announcements_daily_time_format_check"
  CHECK ("daily_time" IS NULL OR "daily_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD CONSTRAINT "announcements_daily_schedule_check"
  CHECK (NOT "repeat_daily" OR "daily_time" IS NOT NULL);

CREATE INDEX "announcements_repeat_daily_daily_time_idx" ON "announcements"("repeat_daily", "daily_time");

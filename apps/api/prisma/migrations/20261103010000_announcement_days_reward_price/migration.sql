-- AlterTable
ALTER TABLE "announcements" ADD COLUMN "repeat_days" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "rewards" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR',
ADD COLUMN "link_url" TEXT,
ADD COLUMN "price_cents" INTEGER;

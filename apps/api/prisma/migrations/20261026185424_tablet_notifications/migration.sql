-- AlterTable
ALTER TABLE "notifications" ALTER COLUMN "member_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "push_subscriptions" ADD COLUMN     "device_id" UUID,
ALTER COLUMN "member_id" DROP NOT NULL;

-- CreateTable
CREATE TABLE "device_notification_reads" (
    "device_id" UUID NOT NULL,
    "notification_id" UUID NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_notification_reads_pkey" PRIMARY KEY ("device_id","notification_id")
);

-- CreateIndex
CREATE INDEX "notifications_household_id_created_at_idx" ON "notifications"("household_id", "created_at");

-- CreateIndex
CREATE INDEX "push_subscriptions_device_id_idx" ON "push_subscriptions"("device_id");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_notification_reads" ADD CONSTRAINT "device_notification_reads_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_notification_reads" ADD CONSTRAINT "device_notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

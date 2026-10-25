-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" UUID NOT NULL,
    "household_id" UUID NOT NULL,
    "member_id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'WEB',
    "endpoint" TEXT NOT NULL,
    "keys" JSONB NOT NULL DEFAULT '{}',
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_member_id_idx" ON "push_subscriptions"("member_id");

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_household_id_fkey" FOREIGN KEY ("household_id") REFERENCES "households"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "household_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;

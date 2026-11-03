-- DropIndex
DROP INDEX "addon_subscriptions_stripeSubscriptionId_key";

-- AlterTable
ALTER TABLE "addon_subscriptions" ADD COLUMN     "stripeSubscriptionItemId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "addon_subscriptions_stripeSubscriptionItemId_key" ON "addon_subscriptions"("stripeSubscriptionItemId");

-- CreateIndex
CREATE INDEX "addon_subscriptions_stripeSubscriptionId_idx" ON "addon_subscriptions"("stripeSubscriptionId");


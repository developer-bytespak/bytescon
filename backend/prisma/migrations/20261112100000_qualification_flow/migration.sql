-- Qualification flow: one scorecard per client (consulting firms) or own
-- company (contractors), suggested scores per criterion, and no-bid reasons.

-- DropIndex
DROP INDEX "scorecards_bidPursuitId_key";

-- AlterTable
ALTER TABLE "scorecard_criteria" ADD COLUMN     "suggestedScore" INTEGER,
ADD COLUMN     "suggestionNote" TEXT;

-- AlterTable
ALTER TABLE "scorecards" ADD COLUMN     "clientCompanyId" TEXT,
ADD COLUMN     "noBidNote" TEXT,
ADD COLUMN     "noBidReason" TEXT,
ADD COLUMN     "quickDecision" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "scorecards_clientCompanyId_idx" ON "scorecards"("clientCompanyId");

-- CreateIndex
CREATE UNIQUE INDEX "scorecards_bidPursuitId_clientCompanyId_key" ON "scorecards"("bidPursuitId", "clientCompanyId");

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: a contractor qualifies only for its own company, so its existing
-- scorecards belong to that company. A consulting firm's existing scorecards
-- stay firm-wide (no client); new ones are made per client.
UPDATE "scorecards" s
SET "clientCompanyId" = cc."id"
FROM "consulting_firms" f, "client_companies" cc
WHERE s."consultingFirmId" = f."id"
  AND f."accountType" = 'CONTRACTOR'
  AND cc."consultingFirmId" = f."id"
  AND cc."isSelf" = true
  AND s."clientCompanyId" IS NULL;


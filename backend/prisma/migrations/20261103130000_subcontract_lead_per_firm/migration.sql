-- DropIndex
DROP INDEX "subcontract_opportunities_externalId_key";

-- CreateIndex
CREATE UNIQUE INDEX "subcontract_opportunities_consultingFirmId_externalId_key" ON "subcontract_opportunities"("consultingFirmId", "externalId");


-- Grants pipeline (Phase 2): application tracking for GRANTS_GOV opportunities.

-- CreateEnum
CREATE TYPE "GrantApplicationStatus" AS ENUM ('RESEARCHING', 'ELIGIBILITY_CONFIRMED', 'PREPARING', 'INTERNAL_REVIEW', 'READY_TO_SUBMIT', 'SUBMITTED', 'AWARDED', 'NOT_AWARDED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "grant_applications" (
    "id" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "clientCompanyId" TEXT,
    "status" "GrantApplicationStatus" NOT NULL DEFAULT 'RESEARCHING',
    "eligibilityNotes" TEXT,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "submittedAt" TIMESTAMP(3),
    "awardAmount" DECIMAL(18,2),
    "outcomeNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grant_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grant_applications_consultingFirmId_status_idx" ON "grant_applications"("consultingFirmId", "status");

-- CreateIndex
CREATE INDEX "grant_applications_opportunityId_idx" ON "grant_applications"("opportunityId");

-- AddForeignKey
ALTER TABLE "grant_applications" ADD CONSTRAINT "grant_applications_consultingFirmId_fkey" FOREIGN KEY ("consultingFirmId") REFERENCES "consulting_firms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_applications" ADD CONSTRAINT "grant_applications_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "opportunities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grant_applications" ADD CONSTRAINT "grant_applications_clientCompanyId_fkey" FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

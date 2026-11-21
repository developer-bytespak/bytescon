-- Each teaming deal records which company is bidding with the partner: a
-- consulting firm's client, or a contractor's own company.
ALTER TABLE "teaming_arrangements" ADD COLUMN "clientCompanyId" TEXT;

ALTER TABLE "teaming_arrangements" ADD CONSTRAINT "teaming_arrangements_clientCompanyId_fkey"
  FOREIGN KEY ("clientCompanyId") REFERENCES "client_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Two clients of one consulting firm may team with the same partner on the same bid.
DROP INDEX "teaming_arrangements_consultingFirmId_opportunityId_partner_key";
CREATE UNIQUE INDEX "teaming_arrangements_firm_opp_client_partner_role_key"
  ON "teaming_arrangements"("consultingFirmId", "opportunityId", "clientCompanyId", "partnerId", "role");
CREATE INDEX "teaming_arrangements_clientCompanyId_idx" ON "teaming_arrangements"("clientCompanyId");

-- Fill in the bidder on existing deals where it is certain:
-- 1. a contractor bids as its own company;
UPDATE "teaming_arrangements" t SET "clientCompanyId" = c."id"
FROM "consulting_firms" f, "client_companies" c
WHERE t."consultingFirmId" = f."id" AND f."accountType" = 'CONTRACTOR'
  AND c."consultingFirmId" = f."id" AND c."isSelf" = true AND t."clientCompanyId" IS NULL;

-- 2. the one client that has a bid decision on that opportunity;
UPDATE "teaming_arrangements" t SET "clientCompanyId" = d."clientCompanyId"
FROM (
  SELECT b."opportunityId", c."consultingFirmId", MIN(b."clientCompanyId") AS "clientCompanyId"
  FROM "bid_decisions" b JOIN "client_companies" c ON c."id" = b."clientCompanyId"
  GROUP BY b."opportunityId", c."consultingFirmId"
  HAVING COUNT(DISTINCT b."clientCompanyId") = 1
) d
WHERE t."clientCompanyId" IS NULL AND t."opportunityId" = d."opportunityId" AND t."consultingFirmId" = d."consultingFirmId";

-- 3. a consulting firm with exactly one active client.
UPDATE "teaming_arrangements" t SET "clientCompanyId" = one."clientCompanyId"
FROM (
  SELECT "consultingFirmId", MIN("id") AS "clientCompanyId"
  FROM "client_companies" WHERE "isActive" = true AND "isSelf" = false
  GROUP BY "consultingFirmId" HAVING COUNT(*) = 1
) one
WHERE t."clientCompanyId" IS NULL AND t."consultingFirmId" = one."consultingFirmId";

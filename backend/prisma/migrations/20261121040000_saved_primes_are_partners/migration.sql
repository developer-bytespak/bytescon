-- A prime saved in Agency View is the same company as a partner on Subs &
-- Primes. Link each saved prime to a partner, matched by UEI within the firm.
ALTER TABLE "teaming_relationships" ADD COLUMN "partnerId" TEXT;
ALTER TABLE "teaming_relationships" ADD CONSTRAINT "teaming_relationships_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "partners"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "teaming_relationships_partnerId_idx" ON "teaming_relationships"("partnerId");

-- A saved prime with no partner yet becomes one, marked as a prime you work under.
INSERT INTO "partners" ("id", "consultingFirmId", "name", "uei", "partnerType", "notes", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, t."consultingFirmId", COALESCE(MAX(t."primeName"), t."primeUei"), t."primeUei", 'PRIME',
       'Added from a prime saved in Agency View.', NOW(), NOW()
FROM "teaming_relationships" t
WHERE NOT EXISTS (SELECT 1 FROM "partners" p WHERE p."consultingFirmId" = t."consultingFirmId" AND p."uei" = t."primeUei")
GROUP BY t."consultingFirmId", t."primeUei";

-- A partner recorded only as a sub that is also a prime you work under is either.
UPDATE "partners" p SET "partnerType" = 'BOTH'
WHERE p."partnerType" = 'SUB' AND EXISTS (
  SELECT 1 FROM "teaming_relationships" t WHERE t."consultingFirmId" = p."consultingFirmId" AND t."primeUei" = p."uei");

UPDATE "teaming_relationships" t SET "partnerId" = p."id"
FROM "partners" p
WHERE p."consultingFirmId" = t."consultingFirmId" AND p."uei" = t."primeUei" AND t."partnerId" IS NULL;

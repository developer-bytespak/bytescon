-- AlterTable
ALTER TABLE "client_companies" ADD COLUMN     "annualRevenue" DECIMAL(14,2),
ADD COLUMN     "setAsideStatusConfirmedAt" TIMESTAMP(3);

-- Backfill: demo and operator accounts were created with sample clients that
-- have NAICS, state, UEI and a past-performance project but no SAM status,
-- capability keywords or set-aside confirmation. Fill those so the demo keeps
-- working once incomplete profiles are blocked. Real accounts are untouched:
-- their users complete their own profiles.
UPDATE "client_companies" c
SET
  "samRegStatus" = COALESCE(c."samRegStatus", 'Active'),
  "setAsideStatusConfirmedAt" = COALESCE(c."setAsideStatusConfirmedAt", NOW()),
  "capabilityKeywords" = CASE
    WHEN cardinality(c."capabilityKeywords") > 0 THEN c."capabilityKeywords"
    ELSE ARRAY[initcap(replace(lower(COALESCE(f."demoBusinessType", 'professional services')), '_', ' '))]
  END
FROM "consulting_firms" f
WHERE c."consultingFirmId" = f."id"
  AND (f."demoExpiresAt" IS NOT NULL OR f."contactEmail" = 'demo-operators@demo.invalid');

-- A contractor's own-company record mirrors its registration profile; where
-- one exists, the set-aside status has been stated there.
UPDATE "client_companies" c
SET "setAsideStatusConfirmedAt" = COALESCE(c."setAsideStatusConfirmedAt", NOW())
FROM "registration_profiles" r
WHERE c."isSelf" = true AND r."consultingFirmId" = c."consultingFirmId";

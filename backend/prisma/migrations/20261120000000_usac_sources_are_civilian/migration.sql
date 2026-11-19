-- USAC E-Rate and Rural Health Care are civilian programs (open to any vendor,
-- no SAM.gov registration), so they belong on Civilian Programs, not Commercial.
UPDATE "opportunity_source_configs"
SET "category" = 'CIVILIAN'
WHERE "adapterKey" IN ('usac_erate', 'usac_rural_health') AND "category" <> 'CIVILIAN';

UPDATE "opportunities" o
SET "source" = 'CIVILIAN'
FROM "opportunity_source_configs" c
WHERE o."sourceConfigId" = c."id"
  AND c."adapterKey" IN ('usac_erate', 'usac_rural_health')
  AND o."source" <> 'CIVILIAN';

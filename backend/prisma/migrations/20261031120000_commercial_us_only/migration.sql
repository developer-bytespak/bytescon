-- Commercial is US-only: the World Bank, UK Contracts Finder, UK Find a Tender,
-- EU TED and CanadaBuys adapters were replaced by US feeds (LA RAMP, Delaware,
-- Montgomery County MD, TxDOT, USAC E-Rate and Rural Health Care).

-- Their tenders are archived, not deleted, so any bid decision or pipeline
-- work that references them is kept; the Commercial page lists ACTIVE only.
UPDATE "opportunities"
SET "status" = 'ARCHIVED'
WHERE "source" = 'COMMERCIAL'
  AND (
    "sourceConfigId" IN (
      SELECT "id" FROM "opportunity_source_configs"
      WHERE "adapterKey" IN ('world_bank', 'uk_contracts_finder', 'uk_find_a_tender', 'ted_eu', 'canada_buys')
    )
    OR "sourceMetadata"->>'provider' IN ('worldbank.org', 'contractsfinder.service.gov.uk', 'find-tender.service.gov.uk', 'ted.europa.eu', 'canadabuys.canada.ca')
  );

-- Their source configs have no adapter any more and would fail every hourly
-- sync; sync runs cascade, opportunities keep their rows (SET NULL).
DELETE FROM "opportunity_source_configs"
WHERE "adapterKey" IN ('world_bank', 'uk_contracts_finder', 'uk_find_a_tender', 'ted_eu', 'canada_buys');

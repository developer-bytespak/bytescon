-- International tenders are back on the Commercial tab (World Bank, EU TED, UK
-- Contracts Finder, UK Find a Tender, CanadaBuys). Notices archived when they
-- were removed (20261031120000_commercial_us_only) and still open to bids are
-- made active again; the next sync refreshes them and re-links their source.
UPDATE "opportunities"
SET "status" = 'ACTIVE'
WHERE "source" = 'COMMERCIAL'
  AND "status" = 'ARCHIVED'
  -- A notice a user archived carries an archive date; the removal left it empty.
  AND "archiveDate" IS NULL
  AND "responseDeadline" > NOW()
  AND "sourceMetadata"->>'provider' IN ('worldbank.org', 'contractsfinder.service.gov.uk', 'find-tender.service.gov.uk', 'ted.europa.eu', 'canadabuys.canada.ca');

-- One-off: the sources fixed on 2026-11-09 failed repeatedly before the fix (USAC E-Rate
-- timed out every run), and 10 failures in a row stop a source being scheduled. Clear
-- the count so they run again at the next hourly check. Other sources are untouched.
UPDATE "opportunity_source_configs"
SET "consecutiveFailures" = 0, "nextRunAt" = NULL
WHERE "adapterKey" IN ('usac_erate', 'usac_rural_health', 'grants_gov', 'nyc_city_record')
  AND "consecutiveFailures" > 0;

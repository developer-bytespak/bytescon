-- One-off: LA RAMP, Delaware, Montgomery County MD and Texas DOT now count as state and
-- local, not commercial (their adapters say so for new notices). Move their saved source
-- settings and the notices they already brought in, so nothing is split across two pages.
UPDATE "opportunity_source_configs"
SET "category" = 'STATE_LOCAL'
WHERE "adapterKey" IN ('la_ramp', 'delaware_bids', 'montgomery_county_md', 'txdot_lettings')
  AND "category" = 'COMMERCIAL';

UPDATE "opportunities"
SET "source" = 'STATE_LOCAL'
WHERE "source" = 'COMMERCIAL'
  AND ("samNoticeId" LIKE 'la\_ramp:%'
    OR "samNoticeId" LIKE 'delaware\_bids:%'
    OR "samNoticeId" LIKE 'montgomery\_county\_md:%'
    OR "samNoticeId" LIKE 'txdot\_lettings:%');

# GB-107 — SAM.gov Description Enrichment

Self-contained module (GB-106 isolation pattern): fetches the full solicitation
description from the SAM.gov `noticedesc` endpoint for opportunities whose
`description` column holds only a URL pointer (99.9% of ingested rows), then
extracts FAR/DFARS clauses, evaluation factors, and submission/delivery
requirements into the existing `ComplianceMatrix` / `MatrixRequirement` tables.

## Design constraints honored

- **No existing files modified** except three additive lines in `server.ts`
  (import + mount + shutdown) and additive Prisma schema columns.
- **`isEnriched` untouched** — that flag belongs to the USAspending enrichment
  worker. This module tracks its own `descriptionEnrichmentStatus` lifecycle:
  `null → QUEUED → IN_PROGRESS → COMPLETED | FAILED | NOT_FOUND` (`QUEUED`
  restored on rate-limit so the row retries next cycle).
- **`description` is replaced with real text on success** — every downstream
  reader (opportunity matcher, decision engine, compliance gap analysis, MCP
  `get_opportunity_detail`) starts working without code changes.
- **API key** — `SAM_GOV_API_KEY` preferred; falls back to the platform's
  ingestion `SAM_API_KEY` (owner decision 2026-07-03 — shared daily quota;
  keep `ENRICHMENT_RATE_LIMIT_PER_DAY` low enough to leave ingestion
  headroom). Firm-level keys are never used. No key at all = graceful skip.
- **Rate-limit compliant** — Redis-backed daily budget (default 900/day, 10%
  under SAM's 1,000 non-federal ceiling) + 2s burst spacing + full-day halt on
  a SAM 429/403. Sibling-copy: identical notices already fetched for another
  tenant row are copied (public federal data) without an API call.
- **Append-only audit** — every fetch/copy/store/fail writes an `AuditEvent`
  (system actor) whose payload includes the SHA-256 of the stored text.

## Trigger paths

1. **MCP** `trigger_enrichment` (opportunity-mcp) sets `QUEUED` on the
   tenant-scoped row; the 60s poll job picks it up.
2. **Batch backfill** every 6h: deadline within `ENRICHMENT_PRIORITY_WINDOW_DAYS`,
   client-NAICS-matching rows first, newest-posted first; capped at
   `ENRICHMENT_BATCH_SIZE` per cycle inside the daily budget.

After a successful enrichment the opportunity is re-queued for scoring
(`score-opportunity`) so decisions reflect the real solicitation text.

## Env

| Var | Default | Meaning |
|---|---|---|
| `SAM_GOV_API_KEY` | *(falls back to `SAM_API_KEY`)* | Dedicated SAM.gov key for noticedesc |
| `ENRICHMENT_RATE_LIMIT_PER_DAY` | 900 | Daily API-call budget |
| `ENRICHMENT_RATE_LIMIT_BURST_INTERVAL_MS` | 2000 | Min gap between calls |
| `ENRICHMENT_BATCH_SIZE` | 50 | Max rows per batch cycle |
| `ENRICHMENT_PRIORITY_WINDOW_DAYS` | 90 | Deadline window for backfill priority |
| `ENRICHMENT_FETCH_LINKS` | false | Also call v2 search for POC + resourceLinks (2nd API call/opp) |

// =============================================================
// GB-107 config — read lazily so tests can set env per-case.
// Mirrors config/config.ts helper semantics without modifying it.
// =============================================================

function num(key: string, fallback: number): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

export interface Gb107Config {
  samGovApiKey: string
  noticeDescUrl: string
  searchUrl: string
  ratePerDay: number
  burstIntervalMs: number
  batchSize: number
  priorityWindowDays: number
  fetchLinks: boolean
}

export function getGb107Config(): Gb107Config {
  return {
    // Dedicated enrichment key preferred; falls back to the platform's
    // ingestion key (owner decision 2026-07-03 — one shared SAM.gov quota).
    samGovApiKey: (process.env.SAM_GOV_API_KEY || process.env.SAM_API_KEY || '').trim(),
    noticeDescUrl:
      process.env.ENRICHMENT_NOTICEDESC_URL ??
      'https://api.sam.gov/prod/opportunities/v1/noticedesc',
    searchUrl:
      process.env.ENRICHMENT_SEARCH_URL ??
      'https://api.sam.gov/prod/opportunities/v2/search',
    ratePerDay: num('ENRICHMENT_RATE_LIMIT_PER_DAY', 900),
    burstIntervalMs: num('ENRICHMENT_RATE_LIMIT_BURST_INTERVAL_MS', 2000),
    batchSize: num('ENRICHMENT_BATCH_SIZE', 50),
    priorityWindowDays: num('ENRICHMENT_PRIORITY_WINDOW_DAYS', 90),
    fetchLinks: bool('ENRICHMENT_FETCH_LINKS', false),
  }
}

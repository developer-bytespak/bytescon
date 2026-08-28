// =============================================================
// FPDS-NG ATOM feed integration.
//
// USAspending's "Number of Offers Received" is sparse, so historical bidder
// counts in enrichment were effectively estimates. FPDS-NG carries the
// authoritative per-award `numberOfOffersReceived` (and the awardee vendorName).
// The PUBLIC ATOM feed needs NO API key.
//
// Query grammar (verified live): the indexed field is PRINCIPAL_NAICS_CODE,
//   https://www.fpds.gov/ezsearch/FEEDS/ATOM?FEEDNAME=PUBLIC&q=PRINCIPAL_NAICS_CODE:"541512"
// returns <entry> awards (10/page) containing <ns:numberOfOffersReceived> and
// <ns:vendorName>. No XML parser dep in this repo, so we extract those scalar
// fields with regex — robust enough for two simple numeric/text tags.
//
// Best-effort: ANY failure (network, timeout, parse) returns null. FPDS must
// never block or fail enrichment; callers fall back to the USAspending value.
// Results are cached per-NAICS for 24h (offer rates are stable day-to-day).
// =============================================================
import axios from 'axios'
import { logger } from '../utils/logger'

const FPDS_ATOM = 'https://www.fpds.gov/ezsearch/FEEDS/ATOM'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const NEG_CACHE_TTL_MS = 60 * 60 * 1000

export interface FpdsNaicsIntel {
  sampleSize: number
  avgOffersReceived: number | null
  awardees: string[]
  source: 'fpds'
}

const cache = new Map<string, { intel: FpdsNaicsIntel | null; expires: number }>()

export async function getNaicsAwardIntel(
  naicsCode: string | null | undefined,
  opts: { pages?: number; timeoutMs?: number } = {},
): Promise<FpdsNaicsIntel | null> {
  if (!naicsCode || naicsCode.trim().length < 4) return null
  const key = naicsCode.trim()
  const now = Date.now()
  const hit = cache.get(key)
  if (hit && hit.expires > now) return hit.intel

  const pages = Math.min(Math.max(opts.pages ?? 1, 1), 10)
  const offers: number[] = []
  const vendorCounts = new Map<string, number>()

  try {
    for (let p = 0; p < pages; p++) {
      const q = `PRINCIPAL_NAICS_CODE:"${key.replace(/"/g, '')}"`
      const url = `${FPDS_ATOM}?FEEDNAME=PUBLIC&q=${encodeURIComponent(q)}&start=${p * 10}`
      const { data } = await axios.get(url, {
        timeout: opts.timeoutMs ?? 12000,
        responseType: 'text',
        headers: { Accept: 'application/atom+xml' },
      })
      const xml = typeof data === 'string' ? data : String(data)
      for (const m of xml.matchAll(/numberOfOffersReceived>\s*(\d+)\s*</gi)) {
        const n = parseInt(m[1], 10)
        if (Number.isFinite(n) && n > 0) offers.push(n)
      }
      for (const m of xml.matchAll(/vendorName>\s*([^<]+?)\s*</gi)) {
        const name = m[1].replace(/&amp;/g, '&').trim()
        if (name) vendorCounts.set(name, (vendorCounts.get(name) ?? 0) + 1)
      }
      if (!/<entry>/i.test(xml)) break // no more results
    }
  } catch (err) {
    logger.warn('FPDS ATOM fetch failed (best-effort, falling back)', {
      naicsCode: key,
      error: (err as Error).message,
    })
    cache.set(key, { intel: null, expires: now + NEG_CACHE_TTL_MS })
    return null
  }

  const intel: FpdsNaicsIntel | null =
    offers.length === 0 && vendorCounts.size === 0
      ? null
      : {
          sampleSize: Math.max(offers.length, vendorCounts.size),
          avgOffersReceived: offers.length
            ? Number((offers.reduce((s, n) => s + n, 0) / offers.length).toFixed(2))
            : null,
          awardees: [...vendorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n).slice(0, 10),
          source: 'fpds',
        }

  cache.set(key, { intel, expires: now + CACHE_TTL_MS })
  return intel
}

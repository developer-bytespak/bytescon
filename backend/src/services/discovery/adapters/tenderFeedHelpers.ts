// =============================================================
// Shared helpers for the open-tender adapters (World Bank, UK Contracts
// Finder, EU TED, NYC City Record).
// =============================================================
import { AdapterEnv } from '../sourceAdapter'

/** Default records per sync run. Raise configJson.maxRecords to backfill. */
export const DEFAULT_MAX_RECORDS = 40
const MAX_RECORDS_CEILING = 200_000

/**
 * How many records one sync run may pull from a provider. Comes from the
 * source's configJson.maxRecords so a firm can start small and later backfill
 * without a code change.
 */
export function maxRecordsFor(env: AdapterEnv, fallback = DEFAULT_MAX_RECORDS): number {
  const raw = Number(env.config.maxRecords)
  if (!Number.isFinite(raw) || raw <= 0) return fallback
  return Math.min(Math.floor(raw), MAX_RECORDS_CEILING)
}

// A sync run is bounded (MAX_PAGES_PER_RUN), so a large backfill spans many
// runs. The persisted cursor "offset:<n>" is where the next run resumes; once
// the cap is reached it resets to 0 and later runs re-read the newest notices.
const OFFSET_CURSOR = /^offset:(\d+)$/

/** Offset this page starts at: the in-run page token, else the resume cursor. */
export function startOffset(pageToken: string | null | undefined, cursor: string | null | undefined, cap: number): number {
  if (pageToken != null) return Number(pageToken) || 0
  const m = cursor ? OFFSET_CURSOR.exec(cursor) : null
  const resume = m ? Number(m[1]) : 0
  return resume < cap ? resume : 0
}

/** Cursor to persist after this page: resume point, or 0 when the backfill is done. */
export function resumeCursor(nextToken: string | null): string {
  return `offset:${nextToken ?? 0}`
}

/** Page size for this request, never overshooting the run's record cap. */
export function pageSizeWithinCap(offset: number, pageSize: number, cap: number): number {
  return Math.max(0, Math.min(pageSize, cap - offset))
}

/** Next offset token, or null when the provider or the cap is exhausted. */
export function nextOffsetToken(offset: number, received: number, requested: number, cap: number, total?: number | null): string | null {
  const consumed = offset + received
  if (received < requested || consumed >= cap) return null
  if (total != null && consumed >= total) return null
  return String(consumed)
}

/** Provider notice text is HTML; descriptions are stored as plain text. */
export function htmlToText(html: unknown): string | null {
  if (typeof html !== 'string' || !html.trim()) return null
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ndash;|&mdash;/g, '-')
    .replace(/[ \t]+/g, ' ')
    .split('\n').map((line) => line.trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

/**
 * Opportunity.estimatedValue is USD everywhere in the platform (scoring,
 * portfolio value). Foreign-currency amounts are kept in metadata and shown in
 * the description instead of being stored as if they were dollars.
 */
export function usdOnly(amount: number | null, currency: string | null | undefined): number | null {
  if (amount == null) return null
  return !currency || currency.toUpperCase() === 'USD' ? amount : null
}

export function valueLine(amount: number | null, currency: string | null | undefined): string | null {
  if (amount == null) return null
  const code = (currency || 'USD').toUpperCase()
  return `Estimated value: ${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${code}`
}

/** Joins non-empty description parts with blank lines. */
export function joinDescription(...parts: (string | null | undefined)[]): string | null {
  const text = parts.filter((p): p is string => !!p && !!p.trim()).join('\n\n')
  return text ? text.slice(0, 8000) : null
}

// =============================================================
// §8.1 — Agency name matching.
//
// SAM.gov does not store an agency the way a person types one. It stores a
// dotted path, in inverted form:
//
//   "ENERGY, DEPARTMENT OF.ENERGY, DEPARTMENT OF.EM-PORTSMOUTH/PADUCAH PROJECT OFC"
//
// A user adding a contact types "Department of Energy". Comparing those two
// strings for equality fails, so a contact at exactly the right agency never
// appeared on the opportunity — which looked like a missing feature and was
// really a string-format mismatch.
//
// This module does two things and nothing else:
//
//  1. PARSE the dotted path into department / sub-tier / office, so the UI can
//     show something a human recognises instead of the raw string.
//  2. NORMALISE a name to a comparison key, so "ENERGY, DEPARTMENT OF" and
//     "Department of Energy" resolve to the same agency.
//
// It never rewrites stored data. The raw value from SAM stays exactly as
// ingested — this is a read-time reconciliation, so re-ingestion can never
// disagree with what a user typed.
// =============================================================

export interface AgencyPath {
  /** Top-level department, in readable form. "Department of Energy". */
  department: string | null
  /** Middle tier when SAM supplies one distinct from the department. */
  subTier: string | null
  /** The buying office. "EM-PORTSMOUTH/PADUCAH PROJECT OFC". */
  office: string | null
  /** What to show a user: department, plus office when it adds information. */
  display: string
  /** Every distinct segment, readable, for matching and for chips. */
  segments: string[]
}

/**
 * Turn SAM's inverted form into the way a person says it.
 *
 * "ENERGY, DEPARTMENT OF" → "Department of Energy"
 * "DEFENSE, DEPARTMENT OF" → "Department of Defense"
 *
 * Only the LAST comma is inverted, because an office name may legitimately
 * contain commas and inverting on the first would scramble it.
 */
export function readableAgencyName(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return ''

  const comma = trimmed.lastIndexOf(', ')
  if (comma === -1) return titleCaseIfShouting(trimmed)

  const head = trimmed.slice(0, comma).trim()
  const tail = trimmed.slice(comma + 2).trim()
  // Only invert when the tail reads like a qualifier ("DEPARTMENT OF",
  // "OFFICE OF"). "SMITH, JOHN" style is not an agency and is left alone.
  if (!/^(DEPARTMENT|OFFICE|BUREAU|AGENCY|ADMINISTRATION)\b/i.test(tail)) {
    return titleCaseIfShouting(trimmed)
  }
  return titleCaseIfShouting(`${tail} ${head}`)
}

/**
 * SAM shouts. A name that is entirely upper case is title-cased so it reads as
 * a name rather than a warning; a name the user typed themselves is left
 * exactly as they typed it.
 */
function titleCaseIfShouting(value: string): string {
  if (value !== value.toUpperCase()) return value
  // Anything with a slash, a hyphen-code or digits is likely an office symbol
  // and is more recognisable shouted than title-cased.
  if (/[/\d]/.test(value)) return value
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Of|The|And|For)\b/g, (m) => m.toLowerCase())
    .replace(/^([a-z])/, (m) => m.toUpperCase())
}

/**
 * The comparison key. Case, punctuation, spacing and comma-inversion all
 * collapse, so two spellings of one agency meet.
 */
export function agencyKey(raw: string | null | undefined): string {
  if (!raw) return ''
  return readableAgencyName(raw).toUpperCase().replace(/[^A-Z0-9]/g, '')
}

/** Split SAM's dotted path, drop repeats, and describe it. */
export function parseAgencyPath(raw: string | null | undefined): AgencyPath {
  if (!raw || raw.trim().length === 0) {
    return { department: null, subTier: null, office: null, display: '', segments: [] }
  }

  const parts = raw.split('.').map((p) => p.trim()).filter((p) => p.length > 0)
  const readable = parts.map(readableAgencyName)

  // SAM commonly repeats the department as its own sub-tier. Showing it twice
  // tells a reader nothing.
  const distinct: string[] = []
  for (const part of readable) {
    if (!distinct.some((d) => agencyKey(d) === agencyKey(part))) distinct.push(part)
  }

  const department = distinct[0] ?? null
  const office = distinct.length > 1 ? distinct[distinct.length - 1] : null
  const subTier = distinct.length > 2 ? distinct[1] : null

  return {
    department,
    subTier,
    office,
    display: office ? `${department} — ${office}` : (department ?? ''),
    segments: distinct,
  }
}

/**
 * Does a user-entered agency name belong to this opportunity's agency path?
 *
 * True when the typed name matches ANY tier: someone who tracks contacts at
 * "Department of Energy" should see them on a DOE opportunity whatever office
 * ran the solicitation, and someone who tracks the specific office should see
 * them too.
 */
export function agencyMatchesPath(typedAgencyName: string | null | undefined, rawPath: string | null | undefined): boolean {
  const key = agencyKey(typedAgencyName)
  if (key.length === 0) return false
  return parseAgencyPath(rawPath).segments.some((segment) => agencyKey(segment) === key)
}

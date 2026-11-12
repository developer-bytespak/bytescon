// =============================================================
// Is a company profile complete enough to score, analyse and write for?
//
// Every client of a consulting firm, and a contractor's own company, has a
// profile (ClientCompany). Scoring, bid decisions, AI analysis and proposal
// generation read it, so they are refused until its REQUIRED fields are
// filled (profileGate.ts). The percentage is the share of REQUIRED fields
// filled, so a complete profile is 100%. OPTIONAL fields improve results and
// are reported separately (`optional`), but never block anything.
//
// Pure: callers load the record and the past-performance count.
// =============================================================

/** Where a missing field is filled in, so the screen can link straight to it. */
export type FieldHome = 'PROFILE' | 'REGISTRATION' | 'PAST_PERFORMANCE'

/** PROFILE for a client of a consulting firm; CONTRACTOR for a contractor's own company (same rule). */
export type ProfileKind = 'PROFILE' | 'CONTRACTOR'

export interface ProfileInput {
  name: string | null
  state: string | null
  naicsCodes: string[]
  uei: string | null
  samRegStatus: string | null
  setAsideStatusConfirmedAt: Date | null
  capabilityKeywords: string[]
  pastPerformanceCount: number
  // Optional
  city: string | null
  streetAddress: string | null
  zipCode: string | null
  phone: string | null
  website: string | null
  cage: string | null
  pscCodes: string[]
  contractVehicles: string[]
  employeeCount: number | null
  annualRevenue: number | { toString(): string } | null
  securityClearances: string[]
  isoCertifications: string[]
  brandingLogoUrl: string | null
}

export interface MissingField {
  key: string
  label: string
  where: FieldHome
}

export interface ProfileCompleteness {
  complete: boolean
  /** Share of the required fields that are filled, 0–100; 100 when complete. */
  percent: number
  /** Required fields still empty, in a stable order. */
  missing: MissingField[]
  /** Optional fields: how many are filled, and the labels of those still empty. */
  optional: { filled: number; total: number; missing: string[] }
}

const filled = (v: unknown): boolean => {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

interface FieldDef { key: string; label: string; has: (p: ProfileInput) => boolean }

export const REQUIRED_FIELDS: FieldDef[] = [
  { key: 'name', label: 'Company name', has: (p) => filled(p.name) },
  { key: 'state', label: 'State (address)', has: (p) => filled(p.state) },
  { key: 'naicsCodes', label: 'NAICS codes', has: (p) => filled(p.naicsCodes) },
  { key: 'uei', label: 'UEI (SAM.gov Unique Entity ID)', has: (p) => filled(p.uei) },
  { key: 'samRegStatus', label: 'SAM.gov registration status', has: (p) => filled(p.samRegStatus) },
  { key: 'setAsideStatus', label: 'Small-business and set-aside status', has: (p) => p.setAsideStatusConfirmedAt !== null },
  { key: 'capabilityKeywords', label: 'Capability keywords', has: (p) => filled(p.capabilityKeywords) },
]

// Past performance is optional: a company with no projects yet (a new firm, or a
// client the firm has only just taken on) can still be scored and written for.
export const OPTIONAL_FIELDS: FieldDef[] = [
  { key: 'pastPerformance', label: 'Past-performance projects', has: (p) => p.pastPerformanceCount > 0 },
  { key: 'streetAddress', label: 'Street address', has: (p) => filled(p.streetAddress) },
  { key: 'city', label: 'City', has: (p) => filled(p.city) },
  { key: 'zipCode', label: 'ZIP code', has: (p) => filled(p.zipCode) },
  { key: 'phone', label: 'Phone', has: (p) => filled(p.phone) },
  { key: 'website', label: 'Website', has: (p) => filled(p.website) },
  { key: 'cage', label: 'CAGE code', has: (p) => filled(p.cage) },
  { key: 'pscCodes', label: 'PSC codes', has: (p) => filled(p.pscCodes) },
  { key: 'contractVehicles', label: 'Contract vehicles', has: (p) => filled(p.contractVehicles) },
  { key: 'employeeCount', label: 'Employee count', has: (p) => filled(p.employeeCount) },
  { key: 'annualRevenue', label: 'Average annual revenue', has: (p) => filled(p.annualRevenue) },
  { key: 'securityClearances', label: 'Security clearances', has: (p) => filled(p.securityClearances) },
  { key: 'isoCertifications', label: 'ISO certifications', has: (p) => filled(p.isoCertifications) },
  { key: 'brandingLogoUrl', label: 'Logo', has: (p) => filled(p.brandingLogoUrl) },
]

export function evaluateProfile(profile: ProfileInput, kind: ProfileKind): ProfileCompleteness {
  // Everything is filled in on the profile page (a contractor's My Company
  // saves its registration details too); projects live in the library.
  const where = (key: string): FieldHome => (key === 'pastPerformance' ? 'PAST_PERFORMANCE' : 'PROFILE')

  const missing = REQUIRED_FIELDS
    .filter((f) => !f.has(profile))
    .map((f) => ({ key: f.key, label: f.label, where: where(f.key) }))

  const optionalMissing = OPTIONAL_FIELDS.filter((f) => !f.has(profile)).map((f) => f.label)
  const requiredDone = REQUIRED_FIELDS.length - missing.length

  return {
    complete: missing.length === 0,
    percent: Math.round((requiredDone / REQUIRED_FIELDS.length) * 100),
    missing,
    optional: { filled: OPTIONAL_FIELDS.length - optionalMissing.length, total: OPTIONAL_FIELDS.length, missing: optionalMissing },
  }
}

/** The core profile an admin enters when creating a company (a firm's new client, a demo account). */
export interface NewProfileInput {
  name?: string | null
  state?: string | null
  naicsCodes?: string[]
  uei?: string | null
  samRegStatus?: string | null
  /** The small-business and set-aside questions were answered. */
  setAsideStatusConfirmed?: boolean
  capabilityKeywords?: string[]
}

/**
 * What is wrong with a profile entered at creation: each required field still
 * empty (by its label), then badly formed UEI or NAICS codes. Empty when the
 * new company starts complete. Past performance is not asked for (optional).
 */
export function newProfileProblems(p: NewProfileInput): string[] {
  const asProfile: ProfileInput = {
    name: p.name ?? null, state: p.state ?? null, naicsCodes: p.naicsCodes ?? [], uei: p.uei ?? null,
    samRegStatus: p.samRegStatus ?? null, setAsideStatusConfirmedAt: p.setAsideStatusConfirmed ? new Date() : null,
    capabilityKeywords: (p.capabilityKeywords ?? []).filter((k) => k.trim()), pastPerformanceCount: 0,
    city: null, streetAddress: null, zipCode: null, phone: null, website: null, cage: null, pscCodes: [], contractVehicles: [],
    employeeCount: null, annualRevenue: null, securityClearances: [], isoCertifications: [], brandingLogoUrl: null,
  }
  const problems = evaluateProfile(asProfile, 'PROFILE').missing.map((m) => `${m.label} is required`)
  const uei = (p.uei ?? '').trim()
  if (uei && !/^[A-Za-z0-9]{12}$/.test(uei)) problems.push('UEI must be exactly 12 letters or digits')
  const badNaics = (p.naicsCodes ?? []).filter((c) => !/^\d{2,6}$/.test(c.trim()))
  if (badNaics.length) problems.push(`NAICS codes are 2 to 6 digits — check ${badNaics.join(', ')}`)
  return problems
}

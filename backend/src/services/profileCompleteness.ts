// =============================================================
// Is a company profile complete enough to score, analyse and write for?
//
// Every client of a consulting firm, and a contractor's own company, has a
// profile (ClientCompany). Scoring, bid decisions, AI analysis and proposal
// generation read it, so they are refused until its REQUIRED fields are
// filled (profileGate.ts). OPTIONAL fields improve results and count toward
// the percentage shown to the user, but never block anything.
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
  /** Share of all fields (required and optional) that are filled, 0–100. */
  percent: number
  /** Required fields still empty, in a stable order. */
  missing: MissingField[]
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
  { key: 'pastPerformance', label: 'At least one past-performance project', has: (p) => p.pastPerformanceCount > 0 },
]

export const OPTIONAL_FIELDS: FieldDef[] = [
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

  const all = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]
  const done = all.filter((f) => f.has(profile)).length

  return { complete: missing.length === 0, percent: Math.round((done / all.length) * 100), missing }
}

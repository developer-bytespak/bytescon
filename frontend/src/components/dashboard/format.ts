// Small display helpers for the v2 pages. Pure.

/** Text as people read it: notice titles from SAM.gov can carry HTML entities ("Hawai&#699;i"). */
export function plainText(s: string | null | undefined): string {
  if (!s) return ''
  if (!/&[#a-z0-9]+;/i.test(s)) return s
  if (typeof DOMParser === 'undefined') return s
  return new DOMParser().parseFromString(s, 'text/html').documentElement.textContent ?? s
}

/** $29.2M, $847K, $950. */
export function money(n: number | null | undefined): string {
  const v = Number(n ?? 0)
  const a = Math.abs(v)
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`
  if (a >= 1e3) return `$${Math.round(v / 1e3)}K`
  return `$${Math.round(v)}`
}

export const count = (n: number) => n.toLocaleString('en-US')

/** Whole calendar days from today until a date (0 = today). */
export function daysUntil(date: string | Date, now = new Date()): number {
  const d = new Date(date)
  const a = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  const b = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((b - a) / 86_400_000)
}

export const RECOMMENDATION: Record<string, string> = {
  BID_PRIME: 'Bid as prime',
  BID_SUB: 'Bid as sub',
  TEAM: 'Team up',
  NO_BID: 'No bid',
  MONITOR: 'Watch',
}

export const STAGE: Record<string, string> = {
  IDENTIFIED: 'Identified',
  QUALIFICATION: 'Qualifying',
  CAPTURE: 'Capture',
  PROPOSAL: 'Proposal',
  SUBMITTED: 'Submitted',
}

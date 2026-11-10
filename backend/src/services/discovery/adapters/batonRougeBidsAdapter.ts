// =============================================================
// City-Parish of Baton Rouge, Louisiana bids (STATE_LOCAL).
//
// The Purchasing Division publishes every formal bid opening on its open-data
// portal (Socrata, keyless): GET {baseUrl}/resource/u9zk-8nix.json. The dataset
// also holds past bid results, so only bids whose opening date hasn't passed are
// asked for: about 10 at a time. Bid documents are on Central Auction House; the
// link is in each row's note, else the city's Purchasing page is used.
// Runs every 6 hours. Built on the shared Socrata factory.
// =============================================================
import { SourceCategory } from '@prisma/client'
import { trimOrNull, deriveDataQuality, NormalizedOpportunity } from '../sourceAdapter'
import { createSocrataTenderAdapter, socrataDay } from './socrataTenderAdapterFactory'
import { joinDescription } from './tenderFeedHelpers'

const PURCHASING_PAGE = 'https://www.brla.gov/358/Purchasing'

interface BatonRougeRow {
  unique_id?: string
  description?: string
  department_name?: string
  division_name?: string
  bid_date?: string
  bid_time?: string
  buyer_name?: string
  contact_name?: string
  phone?: string
  phone_ext?: string
  room_number?: string
  note?: string
}

/** Bids still to be opened: the ones vendors can still bid on. */
const openWhere = (now: Date) => `bid_date >= '${socrataDay(now)}'`

/** Is a Central-time calendar date in US daylight saving (second Sunday of March to first Sunday of November)? */
function centralDaylightSaving(year: number, month: number, day: number): boolean {
  const nthSunday = (m: number, n: number) => {
    const first = new Date(Date.UTC(year, m, 1)).getUTCDay()
    return 1 + ((7 - first) % 7) + (n - 1) * 7
  }
  if (month < 2 || month > 10) return false
  if (month > 2 && month < 10) return true
  return month === 2 ? day >= nthSunday(2, 2) : day < nthSunday(10, 1)
}

/** The bid opening as an instant: the date plus "11:00 AM" in Baton Rouge (Central) time. */
export function bidOpening(date?: string, time?: string): Date | null {
  // The calendar date as written, never shifted by the server's own time zone.
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(date ?? '')
  if (!parts) return null
  const y = Number(parts[1]), m = Number(parts[2]) - 1, d = Number(parts[3])
  const t = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(time ?? '')
  // Without a time, the end of the day, so a bid isn't treated as closed while it's still open.
  let hours = 23, minutes = 59
  if (t) {
    hours = (Number(t[1]) % 12) + (t[3].toUpperCase() === 'PM' ? 12 : 0)
    minutes = Number(t[2])
  }
  const offset = centralDaylightSaving(y, m, d) ? 5 : 6
  return new Date(Date.UTC(y, m, d, hours + offset, minutes))
}

const firstUrl = (...texts: Array<string | undefined>) => {
  for (const text of texts) {
    const m = /https?:\/\/[^\s)]+/.exec(text ?? '')
    if (m) return m[0].replace(/[.,;]$/, '')
  }
  return null
}

function normalizeRow(r: BatonRougeRow): NormalizedOpportunity | null {
  const externalId = trimOrNull(r.unique_id, 120)
  const lines = (r.description ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  const title = trimOrNull(lines[0], 500)
  if (!externalId || !title) return null

  const deadline = bidOpening(r.bid_date, r.bid_time)
  const department = trimOrNull(r.department_name, 200)
  const link = firstUrl(r.note, r.description)
  const contact = trimOrNull(r.buyer_name ?? r.contact_name, 120)
  const phone = trimOrNull(r.phone, 40)
  const phoneLine = phone ? `${phone}${r.phone_ext ? ` ext. ${r.phone_ext}` : ''}` : null
  return {
    kind: 'OPPORTUNITY',
    externalId,
    title,
    agency: department ? `City of Baton Rouge: ${department}` : 'City of Baton Rouge',
    office: trimOrNull(r.division_name, 200),
    description: joinDescription(
      [
        lines.slice(1).join('\n') || null,
        r.note ? r.note.trim() : null,
        r.bid_time ? `Bid opening: ${r.bid_time} (Central time)${r.room_number ? `, room ${r.room_number}` : ''}` : null,
        contact ? `Buyer: ${contact}${phoneLine ? `, ${phoneLine}` : ''}` : null,
      ].filter(Boolean).join('\n\n'),
    ),
    naicsCode: null,
    psc: null,
    setAsideType: 'NONE',
    noticeType: 'Solicitation',
    solicitationNumber: externalId,
    postedDate: null,
    responseDeadline: deadline,
    placeOfPerformance: 'Baton Rouge, LA',
    estimatedValue: null,
    sourceUrl: link ?? PURCHASING_PAGE,
    sourceUpdatedAt: null,
    sourceMetadata: {
      provider: 'data.brla.gov',
      jurisdiction: 'LA',
      contact: { name: contact, phone: phoneLine },
    },
    dataQuality: deriveDataQuality([Boolean(deadline), Boolean(link)]),
  }
}

export const batonRougeBidsAdapter = createSocrataTenderAdapter<BatonRougeRow>({
  key: 'baton_rouge_bids',
  displayName: 'Baton Rouge, LA bids',
  defaultBaseUrl: 'https://data.brla.gov',
  dataset: 'u9zk-8nix',
  query: (now) => ({ $where: openWhere(now), $order: 'bid_date, unique_id' }),
  pageSize: 1000,
  defaultTarget: 1_000,
  runIntervalMinutes: 360,
  category: SourceCategory.STATE_LOCAL,
  coverageNote:
    'Formal bids from the City-Parish of Baton Rouge, Louisiana Purchasing Division, from its open-data portal. Covers Baton Rouge only. Only bids not yet opened are fetched (about 10 at a time), every 6 hours. Bid documents are on Central Auction House.',
  normalize: normalizeRow,
})

export const __testing = { normalizeRow, openWhere, bidOpening }

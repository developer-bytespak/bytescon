// =============================================================
// Open-tender adapters (World Bank, UK Contracts Finder, EU TED, NYC City
// Record) — normalization against provider-shaped fixtures, record caps, and
// paging. No network: axios is stubbed per test.
// =============================================================
import { describe, it, expect, vi, afterEach } from 'vitest'
import axios from 'axios'
import { SourceCategory, SourceDataQuality, OpportunitySource } from '@prisma/client'
import { getAdapter } from '../sourceAdapter'
import { registerBuiltInAdapters } from './index'
import { categoryToOpportunitySource } from '../sourceSync'
import { __testing as wb } from './worldBankAdapter'
import { __testing as uk } from './ukContractsFinderAdapter'
import { __testing as ted } from './tedEuAdapter'
import { __testing as nyc } from './nycCityRecordAdapter'
import { __testing as cb } from './canadaBuysAdapter'
import { __testing as fts } from './ukFindATenderAdapter'
import { maxRecordsFor, htmlToText, usdOnly, nextOffsetToken, startOffset, resumeCursor } from './tenderFeedHelpers'

registerBuiltInAdapters()

const env = (config: Record<string, unknown> = {}) => ({ getEnv: () => undefined, config, baseUrl: null, firmApiKey: null })
const args = (pageToken: string | null = null) => ({ pageToken, timeoutMs: 5000, now: new Date('2026-10-30T00:00:00Z'), mode: 'FULL' as const })

afterEach(() => vi.restoreAllMocks())

describe('registry', () => {
  it('registers the four tender adapters with the right categories', () => {
    expect(getAdapter('world_bank')!.category).toBe(SourceCategory.COMMERCIAL)
    expect(getAdapter('uk_contracts_finder')!.category).toBe(SourceCategory.COMMERCIAL)
    expect(getAdapter('ted_eu')!.category).toBe(SourceCategory.COMMERCIAL)
    expect(getAdapter('nyc_city_record')!.category).toBe(SourceCategory.STATE_LOCAL)
  })

  it('maps the COMMERCIAL category to the COMMERCIAL opportunity source', () => {
    expect(categoryToOpportunitySource(SourceCategory.COMMERCIAL)).toBe(OpportunitySource.COMMERCIAL)
  })

  it('needs no credential to be READY', () => {
    for (const key of ['world_bank', 'uk_contracts_finder', 'ted_eu', 'nyc_city_record']) {
      expect(getAdapter(key)!.configure(env()).state, key).toBe('READY')
    }
  })
})

describe('helpers', () => {
  it('caps records per run from configJson.maxRecords with a default of 40', () => {
    expect(maxRecordsFor(env())).toBe(40)
    expect(maxRecordsFor(env({ maxRecords: 150 }))).toBe(150)
    expect(maxRecordsFor(env({ maxRecords: -3 }))).toBe(40)
  })

  it('stops paging at the cap or a short page', () => {
    expect(nextOffsetToken(0, 50, 50, 120)).toBe('50')
    expect(nextOffsetToken(100, 20, 20, 120)).toBeNull()
    expect(nextOffsetToken(0, 12, 50, 120)).toBeNull()
  })

  it('resumes a backfill from the persisted cursor and restarts once the cap is met', () => {
    expect(startOffset(null, 'offset:2000', 100000)).toBe(2000)
    expect(startOffset('50', 'offset:2000', 100000)).toBe(50)
    expect(startOffset(null, 'offset:2000', 150)).toBe(0)
    expect(startOffset(null, '2026-10-30T00:00:00.000Z', 150)).toBe(0)
    expect(resumeCursor('2050')).toBe('offset:2050')
    expect(resumeCursor(null)).toBe('offset:0')
  })

  it('strips HTML to text and never stores foreign currency as USD', () => {
    expect(htmlToText('<p>Lot&nbsp;1 &amp; 2</p><p>Works</p>')).toBe('Lot 1 & 2\nWorks')
    expect(usdOnly(730000, 'GBP')).toBeNull()
    expect(usdOnly(500, 'USD')).toBe(500)
  })
})

describe('World Bank', () => {
  const notice = {
    id: 'OP00477669',
    notice_type: 'Invitation for Prequalification',
    noticedate: '29-Oct-2026',
    submission_deadline_date: '2026-12-11T00:00:00Z',
    project_ctry_name: 'Mongolia',
    project_id: 'P509161',
    project_name: 'Fourth Energy Sector Project',
    bid_reference_no: 'MN-MOE-ESP4-1-CW-RFP',
    bid_description: 'Construction of Mandalgobi-Arvaikheer 220kV Transmission Line',
    contact_organization: 'Ministry of Energy, Mongolia',
    notice_text: '<p>Specific Procurement Notice</p>',
  }

  it('normalizes a notice', () => {
    const r = wb.normalizeNotice(notice)!
    expect(r.externalId).toBe('OP00477669')
    expect(r.agency).toBe('Ministry of Energy, Mongolia')
    expect(r.postedDate?.toISOString()).toBe('2026-10-29T00:00:00.000Z')
    expect(r.responseDeadline?.toISOString()).toBe('2026-12-11T00:00:00.000Z')
    expect(r.placeOfPerformance).toBe('Mongolia')
    expect(r.sourceUrl).toContain('procurement-detail/OP00477669')
    expect(r.description).toContain('Specific Procurement Notice')
    expect(r.dataQuality).toBe(SourceDataQuality.OK)
  })

  it('requests at most maxRecords and stops at the cap', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: { total: '424794', procnotices: Array(30).fill(notice).map((n, i) => ({ ...n, id: `OP${i}` })) } } as never)
    const page = await getAdapter('world_bank')!.fetchPage(env({ maxRecords: 30 }), args())
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ rows: 30, os: 0, notice_type_exact: wb.BIDDABLE_NOTICE_TYPES.join('^') })
    expect(page.records).toHaveLength(30)
    expect(page.nextPageToken).toBeNull()
    expect(page.nextCursor).toBe('offset:0')
  })

  it('requests only biddable notice types unless configured otherwise', () => {
    expect(wb.noticeTypeFilter(env())).toBe('Invitation for Bids^Request for Expression of Interest^Invitation for Prequalification')
    expect(wb.noticeTypeFilter(env({ noticeTypes: ['Invitation for Bids'] }))).toBe('Invitation for Bids')
  })

  it('starts a new run where the previous run stopped', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: { total: '424794', procnotices: Array(50).fill(notice) } } as never)
    const page = await getAdapter('world_bank')!.fetchPage(env({ maxRecords: 100000 }), { ...args(), cursor: 'offset:2000' })
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ os: 2000 })
    expect(page.nextCursor).toBe('offset:2050')
  })
})

describe('UK Contracts Finder', () => {
  const release = {
    ocid: 'ocds-b5fd17-0f6c3841-68b9-4063-849d-9112d3ee3f2a',
    date: '2026-10-30T15:11:59Z',
    tender: {
      title: 'Embedded product team',
      description: 'Build a digital public service',
      status: 'active',
      datePublished: '2026-10-30T15:11:59Z',
      value: { amount: 730000, currency: 'GBP' },
      tenderPeriod: { endDate: '2026-11-30T17:00:00Z' },
      classification: { scheme: 'CPV', id: '72200000', description: 'Software programming and consultancy services' },
      procurementMethodDetails: 'Open procedure (above threshold)',
    },
    buyer: { name: 'THE EDUCATION ENDOWMENT FOUNDATION' },
    parties: [{ roles: ['buyer'], address: { locality: 'LONDON', countryName: 'England' }, contactPoint: { email: 'procurement@eefoundation.org.uk' } }],
  }

  it('normalizes an active tender and keeps GBP out of estimatedValue', () => {
    const r = uk.normalizeRelease(release)!
    expect(r.agency).toBe('THE EDUCATION ENDOWMENT FOUNDATION')
    expect(r.estimatedValue).toBeNull()
    expect(r.description).toContain('Estimated value: 730,000 GBP')
    expect(r.responseDeadline?.toISOString()).toBe('2026-11-30T17:00:00.000Z')
    expect(r.placeOfPerformance).toBe('LONDON, England')
    expect(r.sourceUrl).toBe('https://www.contractsfinder.service.gov.uk/Notice/0f6c3841-68b9-4063-849d-9112d3ee3f2a')
    expect((r.sourceMetadata as any).cpv.code).toBe('72200000')
  })

  it('skips tenders that are no longer active', () => {
    expect(uk.normalizeRelease({ ...release, tender: { ...release.tender, status: 'complete' } })).toBeNull()
  })

  it('follows links.next and carries the running count in the page token', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ data: { releases: [release, release], links: { next: 'https://cf.example/next?cursor=abc' } } } as never)
    const page = await getAdapter('uk_contracts_finder')!.fetchPage(env({ maxRecords: 10 }), args())
    expect(uk.readToken(page.nextPageToken)).toEqual({ next: 'https://cf.example/next?cursor=abc', consumed: 2 })
  })
})

describe('EU TED', () => {
  const notice = {
    'publication-number': '654321-2026',
    'notice-title': { eng: 'Hospital cleaning services', deu: 'Krankenhausreinigung' },
    'buyer-name': { eng: ['City of Munich'] },
    'buyer-country': ['DEU'],
    'publication-date': '2026-10-28+01:00',
    'deadline-receipt-tender-date-lot': ['2026-11-25+01:00'],
    'estimated-value-lot': ['1200000'],
    'estimated-value-cur-lot': ['EUR'],
    'classification-cpv': ['90911200'],
    links: { html: { ENG: 'https://ted.europa.eu/en/notice/-/detail/654321-2026' } },
  }

  it('reads multilingual and per-lot fields', () => {
    const r = ted.normalizeNotice(notice)!
    expect(r.title).toBe('Hospital cleaning services')
    expect(r.agency).toBe('City of Munich')
    expect(r.responseDeadline?.toISOString()).toBe('2026-11-25T00:00:00.000Z')
    expect(r.estimatedValue).toBeNull()
    expect(r.description).toContain('1,200,000 EUR')
    expect(r.sourceUrl).toBe('https://ted.europa.eu/en/notice/-/detail/654321-2026')
  })

  it('posts the query with 1-based page numbers', async () => {
    const spy = vi.spyOn(axios, 'post').mockResolvedValue({ data: { notices: Array(50).fill(notice), totalNoticeCount: 900 } } as never)
    const page = await getAdapter('ted_eu')!.fetchPage(env({ maxRecords: 120 }), args('50'))
    expect(spy.mock.calls[0][1]).toMatchObject({ page: 2, limit: 50, query: ted.DEFAULT_QUERY })
    expect(page.nextPageToken).toBe('100')
  })
})

describe('NYC City Record', () => {
  const row = {
    request_id: '20261023001',
    start_date: '2026-10-30T00:00:00.000',
    agency_name: 'Health + Hospitals',
    category_description: 'Construction Related Services',
    short_title: 'SBH-02201602-Power and Cooling Upgrade',
    selection_method_description: 'Competitive Sealed Bids',
    pin: 'SBH-02201602-Power-C',
    due_date: '2026-12-17T11:00:00.000',
    contact_name: 'Jannet Olivera',
    email: 'janet.olivera@nychhc.org ',
    additional_description_1: '<ol><li>Bid documents via PASSPort</li></ol>',
  }

  it('normalizes a solicitation', () => {
    const r = nyc.normalizeRow(row)!
    expect(r.agency).toBe('NYC Health + Hospitals')
    expect(r.solicitationNumber).toBe('SBH-02201602-Power-C')
    expect(r.placeOfPerformance).toBe('New York, NY')
    expect(r.description).toContain('Selection method: Competitive Sealed Bids')
    expect(r.description).toContain('Bid documents via PASSPort')
    expect(r.sourceUrl).toBe('https://a856-cityrecord.nyc.gov/RequestDetail/20261023001')
  })

  it('filters the dataset to procurement solicitations', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: [row] } as never)
    await getAdapter('nyc_city_record')!.fetchPage(env(), args())
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ $where: nyc.WHERE, $limit: 40, $offset: 0 })
  })
})

describe('CanadaBuys', () => {
  // Header and row shaped like the real open-data file (UTF-8 BOM, bilingual
  // columns, a quoted multi-line cell, "*"-prefixed list values).
  const C = cb.COL
  const header = [C.title, C.reference, C.solicitation, C.published, C.closing, C.status, C.category, C.unspscDescription, C.noticeType, C.method, C.tradeAgreements, C.entity, C.entityCity, C.entityProvince, C.contactName, C.contactEmail, C.url, C.description]
  const row = (ref: string, published: string, extra: Partial<Record<string, string>> = {}) => {
    const values: Record<string, string> = {
      [C.title]: 'Supply and Delivery of Douglas Fir and Hemlock Lumber', [C.reference]: ref, [C.solicitation]: '5P300-26-0213/A',
      [C.published]: published, [C.closing]: '2026-11-10T09:00:00', [C.status]: 'Open', [C.category]: '*GD', [C.unspscDescription]: '*Wood',
      [C.noticeType]: 'Request for Proposal', [C.method]: 'Competitive - Selective tendering', [C.tradeAgreements]: '*WTO GPA\n*CFTA',
      [C.entity]: 'Parks Canada Agency (PC)', [C.entityCity]: 'Gatineau', [C.entityProvince]: 'Quebec', [C.contactName]: 'Melani Baba',
      [C.contactEmail]: 'melani.baba@pc.gc.ca', [C.url]: '', [C.description]: 'Lumber for Smiths Falls', ...extra,
    }
    return header.map((h) => `"${(values[h] ?? '').replace(/"/g, '""')}"`).join(',')
  }
  const csv = '﻿' + header.join(',') + '\n' + row('cb-335-1', '2026-10-20') + '\n' + row('cb-335-2', '2026-10-29') + '\n'

  it('strips the BOM, parses quoted multi-line cells and orders newest first', () => {
    const rows = cb.parseFile(csv)
    expect(rows).toHaveLength(2)
    expect(rows[0][C.reference]).toBe('cb-335-2')
  })

  it('normalizes a row with readable category and a CanadaBuys link fallback', () => {
    const r = cb.normalizeRow(cb.parseFile(csv)[0])!
    expect(r.agency).toBe('Parks Canada Agency (PC)')
    expect(r.placeOfPerformance).toBe('Gatineau, Quebec, Canada')
    expect(r.responseDeadline).not.toBeNull()
    expect(r.sourceUrl).toBe('https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/cb-335-2')
    expect((r.sourceMetadata as any).category).toBe('Goods')
    expect((r.sourceMetadata as any).unspsc).toBe('Wood')
    expect(r.description).toContain('Trade agreements: WTO GPA; CFTA')
  })

  it('prefers the MERX link when the notice has one, and skips closed tenders', () => {
    const merx = 'https://www.merx.com/public/solicitations/3776296409/abstract?language=EN'
    const withMerx = cb.parseFile('﻿' + header.join(',') + '\n' + row('cb-1', '2026-10-01', { [C.url]: merx }) + '\n')[0]
    expect(cb.normalizeRow(withMerx)!.sourceUrl).toBe(merx)
    expect(cb.normalizeRow({ ...withMerx, [C.status]: 'Cancelled' })).toBeNull()
  })

  it('defaults to a 200-record target and downloads the file once per run', async () => {
    const many = '﻿' + header.join(',') + '\n' + Array.from({ length: 250 }, (_, i) => row(`cb-${i}`, '2026-10-01')).join('\n')
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: many } as never)
    const page = await getAdapter('canada_buys')!.fetchPage(env(), args())
    expect(spy).toHaveBeenCalledTimes(1)
    expect(page.records).toHaveLength(200)
    expect(page.nextPageToken).toBeNull()
    expect(page.nextCursor).toBe('offset:0')
  })
})

describe('UK Find a Tender', () => {
  const release = {
    ocid: 'ocds-h6vhtk-0794b8',
    id: '103248-2026',
    date: '2026-10-30T14:01:06Z',
    tender: { title: 'Narrow Linewidth Tunable Laser', status: 'active', tenderPeriod: { endDate: '2026-11-30T12:00:00Z' } },
    buyer: { name: 'University of Glasgow' },
    parties: [{ roles: ['buyer'], address: { countryName: 'United Kingdom' } }],
  }

  it('links each release to its FTS notice page', () => {
    const r = fts.normalizeRelease(release)!
    expect(r.agency).toBe('University of Glasgow')
    expect(r.sourceUrl).toBe('https://www.find-tender.service.gov.uk/Notice/103248-2026')
    expect((r.sourceMetadata as any).provider).toBe('find-tender.service.gov.uk')
  })

  it('defaults to a 200-record target on the FTS endpoint', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: { releases: [release], links: {} } } as never)
    await getAdapter('uk_find_a_tender')!.fetchPage(env(), args())
    expect(spy.mock.calls[0][0]).toBe('https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages')
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ stages: 'tender', limit: 50 })
    expect(getAdapter('uk_find_a_tender')!.category).toBe(SourceCategory.COMMERCIAL)
  })
})

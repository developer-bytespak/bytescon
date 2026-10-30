// =============================================================
// Open-tender adapters (NYC City Record and the US COMMERCIAL feeds: LA RAMP,
// Delaware, Montgomery County MD, TxDOT) — normalization against
// provider-shaped fixtures, record caps, and paging. No network: axios is
// stubbed per test.
// =============================================================
import { describe, it, expect, vi, afterEach } from 'vitest'
import axios from 'axios'
import { SourceCategory, SourceDataQuality, OpportunitySource } from '@prisma/client'
import { getAdapter } from '../sourceAdapter'
import { registerBuiltInAdapters } from './index'
import { categoryToOpportunitySource } from '../sourceSync'
import { __testing as nyc } from './nycCityRecordAdapter'
import { __testing as la } from './laRampAdapter'
import { __testing as de } from './delawareBidsAdapter'
import { __testing as mc } from './montgomeryCountyMdAdapter'
import { __testing as tx } from './txdotLettingsAdapter'
import { __testing as erate } from './usacErateAdapter'
import { __testing as rhc } from './usacRuralHealthAdapter'
import { maxRecordsFor, htmlToText, usdOnly, nextOffsetToken, startOffset, resumeCursor } from './tenderFeedHelpers'

registerBuiltInAdapters()

const env = (config: Record<string, unknown> = {}) => ({ getEnv: () => undefined, config, baseUrl: null, firmApiKey: null })
const args = (pageToken: string | null = null) => ({ pageToken, timeoutMs: 5000, now: new Date('2026-10-30T00:00:00Z'), mode: 'FULL' as const })

const US_COMMERCIAL = ['la_ramp', 'delaware_bids', 'montgomery_county_md', 'txdot_lettings', 'usac_erate', 'usac_rural_health']

afterEach(() => vi.restoreAllMocks())

describe('registry', () => {
  it('registers the tender adapters with the right categories', () => {
    for (const key of US_COMMERCIAL) expect(getAdapter(key)!.category, key).toBe(SourceCategory.COMMERCIAL)
    expect(getAdapter('nyc_city_record')!.category).toBe(SourceCategory.STATE_LOCAL)
  })

  it('has only US commercial sources', () => {
    for (const key of ['world_bank', 'uk_contracts_finder', 'ted_eu', 'canada_buys', 'uk_find_a_tender']) expect(getAdapter(key), key).toBeUndefined()
  })

  it('maps the COMMERCIAL category to the COMMERCIAL opportunity source', () => {
    expect(categoryToOpportunitySource(SourceCategory.COMMERCIAL)).toBe(OpportunitySource.COMMERCIAL)
  })

  it('needs no credential to be READY', () => {
    for (const key of [...US_COMMERCIAL, 'nyc_city_record']) {
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

describe('Los Angeles RAMP', () => {
  const row = {
    rampid: '232763',
    title: 'LASAN Closed Landfill Maintenance (S-070)',
    stagename: 'Amended',
    category: 'Personal Services',
    type: 'TOS - Task Order Solicitation',
    bidpost: '2026-10-30T19:00:00.000Z',
    closedate: '2026-12-12T01:00:00.000Z',
    department: 'Sanitation Bureau, Public Works',
    url: { url: 'https://www.rampla.org/s/opportunity-details?id=006Ql00000nkBvVIAU' },
  }

  it('normalizes an open bid', () => {
    const r = la.normalizeRow(row)!
    expect(r.externalId).toBe('232763')
    expect(r.agency).toBe('City of Los Angeles — Sanitation Bureau, Public Works')
    expect(r.noticeType).toBe('TOS - Task Order Solicitation')
    expect(r.responseDeadline?.toISOString()).toBe('2026-12-12T01:00:00.000Z')
    expect(r.placeOfPerformance).toBe('Los Angeles, CA')
    expect(r.sourceUrl).toBe('https://www.rampla.org/s/opportunity-details?id=006Ql00000nkBvVIAU')
    expect(r.description).toContain('amended')
    expect((r.sourceMetadata as any).provider).toBe('rampla.org')
    expect(r.dataQuality).toBe(SourceDataQuality.OK)
  })

  it('treats RAMP\'s literal "None" type as a plain solicitation', () => {
    expect(la.noticeType('None')).toBe('Solicitation')
  })

  it('pages the LA Open Data dataset with a 300-record default target', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: Array(50).fill(row) } as never)
    const page = await getAdapter('la_ramp')!.fetchPage(env(), args())
    expect(spy.mock.calls[0][0]).toBe('https://data.lacity.org/resource/hf3r-utnq.json')
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ $limit: 50, $offset: 0 })
    expect(page.nextPageToken).toBe('50')
    expect(page.nextCursor).toBe('offset:50')
  })

  it('reports a 429 as rate limited', async () => {
    vi.spyOn(axios, 'get').mockRejectedValue({ response: { status: 429 } })
    const page = await getAdapter('la_ramp')!.fetchPage(env(), args())
    expect(page.rateLimited).toBe(true)
  })
})

describe('Delaware Bids & Contracts', () => {
  const row = {
    contractnumber: 'ARNG2318-BIDENMICROGRID',
    contracttitle: 'Biden Microgrid',
    opendate: '2026-09-22T00:00:00.000Z',
    deadlinedate: '2026-11-10T00:00:00.000Z',
    agencycode: 'ARNG',
    unspsc: '2611;3912;4323;7215',
    bidurl: { url: 'https://mmp.delaware.gov/Bids/Details/9327' },
  }

  it('normalizes an open bid', () => {
    const r = de.normalizeRow(row)!
    expect(r.agency).toBe('State of Delaware (ARNG)')
    expect(r.placeOfPerformance).toBe('Delaware')
    expect(r.sourceUrl).toBe('https://mmp.delaware.gov/Bids/Details/9327')
    expect(r.description).toBe('UNSPSC commodity codes: 2611, 3912, 4323, 7215')
    expect((r.sourceMetadata as any).unspsc).toBe('2611;3912;4323;7215')
  })

  it('skips rows without a contract number', () => {
    expect(de.normalizeRow({ ...row, contractnumber: ' ' })).toBeNull()
  })
})

describe('Montgomery County, MD', () => {
  const row = {
    status: 'Active',
    type: 'RFP',
    number: '1200454',
    description: 'Wheaton Arts and Cultural Center (WACC) Operator',
    issuancedate: '2026-10-09T00:00:00.000Z',
    closingdate: '2026-12-15T00:00:00.000Z',
    construction: 'N',
    lsbrpindicator: 'Y',
    buyer: 'Haugen, Erik',
    department: 'Department of General Services',
  }

  it('normalizes an active solicitation', () => {
    const r = mc.normalizeRow(row)!
    expect(r.agency).toBe('Montgomery County, MD — Department of General Services')
    expect(r.noticeType).toBe('RFP')
    expect(r.description).toContain('Local Small Business Reserve Program')
    expect(r.description).toContain('Buyer: Haugen, Erik')
    expect(r.sourceUrl).toBe(mc.SOLICITATIONS_PAGE)
  })

  it('requests only active solicitations', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: [row] } as never)
    const page = await getAdapter('montgomery_county_md')!.fetchPage(env(), args())
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ $where: mc.WHERE })
    expect(page.records).toHaveLength(1)
    expect(page.nextPageToken).toBeNull()
  })
})

describe('TxDOT Lettings', () => {
  const row = {
    controlling_project_id_ccsj: '6482-46-001',
    project_number: 'RMC - A00214749',
    county: 'Tarrant',
    district: 'Fort Worth',
    highway: 'IH0035W',
    classification: 'Routine Maintenance Project - Sealed',
    project_type: 'Maintenance',
    let_type: 'Statewide Let',
    proposal_status: 'Unofficial',
    deadline: '2026-12-01T13:00:00.000Z',
    estimate: '27875745.0',
    working_days: '1096',
    guarantee: '100000',
    items: '29',
  }

  it('turns a grouped project row into one opportunity with a USD estimate', () => {
    const r = tx.normalizeRow(row)!
    expect(r.externalId).toBe('6482-46-001')
    expect(r.title).toBe('Routine Maintenance Project - Sealed — IH0035W, Tarrant County')
    expect(r.agency).toBe('Texas Department of Transportation')
    expect(r.office).toBe('Fort Worth District')
    expect(r.estimatedValue).toBe(27875745)
    expect(r.placeOfPerformance).toBe('Tarrant County, TX')
    expect(r.description).toContain("Engineer's estimate: 27,875,745 USD")
    expect(r.description).toContain('UNOFFICIAL')
    expect((r.sourceMetadata as any).currency).toBe('USD')
  })

  it('groups bid items by controlling project', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: [row] } as never)
    await getAdapter('txdot_lettings')!.fetchPage(env(), args())
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ $group: 'controlling_project_id_ccsj', $select: tx.QUERY.$select })
  })
})

describe('USAC E-Rate (FCC Form 470)', () => {
  const row = {
    application_number: '270001987',
    form_nickname: 'Hyder Library- FY27 -  Form 470 - Category 1 Only',
    f470_number: { url: 'https://publicdata.usac.org/EPC/Prd/Form470/270001987/form.pdf' },
    funding_year: '2027',
    allowable_contract_date: '2026-11-26T00:00:00.000Z',
    certified_datetime: '2026-10-29T20:39:00.000Z',
    billed_entity_name: 'Hyder Public Library',
    applicant_type: 'Library',
    billed_entity_city: 'Hyder',
    billed_entity_state: 'AK',
    contact_name: 'Carol Denton',
    contact_email: 'hyderlibrary@gmail.com',
    category_one_description: 'Seeking bids for Internet Access from 50 Mbps to 5 Gbps.',
  }

  it('normalizes a certified Form 470 with the allowable contract date as deadline', () => {
    const r = erate.normalizeRow(row)!
    expect(r.externalId).toBe('270001987')
    expect(r.agency).toBe('Hyder Public Library')
    expect(r.responseDeadline?.toISOString()).toBe('2026-11-26T00:00:00.000Z')
    expect(r.placeOfPerformance).toBe('Hyder, AK')
    expect(r.description).toContain('Category 1 (internet & data transmission)')
    expect(r.description).toContain('Seeking bids for Internet Access')
    expect((r.sourceMetadata as any).contact.email).toBe('hyderlibrary@gmail.com')
  })

  it('backfills certified forms in 1,000-row pages toward a 150k default target', async () => {
    const spy = vi.spyOn(axios, 'get').mockResolvedValue({ data: Array(1000).fill(row) } as never)
    const page = await getAdapter('usac_erate')!.fetchPage(env(), { ...args(), cursor: 'offset:42000' })
    expect(spy.mock.calls[0][0]).toBe('https://datahub.usac.org/resource/jp7a-89nd.json')
    expect(spy.mock.calls[0][1]?.params).toMatchObject({ $where: erate.WHERE, $limit: 1000, $offset: 42000 })
    expect(page.nextCursor).toBe('offset:43000')
  })
})

describe('USAC Rural Health Care', () => {
  const row = {
    program: 'Telecom',
    application_number: 'RHC46500012345',
    funding_year: '2027',
    hcp_name: 'Columbia Memorial Hospital - Tannersville Family',
    status: 'Posted',
    site_city: 'Tannersville',
    site_state: 'NY',
    contact_first_name: 'Christa',
    contact_last_name: 'Proper',
    posting_start_date: '2026-10-01',
    posting_end_date: '2026-10-29',
    requested_contract_period: 'Up to 1',
    rfp_submitted: '1',
  }

  it('normalizes a posted request with the posting end date as deadline', () => {
    const r = rhc.normalizeRow(row)!
    expect(r.title).toBe('Broadband & telecom services for Columbia Memorial Hospital - Tannersville Family')
    expect(r.noticeType).toBe('FCC Form 465')
    expect(r.office).toBe('Telecommunications Program (Form 465)')
    expect(r.responseDeadline?.toISOString()).toBe('2026-10-29T00:00:00.000Z')
    expect(r.placeOfPerformance).toBe('Tannersville, NY')
    expect(r.description).toContain('An RFP is attached')
    expect((r.sourceMetadata as any).contact.name).toBe('Christa Proper')
  })
})

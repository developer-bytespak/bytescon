// =============================================================
// clayProvider tests
//
// Guards the Clay enrichment contract with NO network/DB:
//  - feature gate OFF unless CLAY_ENRICHMENT_ENABLED truthy
//  - isAvailable() requires BOTH the flag and CLAY_API_KEY
//  - response mapping is shape-tolerant (bare array / {contacts|data|results})
//  - GB-104 safety: 'verified' only on an explicit deliverability signal;
//    otherwise 'probable' (email present) or 'unknown' (no email / invalid)
//  - a Clay outage degrades to [] (never throws into the pipeline)
//  - emails are deduped + lowercased
// =============================================================
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
  clayProvider,
  isClayEnrichmentEnabled,
  buildClayEnrichRequest,
  mapClayResponseToContacts,
  deriveVerificationStatus,
  __setClayHttpForTest,
  type ClayHttpFn,
} from './clayProvider'

const ENABLED = process.env.CLAY_ENRICHMENT_ENABLED
const KEY = process.env.CLAY_API_KEY

function enable(key = 'clay_test_key') {
  process.env.CLAY_ENRICHMENT_ENABLED = '1'
  process.env.CLAY_API_KEY = key
}

afterEach(() => {
  process.env.CLAY_ENRICHMENT_ENABLED = ENABLED
  process.env.CLAY_API_KEY = KEY
  __setClayHttpForTest(null)
  vi.clearAllMocks()
})

describe('isClayEnrichmentEnabled', () => {
  it('is off by default / for falsey values', () => {
    delete process.env.CLAY_ENRICHMENT_ENABLED
    expect(isClayEnrichmentEnabled()).toBe(false)
    process.env.CLAY_ENRICHMENT_ENABLED = '0'
    expect(isClayEnrichmentEnabled()).toBe(false)
  })
  it('is on for truthy values', () => {
    for (const v of ['1', 'true', 'yes', 'YES']) {
      process.env.CLAY_ENRICHMENT_ENABLED = v
      expect(isClayEnrichmentEnabled()).toBe(true)
    }
  })
})

describe('clayProvider.isAvailable', () => {
  it('needs BOTH the flag and an API key', () => {
    delete process.env.CLAY_ENRICHMENT_ENABLED
    delete process.env.CLAY_API_KEY
    expect(clayProvider.isAvailable()).toBe(false)

    process.env.CLAY_ENRICHMENT_ENABLED = '1'
    expect(clayProvider.isAvailable()).toBe(false) // no key yet

    process.env.CLAY_API_KEY = 'k'
    expect(clayProvider.isAvailable()).toBe(true)

    process.env.CLAY_ENRICHMENT_ENABLED = '0'
    expect(clayProvider.isAvailable()).toBe(false) // key but flag off
  })
})

describe('buildClayEnrichRequest', () => {
  it('maps provider args to Clay company identity + procurement roles', () => {
    const body = buildClayEnrichRequest({
      uei: 'ABC123DEF456',
      legalName: 'Acme Federal LLC',
      website: 'acme.com',
    })
    expect(body.companyName).toBe('Acme Federal LLC')
    expect(body.domain).toBe('acme.com')
    expect(body.uei).toBe('ABC123DEF456')
    expect(body.roles).toContain('Procurement')
  })
  it('omits empty identity hints (undefined, not empty string)', () => {
    const body = buildClayEnrichRequest({ uei: '', legalName: null, website: null })
    expect(body.companyName).toBeUndefined()
    expect(body.domain).toBeUndefined()
    expect(body.uei).toBeUndefined()
  })
})

describe('deriveVerificationStatus — GB-104 safety', () => {
  it("'verified' ONLY on explicit deliverability signal", () => {
    expect(deriveVerificationStatus('a@b.com', 'valid')).toBe('verified')
    expect(deriveVerificationStatus('a@b.com', 'deliverable')).toBe('verified')
    expect(deriveVerificationStatus('a@b.com', 'VERIFIED')).toBe('verified')
  })
  it("email present but unconfirmed => 'probable'", () => {
    expect(deriveVerificationStatus('a@b.com', null)).toBe('probable')
    expect(deriveVerificationStatus('a@b.com', 'risky')).toBe('probable')
    expect(deriveVerificationStatus('a@b.com', undefined)).toBe('probable')
  })
  it("no email => 'unknown'", () => {
    expect(deriveVerificationStatus(null, 'valid')).toBe('unknown')
  })
  it("explicitly invalid email => 'unknown' (not trusted)", () => {
    expect(deriveVerificationStatus('a@b.com', 'invalid')).toBe('unknown')
    expect(deriveVerificationStatus('a@b.com', 'bounced')).toBe('unknown')
  })
})

describe('mapClayResponseToContacts', () => {
  it('maps a full contact and tags source=clay', () => {
    const [c] = mapClayResponseToContacts({
      contacts: [
        {
          fullName: 'Jane Buyer',
          jobTitle: 'Procurement Manager',
          email: 'Jane.Buyer@Acme.com',
          phone: '202-555-0100',
          jobFunction: 'Procurement',
          emailStatus: 'valid',
          sourceConfidence: 0.9,
        },
      ],
    })
    expect(c.name).toBe('Jane Buyer')
    expect(c.title).toBe('Procurement Manager')
    expect(c.email).toBe('jane.buyer@acme.com') // lowercased
    expect(c.phone).toBe('202-555-0100')
    expect(c.source).toBe('clay')
    expect(c.role).toBe('Procurement')
    expect(c.verificationStatus).toBe('verified')
    expect(c.confidence).toBe(0.9)
  })

  it('accepts a bare array and {data}/{results} shapes', () => {
    expect(mapClayResponseToContacts([{ fullName: 'A', email: 'a@x.com' }])).toHaveLength(1)
    expect(mapClayResponseToContacts({ data: [{ fullName: 'B', email: 'b@x.com' }] })).toHaveLength(1)
    expect(mapClayResponseToContacts({ results: [{ fullName: 'C', email: 'c@x.com' }] })).toHaveLength(1)
  })

  it('composes a name from first/last or name object', () => {
    expect(mapClayResponseToContacts([{ firstName: 'John', lastName: 'Doe', email: 'j@x.com' }])[0].name).toBe('John Doe')
    expect(mapClayResponseToContacts([{ name: { first: 'Amy', last: 'Lee' }, email: 'a@x.com' }])[0].name).toBe('Amy Lee')
  })

  it('drops rows with neither name nor email, keeps email-only rows', () => {
    const rows = mapClayResponseToContacts([
      { jobTitle: 'Nobody' }, // junk -> dropped
      { email: 'only@x.com' }, // kept
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('only@x.com')
    expect(rows[0].name).toBeNull()
  })

  it('dedupes by email (case-insensitive)', () => {
    const rows = mapClayResponseToContacts([
      { fullName: 'A', email: 'dup@x.com' },
      { fullName: 'A2', email: 'DUP@x.com' },
    ])
    expect(rows).toHaveLength(1)
  })

  it('never emits verified without an explicit deliverability signal', () => {
    const rows = mapClayResponseToContacts([
      { fullName: 'A', email: 'a@x.com' },
      { fullName: 'B', email: 'b@x.com', emailStatus: 'risky' },
      { fullName: 'C' },
    ])
    for (const r of rows) expect(r.verificationStatus).not.toBe('verified')
  })

  it('returns [] for malformed / empty input', () => {
    expect(mapClayResponseToContacts(null)).toEqual([])
    expect(mapClayResponseToContacts({})).toEqual([])
    expect(mapClayResponseToContacts('nope')).toEqual([])
    expect(mapClayResponseToContacts({ contacts: 'bad' })).toEqual([])
  })

  it('treats a non-email value as no email (never promotes junk to verified)', () => {
    const [c] = mapClayResponseToContacts([{ fullName: 'Jane', email: 'n/a', emailStatus: 'valid' }])
    expect(c.email).toBeNull()
    expect(c.verificationStatus).toBe('unknown')
  })
})

describe('clayProvider.fetchContacts', () => {
  const args = { uei: 'ABC123DEF456', legalName: 'Acme Federal LLC', website: 'acme.com' }

  it('returns [] when disabled or unkeyed, without calling HTTP', async () => {
    delete process.env.CLAY_ENRICHMENT_ENABLED
    delete process.env.CLAY_API_KEY
    const http = vi.fn()
    __setClayHttpForTest(http as unknown as ClayHttpFn)
    expect(await clayProvider.fetchContacts(args)).toEqual([])
    expect(http).not.toHaveBeenCalled()
  })

  it('calls the injected HTTP fn with the api key and maps the result', async () => {
    enable('secret_key')
    // Capture OUTSIDE the mock: an assertion thrown inside the stub would be
    // swallowed by fetchContacts' try/catch and degrade to [], masking it.
    let seenKey: string | undefined
    let seenUrl: string | undefined
    const http: ClayHttpFn = vi.fn(async (url, _body, apiKey) => {
      seenUrl = url
      seenKey = apiKey
      return { contacts: [{ fullName: 'Jane Buyer', email: 'jane@acme.com', emailStatus: 'valid' }] }
    })
    __setClayHttpForTest(http)
    const out = await clayProvider.fetchContacts(args)
    expect(http).toHaveBeenCalledOnce()
    expect(seenKey).toBe('secret_key')
    expect(seenUrl).toContain('/enrich/contacts')
    expect(out).toHaveLength(1)
    expect(out[0].email).toBe('jane@acme.com')
    expect(out[0].verificationStatus).toBe('verified')
  })

  it('degrades to [] when Clay errors (never throws into the pipeline)', async () => {
    enable()
    __setClayHttpForTest(async () => {
      throw Object.assign(new Error('boom'), { response: { status: 503 } })
    })
    await expect(clayProvider.fetchContacts(args)).resolves.toEqual([])
  })
})

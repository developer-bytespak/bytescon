// Vitest skeleton for farCatalogService.
// Designed to be safe to run without a live DB by mocking prisma.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the prisma client so the catalog cache loads from in-memory fixtures.
vi.mock('../../config/database', () => ({
  prisma: {
    farClause: {
      findMany: vi.fn().mockResolvedValue([
        {
          code: '52.219-14',
          title: 'Limitations on Subcontracting',
          summary: 'On set-aside services contracts, prime cannot subcontract more than 50%.',
          partNumber: '52',
          subpartNumber: '52.2',
          prescribedAt: '19.507(e)',
          applicableContractTypes: ['FFP', 'T_AND_M', 'IDIQ'],
          setAsideTriggers: ['SDVOSB', 'WOSB', 'EDWOSB', 'HUBZONE', 'EIGHT_A', 'SMALL_BUSINESS'],
          agencyTriggers: [],
          flowDownRequired: false,
          flowDownThreshold: null,
          prerequisiteClauseCodes: [],
          prohibitedClauseCodes: [],
          commercialItemException: false,
          isBlocking: true,
          tags: ['LIMITATIONS_ON_SUBCONTRACTING', 'SET_ASIDE'],
        },
        {
          code: '52.204-7',
          title: 'System for Award Management',
          summary: 'SAM registration required at proposal submission and through award.',
          partNumber: '52',
          subpartNumber: '52.2',
          prescribedAt: '4.1105(a)(1)',
          applicableContractTypes: ['FFP', 'T_AND_M', 'IDIQ', 'COST_REIMB', 'BPA', 'COMMERCIAL'],
          setAsideTriggers: [],
          agencyTriggers: [],
          flowDownRequired: false,
          flowDownThreshold: null,
          prerequisiteClauseCodes: [],
          prohibitedClauseCodes: [],
          commercialItemException: false,
          isBlocking: true,
          tags: ['SAM', 'REGISTRATION'],
        },
      ]),
    },
    dfarsClause: {
      findMany: vi.fn().mockResolvedValue([
        {
          code: '252.204-7012',
          title: 'Safeguarding Covered Defense Information',
          summary: 'Implements NIST 800-171 + 72hr cyber incident reporting.',
          partNumber: '252',
          prescribedAt: '204.7304(c)',
          applicableContractTypes: ['FFP', 'T_AND_M', 'IDIQ', 'COST_REIMB', 'COMMERCIAL'],
          agencyTriggers: ['DOD'],
          flowDownRequired: true,
          flowDownThreshold: null,
          prerequisiteClauseCodes: ['252.204-7008'],
          isBlocking: true,
          tags: ['CYBERSECURITY', 'CDI'],
        },
      ]),
    },
  },
}))

import {
  invalidateCache,
  lookup,
  findBySetAside,
  findByAgency,
  findApplicableForOpportunity,
  inferCmmcLevel,
  inferSection508Required,
} from './farCatalogService'

describe('farCatalogService', () => {
  beforeEach(async () => {
    await invalidateCache()
  })

  it('lookup() returns FAR clause by code', async () => {
    const c = await lookup('52.219-14')
    expect(c).not.toBeNull()
    expect(c?.code).toBe('52.219-14')
    expect(c?.source).toBe('FAR')
  })

  it('lookup() returns DFARS clause by code with explicit source', async () => {
    const c = await lookup('252.204-7012', 'DFARS')
    expect(c?.title).toContain('Covered Defense Information')
    expect(c?.flowDownRequired).toBe(true)
  })

  it('findBySetAside("SDVOSB") returns the limitations-on-subcontracting clause', async () => {
    const matches = await findBySetAside('SDVOSB')
    expect(matches.find((m) => m.code === '52.219-14')).toBeDefined()
  })

  it('findByAgency("DOD") returns DFARS clauses', async () => {
    const matches = await findByAgency('DOD')
    expect(matches.find((m) => m.code === '252.204-7012')).toBeDefined()
  })

  it('findApplicableForOpportunity composes contract-type + set-aside + agency clauses', async () => {
    const result = await findApplicableForOpportunity({
      agency: 'Department of Defense',
      naicsCode: '541512',
      setAsideType: 'SDVOSB',
      estimatedValue: 5000000,
      contractType: 'FFP',
    })
    expect(result.far.find((c) => c.code === '52.204-7')).toBeDefined()
    expect(result.dfars.find((c) => c.code === '252.204-7012')).toBeDefined()
    expect(result.blocking.length).toBeGreaterThan(0)
  })

  it('inferCmmcLevel returns 2 when DFARS 252.204-7012 applies on a DoD bid', () => {
    expect(
      inferCmmcLevel(
        { agency: 'Department of Defense', contractType: 'FFP' },
        ['252.204-7012']
      )
    ).toBe(2)
  })

  it('inferCmmcLevel returns null for civilian agencies', () => {
    expect(
      inferCmmcLevel({ agency: 'GSA', contractType: 'FFP' }, ['52.204-7'])
    ).toBeNull()
  })

  it('inferSection508Required returns true for IT/computer-systems NAICS', () => {
    expect(
      inferSection508Required({ agency: 'GSA', naicsCode: '541512' })
    ).toBe(true)
  })

  it('inferSection508Required returns false for non-IT NAICS', () => {
    expect(
      inferSection508Required({ agency: 'VA', naicsCode: '484121' })
    ).toBe(false)
  })
})

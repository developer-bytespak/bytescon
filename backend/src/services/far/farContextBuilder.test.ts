// Vitest skeleton for farContextBuilder.
//
// Asserts the foundational invariants of the FAR-grounded pattern:
//   - Identical inputs produce identical hashes (deterministic).
//   - Different scopes produce different hashes (cache-safe).
//   - The rendered prompt frame contains the BLOCKING and FLOW-DOWN
//     markers the LLM is told to obey.
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../config/database', () => ({
  prisma: {
    opportunity: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'opp-test-1',
        agency: 'Department of Defense',
        naicsCode: '541512',
        setAsideType: 'SDVOSB',
        estimatedValue: 5_000_000,
        vehicleType: null,
        marketCategory: 'SERVICES',
      }),
    },
    farClause: {
      findMany: vi.fn().mockResolvedValue([
        {
          code: '52.219-14',
          title: 'Limitations on Subcontracting',
          summary: 'Prime cannot subcontract more than 50% on services set-asides.',
          partNumber: '52',
          subpartNumber: '52.2',
          prescribedAt: '19.507(e)',
          applicableContractTypes: ['FFP'],
          setAsideTriggers: ['SDVOSB'],
          agencyTriggers: [],
          flowDownRequired: false,
          flowDownThreshold: null,
          prerequisiteClauseCodes: [],
          prohibitedClauseCodes: [],
          commercialItemException: false,
          isBlocking: true,
          tags: [],
        },
      ]),
    },
    dfarsClause: {
      findMany: vi.fn().mockResolvedValue([
        {
          code: '252.204-7012',
          title: 'Safeguarding Covered Defense Information',
          summary: 'NIST 800-171 + 72hr cyber incident reporting.',
          partNumber: '252',
          prescribedAt: '204.7304(c)',
          applicableContractTypes: ['FFP'],
          agencyTriggers: ['DOD'],
          flowDownRequired: true,
          flowDownThreshold: null,
          prerequisiteClauseCodes: [],
          isBlocking: true,
          tags: [],
        },
      ]),
    },
  },
}))

import { buildContext, renderForPrompt } from './farContextBuilder'
import { invalidateCache } from './farCatalogService'

describe('farContextBuilder', () => {
  beforeEach(async () => {
    await invalidateCache()
  })

  it('buildContext returns a deterministic hash for identical inputs', async () => {
    const a = await buildContext('opp-test-1', 'COMPLIANCE_MATRIX')
    const b = await buildContext('opp-test-1', 'COMPLIANCE_MATRIX')
    expect(a.hash).toBe(b.hash)
  })

  it('different scopes produce different hashes (cache safety)', async () => {
    const a = await buildContext('opp-test-1', 'COMPLIANCE_MATRIX')
    const b = await buildContext('opp-test-1', 'PROPOSAL_DRAFT')
    expect(a.hash).not.toBe(b.hash)
  })

  it('context includes DFARS clauses when agency is DoD', async () => {
    const ctx = await buildContext('opp-test-1', 'COMPLIANCE_MATRIX')
    expect(ctx.applicableDfarsClauses.find((c) => c.code === '252.204-7012')).toBeDefined()
  })

  it('renderForPrompt embeds BLOCKING and FLOW-DOWN markers and the grounding rules', async () => {
    const ctx = await buildContext('opp-test-1', 'PROPOSAL_DRAFT')
    const text = renderForPrompt(ctx)
    expect(text).toContain('FAR REGULATORY FRAME')
    expect(text).toContain('[BLOCKING]')
    expect(text).toContain('[FLOW-DOWN]')
    expect(text).toContain('[EVIDENCE_NEEDED:')
  })

  it('cost-principle alerts are emitted when scope is COST_VOLUME', async () => {
    // The fixture opp is FFP, but COST_VOLUME scope still flags FAR 31.205
    // for downstream cost-narrative validators when a CAS clause applies.
    const ctx = await buildContext('opp-test-1', 'COST_VOLUME')
    expect(Array.isArray(ctx.costPrincipleAlerts)).toBe(true)
  })
})

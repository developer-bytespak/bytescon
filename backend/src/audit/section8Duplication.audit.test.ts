// =============================================================
// §8 FINAL ACCEPTANCE — the duplication audit.
//
// The failure this suite exists to catch is the one that would make Section 8
// worthless as an operating system: two authoritative records for the same
// business fact. A firm that has two "actual cost" numbers, or two capture
// pipelines, does not have an ERP — it has two half-truths and an argument.
//
// So every assertion here is STATIC, over the schema and the source, and it
// fails the moment a second model or a second calculation appears. It needs no
// database, so it runs on every push and cannot be skipped by an environment.
// =============================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')
const SCHEMA = readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.includes('.test.')) out.push(full)
  }
  return out
}

const SOURCES = walk(path.join(ROOT, 'src'))
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/')

/**
 * Source with comments removed.
 *
 * These modules explain their own rules in prose — "this is NOT pipeline
 * value", "the ops webhook is a separate thing" — so a naive text search finds
 * the very words the rule forbids. Assertions here are about CODE.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const MODEL_NAMES = [...SCHEMA.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{/gm)].map((m) => m[1])

/**
 * One authoritative model per business fact.
 *
 * `matches` is every model whose name could plausibly represent the concept;
 * `authoritative` is the one that actually does. A new model matching the
 * pattern fails this test until someone states which of the two is the truth.
 */
const AUTHORITATIVE: Array<{ concept: string; pattern: RegExp; authoritative: string[]; reason?: string }> = [
  { concept: 'capture pipeline', pattern: /Pursuit$|^Pipeline/, authoritative: ['BidPursuit'] },
  { concept: 'government contact', pattern: /^GovernmentContact|^AgencyContact/, authoritative: ['GovernmentContact'] },
  { concept: 'partner company', pattern: /^Partner$|^Vendor$|^Subcontractor$/, authoritative: ['Partner'] },
  { concept: 'contract', pattern: /^Contract$/, authoritative: ['Contract'] },
  { concept: 'CLIN / task hierarchy', pattern: /^Clin$|^TaskOrder$|^SubClin$/, authoritative: ['Clin'] },
  { concept: 'timekeeping', pattern: /^TimeEntry$|^Timesheet$/, authoritative: ['TimeEntry'] },
  { concept: 'actual contract cost', pattern: /^ContractCost$|^ActualCost$/, authoritative: ['ContractCost'] },
  { concept: 'funding', pattern: /^FundingTransaction$|^ContractFunding$/, authoritative: ['FundingTransaction'] },
  { concept: 'contract budget', pattern: /^ContractBudget$|^Budget$/, authoritative: ['ContractBudget'] },
  { concept: 'resource allocation', pattern: /^ResourceAllocation$|^Assignment$/, authoritative: ['ResourceAllocation'] },
  { concept: 'purchase order', pattern: /^PurchaseOrder$/, authoritative: ['PurchaseOrder'] },
  { concept: 'subcontract flow-down', pattern: /FlowDown$/, authoritative: ['SubcontractFlowDown'] },
  { concept: 'personnel', pattern: /^Personnel$|^Employee$|^StaffMember$/, authoritative: ['Personnel'] },
  { concept: 'resume version', pattern: /Resume$/, authoritative: ['PersonnelResume'] },
  { concept: 'proposal', pattern: /^Proposal$/, authoritative: ['Proposal'] },
  { concept: 'API credential', pattern: /^ApiToken$|^ApiKey$|^PublicApiToken$/, authoritative: ['ApiToken'] },
  { concept: 'in-app notification', pattern: /^UserNotification$|^Notification$/, authoritative: ['UserNotification'] },
  { concept: 'calendar source milestone', pattern: /^OpportunityMilestone$|^CalendarEvent$/, authoritative: ['OpportunityMilestone'] },
  { concept: 'internal identity', pattern: /^User$|^InternalUser$/, authoritative: ['User'] },
  { concept: 'client portal identity', pattern: /^ClientPortalUser$/, authoritative: ['ClientPortalUser'] },
  { concept: 'partner portal identity', pattern: /^PartnerPortalUser$/, authoritative: ['PartnerPortalUser'] },
]

describe('§8 acceptance: exactly one authoritative model per business fact', () => {
  for (const { concept, pattern, authoritative } of AUTHORITATIVE) {
    it(`has one and only one model for ${concept}`, () => {
      const matched = MODEL_NAMES.filter((m) => pattern.test(m)).sort()
      expect(matched).toEqual([...authoritative].sort())
    })
  }
})

/**
 * Models that look like duplicates and are not.
 *
 * Each of these represents a genuinely different fact, and the reason is
 * recorded here so a future reader does not "consolidate" them.
 */
describe('§8 acceptance: legitimately distinct models, with their reasons', () => {
  const DISTINCT: Array<[string, string, string]> = [
    ['ContractInvoice', 'SubcontractInvoice',
      'AR versus AP. One is money the government owes the prime; the other is money the prime owes a vendor. Opposite direction, opposite ledger, opposite approval meaning.'],
    ['ContractInvoice', 'Invoice',
      'Customer receivable versus the platform billing its own subscribers. Different counterparty entirely.'],
    ['User', 'Personnel',
      'Authentication identity versus business identity. A proposed key person often has no login, and a personnel record must outlive a disabled account.'],
    ['User', 'ClientPortalUser',
      'Internal firm member versus an external client contact. Separate tokens, separate tables, separate scopes.'],
    ['ClientPortalUser', 'PartnerPortalUser',
      'A client of the firm versus a subcontractor to the firm. Different data, different grants, different default-deny rules.'],
    ['GovernmentContact', 'PartnerContact',
      'A person at a buying agency versus a person at a teaming partner. Different relationship, different privacy expectations.'],
    ['NotificationPreference', 'AgentNotificationPreference',
      'Per-client match-email preference versus per-user per-agent routing. Different subject and different owner.'],
  ]

  for (const [a, b, reason] of DISTINCT) {
    it(`keeps ${a} and ${b} apart — ${reason}`, () => {
      expect(MODEL_NAMES).toContain(a)
      expect(MODEL_NAMES).toContain(b)
      expect(a).not.toBe(b)
    })
  }
})

describe('§8 acceptance: one calculation per financial fact', () => {
  it('computes recognized expenditure in exactly one module', () => {
    const definers = SOURCES.filter((f) => /export (async )?function recognizedExpenditure/.test(code(f)))
    expect(definers.map(rel)).toEqual(['src/services/contractFinance.ts'])
  })

  it('lets no Section 8 module define its own actual-cost sum', () => {
    // A second module summing approved TimeEntry + approved ContractCost would
    // be a second answer to "what has this contract cost?".
    const offenders: string[] = []
    for (const file of SOURCES) {
      const p = rel(file)
      if (!/services\/(erp|integrations|partnerPortal|knowledge|crm|publicApi)\//.test(p)) continue
      const body = code(file)
      // A money sum over approved time entries. Reading HOURS for capacity is
      // a different question and is not an actual-cost calculation.
      if (/timeEntry[\s\S]{0,400}billingAmount/.test(body) && !/recognizedExpenditure/.test(body)) {
        offenders.push(p)
      }
    }
    expect(offenders).toEqual([])
  })

  it('routes every subcontract cost posting through the one poster', () => {
    // A subcontract invoice becomes a cost in exactly one module. An
    // integration, a portal or a webhook creating one would post cost outside
    // the prime's approval, which is the gate the whole ERP rests on.
    const creators = SOURCES.filter((f) => {
      const p = rel(f)
      if (p === 'src/services/erp/subcontractPosting.ts') return false
      if (p === 'src/routes/contractFinance.ts') return false // the human cost route
      return /contractCost\.create\(/.test(code(f))
    })
    expect(creators.map(rel)).toEqual([])
  })

  it('keeps weighted pipeline value out of the contract backlog calculation', () => {
    const summary = code(path.join(ROOT, 'src/services/erp/financialSummary.ts'))
    expect(summary).not.toMatch(/probabilityScore|expectedValue|weighted/i)
    // And says so in the response, so a reader cannot mistake one for the other.
    expect(readFileSync(path.join(ROOT, 'src/services/erp/financialSummary.ts'), 'utf8')).toMatch(/not pipeline/i)
  })
})

describe('§8 acceptance: one substrate per platform concern', () => {
  it('creates in-app notifications through notifyUser alone', () => {
    const writers = SOURCES.filter((f) => {
      const p = rel(f)
      if (p === 'src/services/notificationService.ts') return false
      return /userNotification\.create\(/.test(code(f))
    })
    expect(writers.map(rel)).toEqual([])
  })

  it('builds the ICS calendar in exactly one place', () => {
    const builders = SOURCES.filter((f) => /BEGIN:VCALENDAR/.test(code(f)))
    expect(builders.map(rel)).toEqual(['src/services/milestones/milestoneService.ts'])
  })

  it('keeps the ops alert webhook out of the tenant chat integration', () => {
    const dispatcher = code(path.join(ROOT, 'src/services/integrations/channels/dispatcher.ts'))
    expect(dispatcher).not.toContain('ALERT_WEBHOOK_URL')
    expect(dispatcher).not.toContain('alertService')
    const alerts = code(path.join(ROOT, 'src/services/alertService.ts'))
    expect(alerts).not.toContain('integrationConnection')
  })

  it('decrypts a provider credential in exactly one integration module', () => {
    const readers = SOURCES.filter((f) => {
      const p = rel(f)
      if (!p.startsWith('src/services/integrations/')) return false
      return /decryptSecret/.test(code(f))
    })
    expect(readers.map(rel)).toEqual(['src/services/integrations/connectionService.ts'])
  })

  it('mints every API credential through the one admin surface', () => {
    const minters = SOURCES.filter((f) => /apiToken\.create\(/.test(code(f)))
    expect(minters.map(rel)).toEqual(['src/routes/mcp.ts'])
  })

  it('holds the permission vocabulary in exactly one module', () => {
    const definers = SOURCES.filter((f) => /export const PERMISSIONS = \[/.test(code(f)))
    expect(definers.map(rel)).toEqual(['src/services/rbac/permissions.ts'])
  })
})

describe('§8 acceptance: the knowledge layer stores nothing of its own', () => {
  it('reads existing tables and creates none', () => {
    const search = code(path.join(ROOT, 'src/services/knowledge/knowledgeSearch.ts'))
    expect(search).not.toMatch(/\.create\(|\.update\(|\.delete\(|\.upsert\(/)
    for (const model of ['firmCapability', 'capabilityNarrative', 'pastPerformanceRecord', 'personnel', 'personnelResume', 'documentTemplate', 'standingDocument']) {
      expect(search).toContain(`prisma.${model}.findMany`)
    }
  })

  it('adds no knowledge model of its own to the schema', () => {
    for (const forbidden of ['KnowledgeAsset', 'KnowledgeIndex', 'KnowledgeDocument', 'SearchIndex']) {
      expect(MODEL_NAMES).not.toContain(forbidden)
    }
  })

  it('describes itself as a text search rather than a semantic one', () => {
    const search = readFileSync(path.join(ROOT, 'src/services/knowledge/knowledgeSearch.ts'), 'utf8')
    expect(search).toMatch(/not a semantic or AI search/i)
  })
})

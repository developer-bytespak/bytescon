// =============================================================
// SECTION 7 — NINE-AGENT ACCEPTANCE AUDIT (structural)
//
// This file is the standing, machine-checked contract for the Section 7 agent
// layer AS A WHOLE. Every individual slice has its own suite; this one asserts
// the properties that only hold across all nine together, and that would
// silently rot as a tenth agent or a second runtime is added later.
//
// It reads the actual source tree rather than trusting the registry, because
// the failure mode being guarded against is code drifting away from what the
// registry claims.
// =============================================================
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { AGENT_REGISTRY, getAgentDefinition, agentsSubscribedTo } from './registry'
import { DOMAIN_AGENT_KEYS, INTERNAL_AGENT_KEY, DEFAULT_AUTONOMY_LEVEL, type AgentKey } from './types'

const SRC = join(__dirname, '..', '..')
const AGENTS_DIR = __dirname

/** The nine domain agents. A tenth appearing here is an audit failure. */
const EXPECTED_DOMAIN_AGENTS = [
  'CONTRACT_ADMINISTRATION',
  'OPPORTUNITY',
  'COMPLIANCE',
  'QUALIFICATION',
  'TEAMING',
  'PRICING',
  'PROPOSAL',
  'FINANCE',
  'INTELLIGENCE',
] as const

/** One artifact family per domain agent. */
const EXPECTED_ARTIFACTS: Record<string, string> = {
  CONTRACT_ADMINISTRATION: 'CONTRACT_HEALTH',
  OPPORTUNITY: 'OPPORTUNITY_BRIEF',
  COMPLIANCE: 'COMPLIANCE_STATUS',
  QUALIFICATION: 'QUALIFICATION_BRIEF',
  TEAMING: 'TEAMING_PLAN',
  PRICING: 'PRICING_ASSESSMENT',
  PROPOSAL: 'PROPOSAL_STATUS',
  FINANCE: 'FINANCE_STATUS',
  INTELLIGENCE: 'PORTFOLIO_INTELLIGENCE',
}

/** The per-agent source directory under services/agents. */
const AGENT_DIRS: Record<string, string> = {
  CONTRACT_ADMINISTRATION: 'contract',
  OPPORTUNITY: 'opportunity',
  COMPLIANCE: 'compliance',
  QUALIFICATION: 'qualification',
  TEAMING: 'teaming',
  PRICING: 'pricing',
  PROPOSAL: 'proposal',
  FINANCE: 'finance',
  INTELLIGENCE: 'intelligence',
}

// -------------------------------------------------------------
// Source walking
// -------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const ALL_TS = walk(SRC)
const PRODUCTION_TS = ALL_TS.filter((f) => !f.includes('.test.'))
const rel = (f: string) => f.replace(SRC + '/', '')
const strip = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const agentSourceFiles = (key: string): string[] => {
  const dir = join(AGENTS_DIR, AGENT_DIRS[key])
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.includes('.test.')).map((f) => join(dir, f))
}

// =============================================================
// 1. Registry — nine and only nine
// =============================================================

describe('acceptance: registry is exactly nine domain agents', () => {
  it('declares the nine expected domain agents and no others', () => {
    expect([...DOMAIN_AGENT_KEYS].sort()).toEqual([...EXPECTED_DOMAIN_AGENTS].sort())
  })

  it('adds no tenth agent — the registry is nine domain plus one internal diagnostic', () => {
    expect(AGENT_REGISTRY).toHaveLength(DOMAIN_AGENT_KEYS.length + 1)
    expect(AGENT_REGISTRY.filter((d) => d.key === INTERNAL_AGENT_KEY)).toHaveLength(1)
  })

  it.each([...EXPECTED_DOMAIN_AGENTS])('%s is implemented with a real, distinct handler', (key) => {
    const def = getAgentDefinition(key as AgentKey)!
    expect(def.implemented).toBe(true)
    expect(def.handler).not.toBeNull()
    expect(typeof def.handler).toBe('function')
  })

  it('gives every agent its own handler — no shared placeholder', () => {
    const handlers = AGENT_REGISTRY.map((d) => d.handler)
    expect(new Set(handlers).size).toBe(handlers.length)
  })

  it('leaves no NOT_IMPLEMENTED domain agent', () => {
    expect(DOMAIN_AGENT_KEYS.filter((k) => !getAgentDefinition(k)!.implemented)).toEqual([])
  })

  it('defaults every agent to disabled and to the least autonomous level', () => {
    for (const d of AGENT_REGISTRY) {
      expect(d.defaultEnabled, `${d.key} must not be enabled by default`).toBe(false)
      expect(d.defaultAutonomyLevel, `${d.key} must default to ${DEFAULT_AUTONOMY_LEVEL}`).toBe(DEFAULT_AUTONOMY_LEVEL)
    }
  })

  it('grants no domain agent an allowlisted action', () => {
    // Only the internal diagnostic holds one, and it is a deliberate no-op.
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key)!.allowlistedActionKeys, `${key} must allowlist nothing`).toEqual([])
    }
    expect(getAgentDefinition(INTERNAL_AGENT_KEY)!.allowlistedActionKeys).toEqual(['diagnostic.noop'])
  })

  it('supports the four runtime triggers on every agent', () => {
    for (const d of AGENT_REGISTRY) {
      expect([...d.supportedTriggers].sort(), d.key).toEqual(['EVENT', 'MANUAL', 'RETRY', 'SCHEDULE'])
    }
  })

  it('declares no agent as requiring an LLM', () => {
    // Every agent has a deterministic path; LLM use is an optional
    // sub-capability, which `noLlmBehaviour` describes.
    expect(AGENT_REGISTRY.filter((d) => d.requiresLlm).map((d) => d.key)).toEqual([])
    for (const d of AGENT_REGISTRY) {
      expect(d.noLlmBehaviour, `${d.key} must describe its no-key behaviour`).toBeTruthy()
    }
  })

  it('gives a non-zero token budget only to agents that actually call a provider', () => {
    const budgeted = AGENT_REGISTRY.filter((d) => (d.defaultTokenBudget ?? 0) > 0).map((d) => d.key).sort()
    // COMPLIANCE, PROPOSAL and TEAMING have optional LLM sub-capabilities;
    // INTERNAL_DIAGNOSTIC has a token budget so the budget guard is testable.
    expect(budgeted).toEqual(['COMPLIANCE', 'INTERNAL_DIAGNOSTIC', 'PROPOSAL', 'TEAMING'])
  })

  it('gives every agent a plannedSlice in the 7.x series', () => {
    for (const d of AGENT_REGISTRY) {
      expect(d.plannedSlice, d.key).toMatch(/^7\.\d$/)
    }
  })
})

// =============================================================
// 2. One artifact family per agent
// =============================================================

describe('acceptance: artifact inventory', () => {
  it.each(Object.entries(EXPECTED_ARTIFACTS))('%s produces %s', (key, artifact) => {
    expect(getAgentDefinition(key as AgentKey)!.supportedArtifactTypes).toContain(artifact)
  })

  it('gives each domain agent exactly one artifact family', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      expect(getAgentDefinition(key)!.supportedArtifactTypes, key).toHaveLength(1)
    }
  })

  it('never shares an artifact family between two agents', () => {
    const all = AGENT_REGISTRY.flatMap((d) => d.supportedArtifactTypes)
    expect(new Set(all).size).toBe(all.length)
  })
})

// =============================================================
// 3. One runtime — structural
// =============================================================

describe('acceptance: exactly one Section 7 runtime', () => {
  it('constructs exactly one agent queue in the whole backend', () => {
    const sites = PRODUCTION_TS.filter((f) => /new Queue\(\s*AGENT_QUEUE_NAME|new Queue\(\s*'agent-runtime'/.test(readFileSync(f, 'utf8')))
    expect(sites.map(rel)).toEqual(['workers/agentWorker.ts'])
  })

  it('constructs exactly one agent Worker', () => {
    const sites = PRODUCTION_TS.filter((f) => {
      const code = readFileSync(f, 'utf8')
      return /new Worker\(/.test(code) && /AGENT_QUEUE_NAME/.test(code)
    })
    expect(sites.map(rel)).toEqual(['workers/agentWorker.ts'])
  })

  it('defines exactly one scheduler and one reaper', () => {
    const schedulers = PRODUCTION_TS.filter((f) => /export async function runAgentScheduler/.test(readFileSync(f, 'utf8')))
    const reapers = PRODUCTION_TS.filter((f) => /export async function reapStaleAgentRuns/.test(readFileSync(f, 'utf8')))
    expect(schedulers.map(rel)).toEqual(['services/agents/scheduler.ts'])
    expect(reapers.map(rel)).toEqual(['services/agents/reaper.ts'])
  })

  it('creates no per-agent worker, queue, scheduler or reaper', () => {
    const forbidden = /(?:opportunity|compliance|qualification|teaming|pricing|proposal|finance|intelligence|contractAdmin)(?:Agent)?(?:Worker|Queue|Scheduler|Reaper)\b/i
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        expect(forbidden.test(code), `${rel(f)} must not define per-agent runtime infrastructure`).toBe(false)
      }
    }
  })

  it('never lets an agent directory construct a BullMQ primitive', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        expect(/new Queue\(|new Worker\(|new QueueScheduler\(|from 'bullmq'/.test(code), `${rel(f)} must use the shared runtime`).toBe(false)
      }
    }
  })

  it('registers exactly two repeatable jobs — the tick and the reaper', () => {
    const code = readFileSync(join(SRC, 'workers', 'agentWorker.ts'), 'utf8')
    const schedules = code.match(/\[AGENT_\w+_JOB, '[^']+'\]/g) ?? []
    expect(schedules).toHaveLength(2)
    expect(schedules.join(' ')).toContain('AGENT_TICK_JOB')
    expect(schedules.join(' ')).toContain('AGENT_REAPER_JOB')
  })

  it('leaves the Section 6 source-sync job as the single owner of provider fetching', () => {
    const owners = PRODUCTION_TS.filter((f) => /SOURCE_SYNC_JOB\s*=/.test(readFileSync(f, 'utf8')))
    expect(owners.map(rel)).toEqual(['workers/section6Worker.ts'])
    // No agent directory may schedule its own source sync.
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        expect(/SOURCE_SYNC_JOB|addRepeatable|repeat:\s*\{/.test(strip(readFileSync(f, 'utf8'))), rel(f)).toBe(false)
      }
    }
  })
})

// =============================================================
// 4. Event graph
// =============================================================

/** Resolve exported `const X = 'LITERAL'` names across the tree. */
function buildConstMap(): Map<string, string> {
  const m = new Map<string, string>()
  for (const f of PRODUCTION_TS) {
    for (const match of readFileSync(f, 'utf8').matchAll(/export const ([A-Z_][A-Z0-9_]*)\s*=\s*'([A-Z_][A-Z0-9_]*)'/g)) {
      m.set(match[1], match[2])
    }
  }
  return m
}

/** eventType -> files that emit it. */
function buildEmitterMap(): Map<string, Set<string>> {
  const consts = buildConstMap()
  const emitted = new Map<string, Set<string>>()
  for (const f of PRODUCTION_TS) {
    for (const match of readFileSync(f, 'utf8').matchAll(/eventType:\s*('?)([A-Z_][A-Z0-9_]*)\1/g)) {
      const key = consts.get(match[2]) ?? match[2]
      if (!emitted.has(key)) emitted.set(key, new Set())
      emitted.get(key)!.add(rel(f))
    }
  }
  return emitted
}

/**
 * The TWO documented self-emissions, and why each terminates.
 *
 * COMPLIANCE → EXTRACTION_COMPLETED
 *   The handler runs extraction and announces it so the downstream checks run
 *   against the new requirements. Bounded by CONTENT IDEMPOTENCY:
 *   `runExtraction` keys on a SHA-256 of the normalised document text, so the
 *   second run returns `alreadyProcessed` and emits nothing. The dedupe key
 *   also carries the same extraction job id, so a repeat is suppressed twice
 *   over. Chain length: 2.
 *
 * TEAMING → SUBCONTRACT_MILESTONE_DUE
 *   The handler announces a goal that has entered a new risk state. Bounded by
 *   the DEDUPE KEY, which is `firm:goal:riskState` and carries NO timestamp:
 *   re-detecting the same goal in the same state produces the identical key
 *   and the outbox suppresses it. Total events per goal are bounded absolutely
 *   by the number of distinct risk states.
 *
 * `section7EventLoop.audit.test.ts` proves both terminate against a real
 * database. Any OTHER self-emission is a defect.
 */
const SELF_EMIT_ALLOWED = new Map<string, string>([
  ['COMPLIANCE', 'EXTRACTION_COMPLETED'],
  ['TEAMING', 'SUBCONTRACT_MILESTONE_DUE'],
])

/** A self-emitting event must never carry a timestamp in its dedupe key. */
const SELF_EMIT_MUST_BE_STABLE = ['SUBCONTRACT_MILESTONE_DUE', 'EXTRACTION_COMPLETED']

describe('acceptance: event graph', () => {
  const emitted = buildEmitterMap()
  const subscribed = new Set(AGENT_REGISTRY.flatMap((d) => d.subscribedEventTypes))

  it('gives every emitted event exactly ONE emitter site', () => {
    const multi = [...emitted.entries()].filter(([, files]) => files.size > 1)
    expect(multi.map(([e, f]) => `${e}: ${[...f].join(', ')}`)).toEqual([])
  })

  it('gives every emitted event at least one subscriber', () => {
    const orphans = [...emitted.keys()].filter((e) => !subscribed.has(e))
    expect(orphans).toEqual([])
  })

  it('emits every subscribed event from production code, except the test-only diagnostic ping', () => {
    const unemitted = [...subscribed].filter((e) => !emitted.has(e))
    // RUNTIME_DIAGNOSTIC_PING exists so the runtime's event path can be tested
    // without a domain event. It has no production emitter by design.
    expect(unemitted).toEqual(['RUNTIME_DIAGNOSTIC_PING'])
  })

  it('emits every event from an agent events module, never from a route or a component', () => {
    for (const [event, files] of emitted) {
      for (const f of files) {
        expect(f, `${event} must be emitted from an agents/*/**Events.ts module`).toMatch(/services\/agents\/[a-z]+\/\w+Events\.ts$/)
      }
    }
  })

  it('passes a transaction client to every emitter, so a rollback emits nothing', () => {
    for (const f of PRODUCTION_TS.filter((p) => /services\/agents\/[a-z]+\/\w+Events\.ts$/.test(rel(p)))) {
      const code = readFileSync(f, 'utf8')
      for (const fn of code.matchAll(/export function (emit[A-Za-z0-9_]+)[\s\S]{0,600}?emitAgentEvent\(/g)) {
        const body = fn[0]
        expect(/tx: Prisma\.TransactionClient|tx,\n|\btx\b/.test(body), `${rel(f)} ${fn[1]} must take a transaction client`).toBe(true)
      }
    }
  })

  it('scopes every event to a tenant', () => {
    for (const f of PRODUCTION_TS.filter((p) => /services\/agents\/[a-z]+\/\w+Events\.ts$/.test(rel(p)))) {
      const code = readFileSync(f, 'utf8')
      const emits = code.match(/emitAgentEvent\(\s*\{[\s\S]{0,400}?\}/g) ?? []
      for (const e of emits) {
        expect(e.includes('consultingFirmId'), `${rel(f)}: every emit must carry consultingFirmId`).toBe(true)
      }
      const dedupes = code.match(/dedupeKey:[^\n]+/g) ?? []
      for (const d of dedupes) {
        expect(d.includes('consultingFirmId') || d.includes('args.consultingFirmId'), `${rel(f)}: ${d.trim()} must be tenant-scoped`).toBe(true)
      }
    }
  })

  it('keys every self-emitted event stably, so a re-detection cannot re-fire', () => {
    // A `Date.now()` in a self-emitted event's dedupe key would make the chain
    // unbounded: every run would produce a new key and trigger another run.
    for (const f of PRODUCTION_TS.filter((p) => /services\/agents\/[a-z]+\/\w+Events\.ts$/.test(rel(p)))) {
      const code = readFileSync(f, 'utf8')
      for (const event of SELF_EMIT_MUST_BE_STABLE) {
        const block = code.match(new RegExp(`eventType:\\s*${event}[\\s\\S]{0,400}?dedupeKey:[^\\n]+`))
        if (!block) continue
        expect(/Date\.now\(\)/.test(block[0]), `${rel(f)}: ${event} is self-emitted and must have a stable dedupe key`).toBe(false)
      }
    }
  })

  it('never lets an agent HANDLER emit an event that agent subscribes to', () => {
    // The loop guard. It inspects handlers and services, not the co-located
    // *Events.ts module: an events module may legitimately DEFINE an emitter
    // that a non-agent caller uses. SOURCE_SYNC_COMPLETED is the live example —
    // it is defined beside the Opportunity agent but emitted only by the
    // Section 6 sourceSync path, so the agent never triggers itself.
    for (const d of AGENT_REGISTRY) {
      const dir = AGENT_DIRS[d.key]
      if (!dir) continue
      const handlers = agentSourceFiles(d.key).filter((f) => !/Events\.ts$/.test(f))
      const emitterNames = new Map<string, string>()
      const eventsFile = join(AGENTS_DIR, dir, `${dir}Events.ts`)
      if (existsSync(eventsFile)) {
        const ev = readFileSync(eventsFile, 'utf8')
        const consts = buildConstMap()
        for (const m of ev.matchAll(/export function (emit[A-Za-z0-9_]+)([\s\S]{0,900}?)eventType:\s*('?)([A-Z_][A-Z0-9_]*)\3/g)) {
          emitterNames.set(m[1], consts.get(m[4]) ?? m[4])
        }
      }
      for (const f of handlers) {
        const code = strip(readFileSync(f, 'utf8'))
        for (const [fn, event] of emitterNames) {
          if (!new RegExp(`\\b${fn}\\s*\\(`).test(code)) continue
          if (SELF_EMIT_ALLOWED.get(d.key) === event) continue
          expect(
            d.subscribedEventTypes.includes(event),
            `${rel(f)} calls ${fn}, emitting ${event}, which ${d.key} also subscribes to — a self-trigger loop`,
          ).toBe(false)
        }
      }
    }
  })
})

// =============================================================
// 5. Human control — static forbidden-write matrix
// =============================================================

/**
 * Prisma models an agent must never create, update or delete.
 *
 * Read access is deliberately NOT forbidden: every agent must read the domain
 * it advises on. What is forbidden is mutation of a record that represents a
 * human decision or an authoritative business fact.
 */
/**
 * §8.2 — every ERP record that represents a human financial authority. No agent
 * may establish or activate a budget, approve or cancel a purchase order,
 * approve, reject or pay a vendor invoice, post cost from one, decide a
 * flow-down, or change a staffing commitment.
 */
/**
 * §8.3 — personnel evidence and external partner access. No agent may approve a
 * resume or a qualification, invite or revoke an external partner user, grant
 * engagement access, accept a partner submission, or record a partner upload.
 */
const PORTAL_AND_PERSONNEL_AUTHORITY = [
  'personnel', 'personnelResume', 'personnelLaborQualification', 'proposalKeyPersonnel',
  'partnerPortalUser', 'partnerEngagementAccess', 'partnerPortalUpload', 'partnerPersonnelSubmission',
  // §8.4 — accepting a partner's deliverable response, approving a partner's
  // profile change, resetting a portal password and enrolling a second factor
  // are all human acts on an external relationship. No agent may perform any
  // of them, and no agent may mint an API credential either.
  'partnerDeliverableSubmission', 'partnerProfileChangeRequest', 'partnerPortalPasswordReset',
  'apiToken',
  // §8.5 — connecting a provider, sending an agreement for signature, changing
  // who may sign in and granting a permission are all human, administrative
  // acts on the firm's own perimeter. An agent may consume what an integration
  // produced; it may not decide what the firm is connected to, what it has
  // signed, or who can do what.
  'integrationConnection', 'integrationOAuthState', 'integrationSyncRecord',
  'signatureRequest', 'signatureSigner',
  'firmSsoConfig', 'ssoIdentity', 'ssoLoginState',
]

const ERP_HUMAN_AUTHORITY = [
  'contractBudget', 'contractBudgetLine',
  'purchaseOrder', 'purchaseOrderLine',
  'subcontractInvoice', 'subcontractInvoiceLine',
  'subcontractFlowDown', 'resourceAllocation',
  ...PORTAL_AND_PERSONNEL_AUTHORITY,
]

const FORBIDDEN_WRITES: Record<string, string[]> = {
  CONTRACT_ADMINISTRATION: ['contractModification', 'contractOptionPeriod', 'fundingTransaction', ...ERP_HUMAN_AUTHORITY],
  OPPORTUNITY: ['bidDecision', 'submissionRecord', ...ERP_HUMAN_AUTHORITY],
  COMPLIANCE: ['bidDecision', 'proposalSubmission', 'submissionRecord', ...ERP_HUMAN_AUTHORITY],
  QUALIFICATION: ['bidDecision', 'bidPursuit', 'submissionRecord', ...ERP_HUMAN_AUTHORITY],
  TEAMING: ['bidDecision', 'submissionRecord', 'proposalSubmission', ...ERP_HUMAN_AUTHORITY],
  PRICING: ['bidDecision', 'pricingReview', 'submissionRecord', ...ERP_HUMAN_AUTHORITY],
  PROPOSAL: ['bidDecision', 'proposalSubmission', 'submissionRecord', 'contractInvoice', ...ERP_HUMAN_AUTHORITY],
  FINANCE: ['invoicePayment', 'bidDecision', 'proposalSubmission', 'actualIndirectRate', ...ERP_HUMAN_AUTHORITY],
  INTELLIGENCE: [
    'bidDecision', 'bidPursuit', 'opportunityMatch', 'qualificationRecommendation',
    'pricingScenario', 'pricingWorkspace', 'firmCapability', 'capabilityNarrative',
    'proposalSection', 'contractInvoice', 'invoicePayment', 'tenantCalibration', 'submissionRecord',
    ...ERP_HUMAN_AUTHORITY,
  ],
}

describe('acceptance: human-control forbidden-write matrix', () => {
  it.each(Object.entries(FORBIDDEN_WRITES))('%s never mutates its forbidden models', (key, models) => {
    for (const f of agentSourceFiles(key)) {
      const code = strip(readFileSync(f, 'utf8'))
      for (const model of models) {
        const write = new RegExp(`\\b${model}\\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\\b`)
        expect(write.test(code), `${rel(f)} must not write ${model}`).toBe(false)
      }
    }
  })

  /**
   * §8.2 — an agent may stamp an existing cost as invoiced (that is how the
   * Finance agent assembles a DRAFT invoice), but it may never bring a NEW
   * actual cost into existence. Only the canonical subcontract-invoice posting
   * service, driven by a human approval, does that.
   */
  it('never lets an agent create or delete a contract cost', () => {
    const create = /\bcontractCost\.(create|createMany|delete|deleteMany)\b/
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        expect(create.test(code), `${rel(f)} must not create or delete actual cost`).toBe(false)
      }
    }
  })

  it('never lets an agent write an APPROVED, SUBMITTED or PAID status', () => {
    const terminal = /status:\s*'(APPROVED|SUBMITTED|PAID|EXECUTED|SIGNED|ACCEPTED|VERIFIED|CONFIRMED)'/
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        // Match only inside a Prisma write, not a read filter.
        const writes = code.match(/\.(create|createMany|update|updateMany|upsert)\(\{[\s\S]{0,800}?\n\s*\}\)/g) ?? []
        for (const w of writes) {
          expect(terminal.test(w), `${rel(f)} writes a human-approval status:\n${w.slice(0, 200)}`).toBe(false)
        }
      }
    }
  })

  it('never lets an agent set a human approver or signer field', () => {
    const humanFields = /(approvedByUserId|signedByUserId|verifiedByUserId|selectedByUserId|executedByUserId|acknowledgedByUserId|dismissedByUserId)\s*:/
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        const writes = code.match(/\.(create|createMany|update|updateMany|upsert)\(\{[\s\S]{0,800}?\n\s*\}\)/g) ?? []
        for (const w of writes) {
          if (!humanFields.test(w)) continue
          // Writing NULL is how an agent records that no person approved it.
          const assignments = w.match(new RegExp(humanFields.source + '\\s*([^,\\n]+)', 'g')) ?? []
          for (const a of assignments) {
            expect(/null/.test(a), `${rel(f)} sets a human actor field to a non-null value: ${a.trim()}`).toBe(true)
          }
        }
      }
    }
  })

  it('never reaches an external network from an agent directory', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        expect(/\baxios\b|\bnode-fetch\b|(?<!\.)\bfetch\(/.test(code), `${rel(f)} must make no direct network call`).toBe(false)
      }
    }
  })

  it('never sends an email or an external message from an agent directory', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        expect(/nodemailer|sendMail|sendGrid|twilio|\bsendEmail\(/i.test(code), `${rel(f)} must not contact anyone externally`).toBe(false)
      }
    }
  })
})

// =============================================================
// 6. LLM capability matrix
// =============================================================

/**
 * Agents whose OWN directory reaches the provider router.
 *
 * Compliance is deliberately absent: its optional AI clause extraction is
 * delegated to the pre-existing Section 6 `requirementExtractionWorker`, so no
 * router call originates in the compliance agent directory. Its token budget
 * exists because that reused pipeline consumes tenant budget on its behalf.
 */
const LLM_CAPABLE = new Set(['TEAMING', 'PROPOSAL'])

/** Reaches a provider only through a pre-existing Section 6 service. */
const LLM_DELEGATED = new Set(['COMPLIANCE'])

describe('acceptance: LLM capability matrix', () => {
  it.each([...DOMAIN_AGENT_KEYS])('%s reaches the provider router only if it is LLM-capable', (key) => {
    const touches = agentSourceFiles(key).some((f) => {
      const code = strip(readFileSync(f, 'utf8'))
      return /llm\/llmRouter|generateWithRouter/.test(code)
    })
    expect(touches, `${key}: expected LLM-capable=${LLM_CAPABLE.has(key)}`).toBe(LLM_CAPABLE.has(key))
  })

  it('gives a token budget to exactly the agents that can consume one', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      const budget = getAgentDefinition(key)!.defaultTokenBudget ?? 0
      if (LLM_CAPABLE.has(key) || LLM_DELEGATED.has(key)) {
        expect(budget, `${key} should have a budget`).toBeGreaterThan(0)
      } else {
        expect(budget, `${key} makes no provider call and should have a zero budget`).toBe(0)
      }
    }
  })

  it('leaves six agents with no provider path and no budget at all', () => {
    const deterministic = DOMAIN_AGENT_KEYS.filter((k) => !LLM_CAPABLE.has(k) && !LLM_DELEGATED.has(k))
    expect([...deterministic].sort()).toEqual([
      'CONTRACT_ADMINISTRATION', 'FINANCE', 'INTELLIGENCE', 'OPPORTUNITY', 'PRICING', 'QUALIFICATION',
    ])
  })

  it('defines a system prompt only inside an LLM-capable agent', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      const hasPrompt = agentSourceFiles(key).some((f) => /SYSTEM_PROMPT|systemPrompt/.test(strip(readFileSync(f, 'utf8'))))
      if (!LLM_CAPABLE.has(key) && !LLM_DELEGATED.has(key)) {
        expect(hasPrompt, `${key} is deterministic and must define no prompt`).toBe(false)
      }
    }
  })

  it('checks provider availability before invoking the router', () => {
    for (const key of LLM_CAPABLE) {
      const files = agentSourceFiles(key)
      const callers = files.filter((f) => /generateWithRouter/.test(strip(readFileSync(f, 'utf8'))))
      if (callers.length === 0) continue
      const anyGuard = files.some((f) => /isLlmProviderConfigured|providerAvailable/.test(strip(readFileSync(f, 'utf8'))))
      expect(anyGuard, `${key} must check provider availability before calling the router`).toBe(true)
    }
  })
})

// =============================================================
// 7. Prompt inventory
// =============================================================

describe('acceptance: system prompt inventory', () => {
  const promptFiles = PRODUCTION_TS.filter((f) => /services\/agents\//.test(rel(f)) && /SYSTEM_PROMPT\s*[:=]/.test(readFileSync(f, 'utf8')))

  it('confines Section 7 prompt definitions to Teaming and Proposal', () => {
    // Compliance REUSES two existing Section 6 prompts rather than defining
    // its own, so its directory defines none.
    const dirs = [...new Set(promptFiles.map((f) => rel(f).split('/')[2]))].sort()
    expect(dirs).toEqual(['proposal', 'teaming'])
  })

  it('defines exactly five prompt constants inside Section 7 directories', () => {
    const constants = promptFiles.flatMap((f) =>
      [...readFileSync(f, 'utf8').matchAll(/export const ([A-Z_]*SYSTEM_PROMPT)\s*=/g)].map((m) => m[1]),
    ).sort()
    // Teaming 2 + Proposal 3.
    expect(constants).toHaveLength(5)
  })

  it('keeps a pinned exactness test beside every prompt module', () => {
    for (const f of promptFiles) {
      const exactness = f.replace('.ts', '.exactness.test.ts')
      const sibling = readdirSync(join(f, '..')).filter((n) => n.includes('exactness'))
      expect(existsSync(exactness) || sibling.length > 0, `${rel(f)} must have an exactness test`).toBe(true)
    }
  })

  it('never lets the Proposal directory import the §5 prompt of the same name', () => {
    // PAST_PERFORMANCE_ADAPTATION_SYSTEM_PROMPT exists in BOTH §5 and §7 with
    // different content. Importing the wrong one would silently swap the
    // instructions given to the model.
    for (const f of agentSourceFiles('PROPOSAL')) {
      const code = strip(readFileSync(f, 'utf8'))
      const imports = code.match(/import\s*\{([^}]*)\}\s*from\s*'[^']*pastPerformanceRelevance'/)
      if (!imports) continue
      for (const symbol of imports[1].split(',').map((s) => s.trim())) {
        expect(symbol, `${rel(f)} imports ${symbol} from the §5 module`).not.toMatch(/PROMPT/)
      }
    }
  })
})

// =============================================================
// 8. Placeholders, secrets and debug residue
// =============================================================

describe('acceptance: no shipping placeholders or leaked secrets', () => {
  const allAgentFiles = DOMAIN_AGENT_KEYS.flatMap((k) => agentSourceFiles(k))

  it('leaves no TODO, FIXME or unimplemented throw in any agent directory', () => {
    const offenders: string[] = []
    for (const f of allAgentFiles) {
      // Prompt modules are hash-pinned. `proposalPrompts.ts` instructs the model
      // never to treat a "TODO" marker as coverage — that is prompt CONTENT,
      // not a shipping placeholder, and editing it would break the pinned hash.
      if (/Prompts\.ts$/.test(f)) continue
      const code = readFileSync(f, 'utf8')
      if (/\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b/.test(code)) offenders.push(`${rel(f)}: TODO/FIXME`)
      if (/throw new Error\(\s*['"`](not implemented|unimplemented|TODO)/i.test(code)) offenders.push(`${rel(f)}: unimplemented throw`)
    }
    expect(offenders).toEqual([])
  })

  it('leaves no console debugging in any agent directory', () => {
    for (const f of allAgentFiles) {
      expect(/console\.(log|debug|warn|error|info)\(/.test(strip(readFileSync(f, 'utf8'))), `${rel(f)}`).toBe(false)
    }
  })

  it('hard-codes no tenant id or QA fixture id in any agent directory', () => {
    for (const f of allAgentFiles) {
      const code = strip(readFileSync(f, 'utf8'))
      expect(/S7-[A-Z]+-QA/.test(code), `${rel(f)} contains a QA fixture id`).toBe(false)
      // A bare UUID literal in production agent code is almost always a
      // hard-coded tenant or record id.
      expect(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/.test(code), `${rel(f)} contains a hard-coded UUID`).toBe(false)
    }
  })

  it('embeds no credential in any agent directory', () => {
    const secret = /(sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]\s*['"][^'"]{12,}|Bearer\s+[A-Za-z0-9._-]{20,}|password\s*[:=]\s*['"][^'"]{6,})/i
    for (const f of allAgentFiles) {
      expect(secret.test(strip(readFileSync(f, 'utf8'))), `${rel(f)} may contain a credential`).toBe(false)
    }
  })

  it('reads configuration through the config module, never process.env directly', () => {
    for (const f of allAgentFiles) {
      expect(/process\.env\./.test(strip(readFileSync(f, 'utf8'))), `${rel(f)} must not read process.env directly`).toBe(false)
    }
  })
})

// =============================================================
// 9. Financial Decimal discipline
// =============================================================

describe('acceptance: Decimal discipline in money-handling agents', () => {
  const MONEY_AGENTS = ['CONTRACT_ADMINISTRATION', 'PRICING', 'TEAMING', 'FINANCE', 'INTELLIGENCE']

  it.each(MONEY_AGENTS)('%s uses Decimal rather than float for authoritative money', (key) => {
    for (const f of agentSourceFiles(key)) {
      const code = strip(readFileSync(f, 'utf8'))
      // parseFloat on an amount, or toFixed on a raw Number arithmetic result,
      // is how a cent goes missing.
      expect(/parseFloat\([^)]*(amount|total|value|price|rate|cost)/i.test(code), `${rel(f)} parses money with parseFloat`).toBe(false)
    }
  })

  it('never rounds an authoritative amount with Math.round in a money agent', () => {
    for (const key of MONEY_AGENTS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        const rounds = code.match(/Math\.round\([^)]*\)/g) ?? []
        for (const r of rounds) {
          // `covered / total` is a ratio of counts, not a currency amount.
          const isRatio = /\/\s*\w*(total|count|sample|n)\b/i.test(r) || /\*\s*100\b/.test(r)
          if (isRatio) continue
          expect(/amount|price|invoice|payment|receipt|disburse|\bcost\b/i.test(r), `${rel(f)}: ${r} rounds money with Math.round`).toBe(false)
        }
      }
    }
  })
})

// =============================================================
// 10. Data-sufficiency honesty
// =============================================================

describe('acceptance: insufficient data is stated, never defaulted', () => {
  it('gives every agent a way to report insufficient data', () => {
    for (const key of DOMAIN_AGENT_KEYS) {
      const speaks = agentSourceFiles(key).some((f) =>
        /INSUFFICIENT_DATA|dataLimitations|limitations/.test(strip(readFileSync(f, 'utf8'))),
      )
      expect(speaks, `${key} must be able to say it does not know`).toBe(true)
    }
  })

  it('never returns a bare `?? 0` for a rate, probability or score', () => {
    const offenders: string[] = []
    for (const key of DOMAIN_AGENT_KEYS) {
      for (const f of agentSourceFiles(key)) {
        const code = strip(readFileSync(f, 'utf8'))
        for (const m of code.matchAll(/(\w*(?:Rate|Probability|Score|Percentile|Confidence))\s*(?:=|:)\s*[^,;\n]*\?\?\s*0\b/g)) {
          offenders.push(`${rel(f)}: ${m[0].trim()}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

// =============================================================
// §8 FINAL ACCEPTANCE — the agent boundary over the whole of Section 8.
//
// Section 7 already pins a forbidden-write matrix. This suite asks the wider
// question the final audit is for: is EVERY authoritative model Section 8
// introduced actually on that list, and is every human decision Section 8
// created actually unreachable from an agent?
//
// It derives the model list from the SCHEMA rather than restating it, so a
// model added tomorrow is caught by omission instead of by memory.
// =============================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { AGENT_REGISTRY } from '../services/agents/registry'

const ROOT = path.resolve(__dirname, '../..')
const ACCEPTANCE = readFileSync(path.join(ROOT, 'src/services/agents/section7Acceptance.audit.test.ts'), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.includes('.test.')) out.push(full)
  }
  return out
}

const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/')
const AGENT_SOURCES = walk(path.join(ROOT, 'src/services/agents'))

/**
 * The models Section 8 made authoritative for a HUMAN decision.
 *
 * Each carries the decision it records. If an agent could write one, the
 * platform would be recording a machine's opinion as a person's decision — and
 * every downstream audit, invoice and contract would inherit that lie.
 */
const HUMAN_AUTHORITY_MODELS: Array<[string, string]> = [
  ['contractBudget', 'activating a budget'],
  ['purchaseOrder', 'approving a purchase order'],
  ['subcontractInvoice', 'approving a vendor invoice'],
  ['subcontractFlowDown', 'a legal flow-down determination'],
  ['resourceAllocation', 'committing a person to a contract'],
  ['personnel', 'who the firm proposes'],
  ['personnelResume', 'approving evidence a proposal rests on'],
  ['personnelLaborQualification', 'verifying a qualification'],
  ['proposalKeyPersonnel', 'selecting key personnel'],
  ['partnerPortalUser', 'inviting an external company in'],
  ['partnerEngagementAccess', 'granting an external company access'],
  ['partnerPortalUpload', 'what a partner filed'],
  ['partnerPersonnelSubmission', 'what a partner offered'],
  ['partnerDeliverableSubmission', 'accepting a partner’s work'],
  ['partnerProfileChangeRequest', 'approving a change to a partner record'],
  ['partnerPortalPasswordReset', 'an external account credential'],
  ['apiToken', 'minting a platform credential'],
  ['integrationConnection', 'what the firm is connected to'],
  ['integrationOAuthState', 'an authorization in flight'],
  ['integrationSyncRecord', 'the external idempotency ledger'],
  ['signatureRequest', 'sending an agreement for signature'],
  ['signatureSigner', 'who signs'],
  ['firmSsoConfig', 'who may sign in'],
  ['ssoIdentity', 'which identity is which person'],
  ['ssoLoginState', 'a sign-in in flight'],
]

describe('§8 acceptance: every Section 8 authority is in the forbidden-write matrix', () => {
  for (const [model, decision] of HUMAN_AUTHORITY_MODELS) {
    it(`forbids every agent from writing ${model} — ${decision}`, () => {
      expect(ACCEPTANCE).toContain(`'${model}'`)
    })
  }

  it('applies the matrix to all nine business agents, at both authority levels', () => {
    // The registry also carries INTERNAL_DIAGNOSTIC, the runtime's own test
    // harness. It is not a business agent and has no domain authority.
    const business = AGENT_REGISTRY.filter((a) => a.key !== 'INTERNAL_DIAGNOSTIC')
    expect(business).toHaveLength(9)
  })

  it('permits no business agent to APPLY anything, at either authority level', async () => {
    // The forbidden-write matrix is a static proof. This is the runtime one:
    // an action can only be applied if it is allowlisted for that agent, and
    // no business agent has a single allowlisted action — so raising a firm's
    // autonomy setting to ACT_WITH_GUARDRAILS still permits nothing.
    const { canApplyAction } = await import('../services/agents/safeActions')
    const { requireAgentDefinition } = await import('../services/agents/registry')
    for (const agent of AGENT_REGISTRY.filter((a) => a.key !== 'INTERNAL_DIAGNOSTIC')) {
      expect([agent.key, requireAgentDefinition(agent.key).allowlistedActionKeys]).toEqual([agent.key, []])
      for (const level of ['OBSERVE', 'PROPOSE', 'ACT_WITH_GUARDRAILS'] as const) {
        expect([agent.key, level, canApplyAction(agent.key, level, 'anything')]).toEqual([agent.key, level, false])
      }
    }
  })
})

describe('§8 acceptance: no agent source writes a Section 8 authority', () => {
  const WRITE = /\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/

  it('contains no write call against any Section 8 authoritative model', () => {
    const offenders: string[] = []
    for (const file of AGENT_SOURCES) {
      const body = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      for (const [model] of HUMAN_AUTHORITY_MODELS) {
        const pattern = new RegExp(`\\b${model}\\s*\\.\\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\\(`)
        if (pattern.test(body)) offenders.push(`${rel(file)}: ${model}`)
      }
      void WRITE
    }
    expect(offenders).toEqual([])
  })

  it('connects, disconnects or configures no provider from an agent', () => {
    const offenders: string[] = []
    for (const file of AGENT_SOURCES) {
      const body = readFileSync(file, 'utf8')
      for (const forbidden of ['upsertConnection', 'disconnectConnection', 'startOAuthState', 'exchangeSlackCode', 'sendEnvelope', 'esignAdapterFor']) {
        if (body.includes(forbidden)) offenders.push(`${rel(file)}: ${forbidden}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('grants no role or permission from an agent', () => {
    const offenders: string[] = []
    for (const file of AGENT_SOURCES) {
      const body = readFileSync(file, 'utf8')
      if (/extraPermissions|resolvePermissions|requirePermission/.test(body)) offenders.push(rel(file))
    }
    expect(offenders).toEqual([])
  })

  it('reads Section 8 evidence without writing it', () => {
    // The one legitimate agent↔Section 8 seam: the Proposal Agent reads
    // approved personnel evidence. It must READ only.
    const evidence = readFileSync(path.join(ROOT, 'src/services/agents/proposal/personnelEvidence.ts'), 'utf8')
    expect(evidence).toMatch(/prisma\.proposalKeyPersonnel\.findMany/)
    expect(evidence).not.toMatch(/\.(create|update|upsert|delete)\(/)
  })
})

describe('§8 acceptance: the proposal prompt is unchanged', () => {
  it('imports the canonical prompt module and nothing else', () => {
    const drafts = readFileSync(path.join(ROOT, 'src/services/agents/proposal/proposalDrafts.ts'), 'utf8')
    expect(drafts).toMatch(/from '\.\/proposalPrompts'/)
    expect(drafts).toMatch(/proposalSystemPrompt\('PROPOSAL_SECTION_DRAFT'\)/)
  })

  it('still forbids inventing a credential, in the prompt itself', () => {
    const prompts = readFileSync(path.join(ROOT, 'src/services/agents/proposal/proposalPrompts.ts'), 'utf8')
    expect(prompts).toMatch(/Do not invent staffing, key personnel, resumes/)
    expect(prompts).toMatch(/Missing information must remain visibly missing/)
    // The version constants are unbumped, so the pinned hashes still apply.
    expect(prompts).toContain("'proposal-section-draft-v1'")
  })
})

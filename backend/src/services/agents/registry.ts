// =============================================================
// §7.0 — Code-level agent registry.
//
// Deliberately NOT a database table. A code registry cannot drift from the
// handlers it names, is type-checked at build time, and needs no migration to
// add an agent. Per-tenant *state* lives in AgentSchedule; per-agent *identity*
// lives here. Same reasoning as EXPECTED_JOBS and ADDON_CATALOG.
//
// IMPLEMENTATION STATUS IS HONEST AND PER-AGENT:
//   §7.1  CONTRACT_ADMINISTRATION — implemented, real deterministic handler
//   §7.2  OPPORTUNITY             — implemented, real deterministic handler
//   §7.3  COMPLIANCE              — implemented, deterministic; AI extraction optional
//   §7.4  QUALIFICATION           — implemented, real deterministic handler
//   §7.5  TEAMING · §7.6 PRICING · §7.7 PROPOSAL · §7.8 FINANCE — implemented
//   §7.9  INTELLIGENCE            — implemented, real deterministic handler
//
// As of §7.9 ALL NINE domain agents are implemented. The honesty machinery
// below (implemented:false → dispatcher refuses, UI renders NOT IMPLEMENTED)
// stays in place: it is what kept the product truthful while the set was
// incomplete, and it must keep working if an agent is ever added.
//
// An agent with no handler cannot be enabled, scheduled or run: the dispatcher
// refuses it with NOT_IMPLEMENTED and the UI renders NOT IMPLEMENTED rather
// than a fake healthy state. Metadata still exists for them so schedules,
// budgets and the operations UI have something real to describe.
// =============================================================
import type { AgentDefinition, AgentKey } from './types'
import { DEFAULT_AUTONOMY_LEVEL, DOMAIN_AGENT_KEYS, INTERNAL_AGENT_KEY } from './types'
import { internalDiagnosticHandler } from './handlers/internalDiagnostic'
import { contractAdministrationHandler } from './contract/contractAdministrationHandler'
import { opportunityAgentHandler } from './opportunity/opportunityAgentHandler'
import { complianceAgentHandler } from './compliance/complianceAgentHandler'
import { qualificationAgentHandler } from './qualification/qualificationAgentHandler'
import { teamingAgentHandler } from './teaming/teamingAgentHandler'
import { pricingAgentHandler } from './pricing/pricingAgentHandler'
import { proposalAgentHandler } from './proposal/proposalAgentHandler'
import { financeAgentHandler } from './finance/financeAgentHandler'
import { intelligenceAgentHandler } from './intelligence/intelligenceAgentHandler'

const TEN_MINUTES = 10 * 60 * 1000

/** Shared defaults so nine entries do not drift apart on the boring fields. */
const base = {
  implemented: false as const,
  defaultEnabled: false,
  supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'] as AgentDefinition['supportedTriggers'],
  defaultAutonomyLevel: DEFAULT_AUTONOMY_LEVEL,
  maxRuntimeMs: TEN_MINUTES,
  defaultMaxAttempts: 3,
  backoffMs: 30_000,
  handler: null,
}

export const AGENT_REGISTRY: AgentDefinition[] = [
  {
    ...base,
    key: 'OPPORTUNITY',
    name: 'Opportunity Agent',
    description:
      'Keeps the opportunity surface current, matched and prioritised, and learns from what the firm pursues or ignores.',
    // §7.2 — the second real domain agent. Deterministic; makes no LLM call, so
    // it works with zero provider configuration.
    implemented: true,
    plannedSlice: '7.2',
    // Not auto-enabled: a firm admin opts in through AgentSchedule.
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    defaultCronExpression: '0 */2 * * *',
    requiresLlm: false,
    noLlmBehaviour: 'Full function — entirely deterministic; performs zero AI inference and consumes no tokens.',
    // Zero budget: any attempted LLM call would be refused by the budget guard,
    // which is a second line of defence behind the handler simply never calling one.
    defaultTokenBudget: 0,
    supportedArtifactTypes: ['OPPORTUNITY_BRIEF'],
    subscribedEventTypes: [
      'SOURCE_SYNC_COMPLETED',
      'FIRM_CAPABILITY_CHANGED',
      'MONITORING_PROFILE_SAVED',
      'PURSUIT_STAGE_CHANGED',
    ],
    // Deliberately empty: applying a learned weighting, verifying a capability,
    // accepting a re-compete signal, confirming a forecast link and recording a
    // bid decision are human decisions, never autonomously available — not even
    // at ACT_WITH_GUARDRAILS.
    allowlistedActionKeys: [],
    handler: opportunityAgentHandler,
  },
  {
    ...base,
    key: 'QUALIFICATION',
    name: 'Qualification Agent',
    description:
      'Produces a defensible bid/no-bid recommendation with reasoning shown, and escalates borderline calls instead of deciding silently.',
    // §7.4 — the fourth real domain agent. Entirely deterministic: the scoring
    // comes from the canonical Section 5/6 engines and the narrative from a
    // pure template renderer, so it works with zero provider configuration.
    implemented: true,
    plannedSlice: '7.4',
    // Not auto-enabled: a firm admin opts in through AgentSchedule.
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    defaultCronExpression: '0 */6 * * *',
    requiresLlm: false,
    noLlmBehaviour: 'Full function — entirely deterministic; performs zero AI inference and consumes no tokens.',
    // Zero budget: any attempted LLM call would be refused by the budget guard,
    // a second line of defence behind the handler simply never making one.
    defaultTokenBudget: 0,
    supportedArtifactTypes: ['QUALIFICATION_BRIEF'],
    subscribedEventTypes: [
      'OPPORTUNITY_MATCH_HIGH',
      // Reused emitters — §7.2 owns the first, §7.3 owns the other two.
      'PURSUIT_STAGE_CHANGED',
      'EXTRACTION_COMPLETED',
      'AMENDMENT_RECORDED',
    ],
    // Deliberately empty. Recording a bid/no-bid decision, approving or
    // rejecting a gate review, and overriding a human's rationale are never
    // autonomously available — not even at ACT_WITH_GUARDRAILS.
    allowlistedActionKeys: [],
    handler: qualificationAgentHandler,
  },
  {
    ...base,
    key: 'COMPLIANCE',
    name: 'Compliance Agent',
    description:
      'Keeps the compliance picture current from solicitation through amendment, and keeps registrations and certifications valid.',
    // §7.3 — the third real domain agent. Every check it performs is
    // deterministic, so it runs with zero provider configuration; AI-assisted
    // extraction is a separate, optional enrichment it reports on but never
    // depends on.
    implemented: true,
    plannedSlice: '7.3',
    // Not auto-enabled: a firm admin opts in through AgentSchedule.
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    defaultCronExpression: '0 */6 * * *',
    // FALSE is the honest value: no path in this agent requires a provider, and
    // marking it true would wrongly render the agent unusable without a key.
    requiresLlm: false,
    noLlmBehaviour:
      'Full function — registration, certification, insurance, bonding, document expiry, L/M coverage, clause obligations, amendment re-check and pre-submission checks are all deterministic. Only the optional AI-enhanced extraction is unavailable, and the status says so.',
    // A budget is kept because the canonical extraction path this agent invokes
    // may, in a provider-configured deployment, enrich its output through the
    // shared budget guard. The agent itself issues no prompt.
    defaultTokenBudget: 100_000,
    supportedArtifactTypes: ['COMPLIANCE_STATUS'],
    subscribedEventTypes: [
      'SOLICITATION_DOCUMENT_ADDED',
      'EXTRACTION_COMPLETED',
      'AMENDMENT_RECORDED',
      // Reused from §7.2 — this agent subscribes, it does not re-emit.
      'PURSUIT_STAGE_CHANGED',
    ],
    // Deliberately empty: verifying a requirement, approving a clause, clearing
    // legal review, accepting an ambiguous mapping, acknowledging an amendment
    // and waiving a submission blocker are human decisions, never autonomously
    // available — not even at ACT_WITH_GUARDRAILS.
    allowlistedActionKeys: [],
    handler: complianceAgentHandler,
  },
  {
    ...base,
    key: 'PROPOSAL',
    name: 'Proposal Agent',
    description:
      'Turns an approved bid decision into a compliant, solicitation-aligned outline and drafts, and keeps the review cycle moving.',
    // §7.7 — the seventh real domain agent.
    implemented: true,
    plannedSlice: '7.7',
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    // Every 6 hours for active proposals.
    defaultCronExpression: '0 */6 * * *',
    // FALSE, deliberately. `requiresLlm` is advisory metadata surfaced on the
    // definitions endpoint; the runtime has no PARTIAL/OPTIONAL capability
    // field. Marking it true would tell an operator the agent cannot run
    // without a provider, which is untrue: outline building, requirement
    // mapping, skeletons, coverage, deterministic compliance, review reminders
    // and PROPOSAL_STATUS all work with no key at all. AI drafting is a
    // provider-gated SUB-capability, which `noLlmBehaviour` states exactly.
    requiresLlm: false,
    noLlmBehaviour:
      'Full deterministic function — outline, requirement mapping, section skeletons, coverage, compliance checks, review reminders and PROPOSAL_STATUS all run with no provider. AI section drafting, past-performance adaptation and the AI compliance cross-check are provider-gated and report "AI drafting unavailable — no provider configured".',
    maxRuntimeMs: 20 * 60 * 1000,
    defaultTokenBudget: 300_000,
    supportedArtifactTypes: ['PROPOSAL_STATUS'],
    subscribedEventTypes: [
      'BID_DECISION_RECORDED',
      'EXTRACTION_COMPLETED',
      'PROPOSAL_SECTION_APPROVED',
      'AMENDMENT_RECORDED',
      'CAPABILITY_NARRATIVE_APPROVED',
    ],
    // It drafts and reports. It approves, verifies and submits nothing, so
    // there is deliberately nothing to allowlist.
    allowlistedActionKeys: [],
    handler: proposalAgentHandler,
  },
  {
    ...base,
    key: 'PRICING',
    name: 'Pricing Agent',
    description:
      'Keeps pricing structurally sound, benchmarked against public award data, and warns when a price falls outside the historically competitive range.',
    // §7.6 — the sixth real domain agent. Every figure it produces is
    // computed: rate arithmetic, indirect allocation, cohort selection,
    // percentiles and range classification. Pricing must stay auditable, so
    // this agent deliberately has NO system prompt and makes no LLM call.
    implemented: true,
    plannedSlice: '7.6',
    // Opt-in, like every other scheduled capability.
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    // Every 12 hours for active pricing workspaces.
    defaultCronExpression: '0 */12 * * *',
    requiresLlm: false,
    noLlmBehaviour: 'Full function — deterministic by design; no AI is used anywhere near pricing.',
    // Zero budget: any attempted LLM call would be refused by the budget guard,
    // which is the second line of defence behind having no prompt at all.
    defaultTokenBudget: 0,
    supportedArtifactTypes: ['PRICING_ASSESSMENT'],
    subscribedEventTypes: [
      'BID_DECISION_RECORDED',
      'PRICING_SCENARIO_CHANGED',
      'AMENDMENT_RECORDED',
      'INDIRECT_RATE_CHANGED',
    ],
    // The agent recomputes derived totals and reports. It changes no human
    // pricing input, so there is deliberately nothing to allowlist.
    allowlistedActionKeys: [],
    handler: pricingAgentHandler,
  },
  {
    ...base,
    key: 'TEAMING',
    name: 'Teaming Agent',
    description:
      'Detects capability gaps, proposes partners with evidence, prepares agreement drafts for legal review, and tracks subcontracting obligations.',
    // §7.5 — the fifth real domain agent. Partner matching, gap detection,
    // performance measurement and goal tracking are entirely deterministic; the
    // two drafting prompts are optional additions on top of them.
    implemented: true,
    plannedSlice: '7.5',
    // Opt-in, exactly like every other scheduled capability.
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    // Daily: active pursuits with unresolved capability gaps. The partner
    // performance window ends at the start of the ISO week, so the performance
    // refresh is effectively weekly however often the schedule fires.
    defaultCronExpression: '0 3 * * *',
    requiresLlm: false,
    noLlmBehaviour:
      'Full function — matching, gap detection, performance and goal tracking are deterministic, and agreement, NDA and outreach drafts fall back to templates that carry the same legal-review and human-send guarantees.',
    // A modest budget: the two prompts are optional, and a firm that never
    // configures a provider spends nothing.
    defaultTokenBudget: 80_000,
    supportedArtifactTypes: ['TEAMING_PLAN'],
    subscribedEventTypes: [
      'BID_DECISION_RECORDED',
      'CAPABILITY_GAP_DETECTED',
      'PARTNER_ADDED',
      'SUBCONTRACT_MILESTONE_DUE',
    ],
    // The agent proposes. It executes nothing: no arrangement, no signature,
    // no send. There is deliberately nothing to allowlist.
    allowlistedActionKeys: [],
    handler: teamingAgentHandler,
  },
  {
    ...base,
    key: 'CONTRACT_ADMINISTRATION',
    name: 'Contract Administration Agent',
    description:
      'Keeps awarded contracts administered — deliverables on time, modifications propagated, funding watched, option decisions surfaced early.',
    // §7.1 — the first real domain agent. Its handler is deterministic and
    // makes no LLM call, so it works with zero provider configuration.
    implemented: true,
    plannedSlice: '7.1',
    // Not auto-enabled: a firm admin opts in through AgentSchedule, exactly as
    // every other scheduled capability on the platform.
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    defaultCronExpression: '0 7 * * *',
    requiresLlm: false,
    noLlmBehaviour: 'Full function — entirely deterministic; performs zero AI inference and consumes no tokens.',
    // Zero budget: any attempted LLM call would be refused by the budget guard,
    // which is a second line of defence behind the handler simply never calling one.
    defaultTokenBudget: 0,
    supportedArtifactTypes: ['CONTRACT_HEALTH'],
    subscribedEventTypes: [
      'CONTRACT_AWARDED',
      'CONTRACT_MODIFICATION_ADDED',
      'DELIVERABLE_STATUS_CHANGED',
      'FUNDING_TRANSACTION_ADDED',
    ],
    // Deliberately empty: accepting a deliverable, applying a modification,
    // exercising an option and adjusting funding are human decisions and are
    // never autonomously available, even at ACT_WITH_GUARDRAILS.
    allowlistedActionKeys: [],
    handler: contractAdministrationHandler,
  },
  {
    ...base,
    key: 'FINANCE',
    name: 'Finance Agent',
    description:
      'Keeps billing current, receivables visible, rates monitored, timekeeping audit-ready and cash flow projected. Never submits an invoice.',
    // §7.8 — the eighth real domain agent.
    implemented: true,
    plannedSlice: '7.8',
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    // Daily. The monthly billing cycle is not a second schedule — one
    // AgentSchedule exists per (firm, agent) — it emerges from the billing
    // period being the last CLOSED calendar month, gated by an
    // existing-invoice check, so a daily sweep bills each month exactly once.
    defaultCronExpression: '0 8 * * *',
    // Genuinely false, and enforced: this agent makes zero provider calls and
    // has a zero token budget. Every figure it reports is computed from
    // records, because no model may calculate or interpret a financial amount.
    requiresLlm: false,
    noLlmBehaviour: 'Full function — deterministic and reproducible for audit. Invoices, receivables ageing, timekeeping readiness, rate variance and cash flow are all computed, never generated.',
    defaultTokenBudget: 0,
    supportedArtifactTypes: ['FINANCE_STATUS'],
    // Three events, not the four the plan lists. BILLING_PERIOD_CLOSED is
    // absent because the codebase has no contract billing-period close to emit
    // it from; inventing one would mean firing a business event when nothing in
    // the business closed. See services/agents/finance/financeEvents.ts.
    subscribedEventTypes: ['INVOICE_PAID', 'TIME_ENTRY_SUBMITTED', 'CONTRACT_COST_ADDED'],
    // It bills, ages, checks and projects. It approves, submits and pays
    // nothing, so there is deliberately nothing to allowlist.
    allowlistedActionKeys: [],
    handler: financeAgentHandler,
  },
  {
    ...base,
    key: 'INTELLIGENCE',
    name: 'Intelligence Agent',
    description:
      'Reports where the firm actually wins and where to concentrate capture effort — including, honestly, when there is not yet enough data to say.',
    // §7.9 — the ninth and final domain agent. Section 7 is now complete.
    implemented: true,
    plannedSlice: '7.9',
    defaultEnabled: false,
    supportedTriggers: ['MANUAL', 'SCHEDULE', 'EVENT', 'RETRY'],
    // Weekly, Monday 05:00. Outcome history moves slowly; a daily sweep would
    // re-derive the same statistics from the same records.
    defaultCronExpression: '0 5 * * 1',
    // Genuinely false, and enforced: zero provider calls and a zero budget.
    // The plan permitted ONE optional narrative prompt; it was deliberately not
    // taken. Every sentence is assembled from the structured statistics beside
    // it, so recommendations stay reproducible and no numeric claim can exist
    // outside the calculation that produced it.
    requiresLlm: false,
    noLlmBehaviour: 'Full function — every figure and every sentence is computed. Win/loss segmentation, Wilson intervals, trends, concentration, the public benchmark, capture focus and the capability roadmap all run with no provider, and the narrative is assembled deterministically from the structured evidence.',
    defaultTokenBudget: 0,
    supportedArtifactTypes: ['PORTFOLIO_INTELLIGENCE'],
    // CONTRACT_AWARDED is the §7.1 emitter, reused rather than duplicated.
    subscribedEventTypes: ['SUBMISSION_OUTCOME_RECORDED', 'CONTRACT_AWARDED', 'CALIBRATION_UPDATED'],
    // It analyses and recommends. It decides nothing, so there is deliberately
    // nothing to allowlist.
    allowlistedActionKeys: [],
    handler: intelligenceAgentHandler,
  },
  // ---------------------------------------------------------
  // Internal only. Never surfaced by the product API.
  // ---------------------------------------------------------
  {
    ...base,
    key: INTERNAL_AGENT_KEY,
    name: 'Internal Runtime Diagnostic',
    description:
      'Exercises the shared runtime end-to-end without pretending a domain agent exists. Never shown in the product UI.',
    implemented: true,
    plannedSlice: '7.0',
    defaultCronExpression: null,
    requiresLlm: false,
    noLlmBehaviour: 'Deterministic.',
    maxRuntimeMs: 30_000,
    defaultTokenBudget: 1_000,
    supportedArtifactTypes: ['RUNTIME_DIAGNOSTIC'],
    subscribedEventTypes: ['RUNTIME_DIAGNOSTIC_PING'],
    allowlistedActionKeys: ['diagnostic.noop'],
    handler: internalDiagnosticHandler,
    internal: true,
  },
]

const BY_KEY = new Map<AgentKey, AgentDefinition>(AGENT_REGISTRY.map((d) => [d.key, d]))

export function getAgentDefinition(key: AgentKey): AgentDefinition | undefined {
  return BY_KEY.get(key)
}

export function requireAgentDefinition(key: AgentKey): AgentDefinition {
  const def = BY_KEY.get(key)
  if (!def) throw new Error(`Unknown agent key: ${key}`)
  return def
}

export function isKnownAgentKey(value: unknown): value is AgentKey {
  return typeof value === 'string' && BY_KEY.has(value as AgentKey)
}

/** Registry entries safe to expose to the product API — internal agents removed. */
export function publicAgentDefinitions(): AgentDefinition[] {
  return AGENT_REGISTRY.filter((d) => !d.internal)
}

/** Domain keys only, preserving the proposal's ordering. */
export function domainAgentKeys(): AgentKey[] {
  return [...DOMAIN_AGENT_KEYS]
}

/** Implemented agents subscribed to an event type. Unimplemented never match. */
export function agentsSubscribedTo(eventType: string): AgentDefinition[] {
  return AGENT_REGISTRY.filter((d) => d.implemented && d.handler !== null && d.subscribedEventTypes.includes(eventType))
}

// =============================================================
// §7.0 — Autonomy policy + safe-action allowlist.
//
// The autonomy dial is the core safety control of the agent layer:
//
//   OBSERVE              compute, persist artifacts, notify. NO business writes.
//   PROPOSE              the above, plus proposed actions and escalations.
//                        Still NO silent judgement-based business writes.
//   ACT_WITH_GUARDRAILS  may execute ONLY explicitly allowlisted action keys.
//
// PROPOSE is the default for every agent (see registry.ts). No domain actions
// are registered in this foundation slice — the allowlist ships empty on
// purpose, so ACT_WITH_GUARDRAILS currently permits nothing for the nine
// domain agents even if an operator selects it.
// =============================================================
import type { AgentAutonomyLevel, AgentKey } from '@prisma/client'
import { requireAgentDefinition } from './registry'

export interface SafeActionDefinition {
  actionKey: string
  agentKey: AgentKey
  description: string
  /** Why executing this without a human is acceptable. Required — no blanket trust. */
  reversibilityNote: string
}

/**
 * The ONLY actions an agent may ever perform autonomously. A domain slice adds
 * its entries here together with the tests that prove reversibility.
 *
 * Foundation slice: only the internal diagnostic no-op. Deliberately empty for
 * all nine domain agents.
 */
export const SAFE_ACTION_REGISTRY: SafeActionDefinition[] = [
  {
    actionKey: 'diagnostic.noop',
    agentKey: 'INTERNAL_DIAGNOSTIC',
    description: 'Does nothing. Exists to prove the autonomy gate permits an allowlisted key.',
    reversibilityNote: 'No state is written, so there is nothing to reverse.',
  },
]

const BY_AGENT = new Map<AgentKey, Set<string>>()
for (const a of SAFE_ACTION_REGISTRY) {
  if (!BY_AGENT.has(a.agentKey)) BY_AGENT.set(a.agentKey, new Set())
  BY_AGENT.get(a.agentKey)!.add(a.actionKey)
}

/**
 * True only when the level is ACT_WITH_GUARDRAILS *and* the action key is both
 * declared on the agent definition and present in the global safe-action
 * registry. Two independent lists must agree — a typo in either one fails
 * closed.
 */
export function canApplyAction(agentKey: AgentKey, autonomyLevel: AgentAutonomyLevel, actionKey: string): boolean {
  if (autonomyLevel !== 'ACT_WITH_GUARDRAILS') return false
  const def = requireAgentDefinition(agentKey)
  if (!def.allowlistedActionKeys.includes(actionKey)) return false
  return BY_AGENT.get(agentKey)?.has(actionKey) ?? false
}

/** Autonomy levels that may never write business records. */
export function isReadOnlyAutonomy(level: AgentAutonomyLevel): boolean {
  return level === 'OBSERVE' || level === 'PROPOSE'
}

/**
 * Applied actions reported by a handler are only trusted when the policy would
 * genuinely have permitted them. Anything else is downgraded to a proposal and
 * surfaced as a warning rather than silently accepted.
 */
export function partitionAppliedActions<T extends { actionKey: string }>(
  agentKey: AgentKey,
  autonomyLevel: AgentAutonomyLevel,
  applied: T[],
): { permitted: T[]; rejected: T[] } {
  const permitted: T[] = []
  const rejected: T[] = []
  for (const a of applied) {
    if (canApplyAction(agentKey, autonomyLevel, a.actionKey)) permitted.push(a)
    else rejected.push(a)
  }
  return { permitted, rejected }
}

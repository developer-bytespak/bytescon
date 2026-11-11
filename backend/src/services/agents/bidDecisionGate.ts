// =============================================================
// Bid decision gate.
//
// A person's NO_BID (or DEFERRED) decision means the firm is not working this
// opportunity right now. Agents that prepare bid material — Proposal, Pricing
// and Teaming — must respect that on every run: the event carrying the decision,
// and any later sweep or event that would otherwise pick the same record up.
//
// BID and CONDITIONAL carry on. Recording a new decision lifts the gate.
// =============================================================
import type { QualificationStatus } from '@prisma/client'
import { prisma } from '../../config/database'
import { BID_DECISION_RECORDED } from './teaming/teamingEvents'
import type { AgentExecutionContext } from './types'

const NOT_PURSUING: QualificationStatus[] = ['NO_BID', 'DEFERRED']

/** True when this run was started by a decision not to pursue. */
export async function runTriggeredByDecline(ctx: Pick<AgentExecutionContext, 'consultingFirmId' | 'eventId'>): Promise<boolean> {
  if (!ctx.eventId) return false
  const event = await prisma.agentEvent.findFirst({
    where: { id: ctx.eventId, consultingFirmId: ctx.consultingFirmId },
    select: { eventType: true, payload: true },
  })
  if (event?.eventType !== BID_DECISION_RECORDED) return false
  const decision = (event.payload as { decision?: string } | null)?.decision
  return !!decision && (NOT_PURSUING as string[]).includes(decision)
}

/** The opportunities among `opportunityIds` this firm has decided not to pursue. */
export async function declinedOpportunityIds(consultingFirmId: string, opportunityIds: string[]): Promise<Set<string>> {
  if (opportunityIds.length === 0) return new Set()
  const pursuits = await prisma.bidPursuit.findMany({
    where: {
      consultingFirmId,
      opportunityId: { in: opportunityIds },
      // Declined once every client's scorecard says not to pursue (a consulting
      // firm may bid for one client and pass for another), or the stage says so.
      OR: [
        // "none still open" spells out the undecided (NULL) case: an `every`
        // filter on a NULL decision would wrongly pass.
        { scorecards: { some: { finalDecision: { in: NOT_PURSUING } }, none: { OR: [{ finalDecision: null }, { finalDecision: { notIn: NOT_PURSUING } }] } } },
        { pipelineStage: 'NO_BID' },
      ],
    },
    select: { opportunityId: true },
  })
  return new Set(pursuits.map((p) => p.opportunityId))
}

/** Removes records whose opportunity the firm declined; everything, on a decline event. */
export async function withoutDeclined<T extends { opportunityId: string | null }>(
  ctx: Pick<AgentExecutionContext, 'consultingFirmId' | 'eventId'>,
  records: T[],
): Promise<T[]> {
  if (records.length === 0) return records
  if (await runTriggeredByDecline(ctx)) return []
  const ids = [...new Set(records.map((r) => r.opportunityId).filter((id): id is string => !!id))]
  const declined = await declinedOpportunityIds(ctx.consultingFirmId, ids)
  return records.filter((r) => !r.opportunityId || !declined.has(r.opportunityId))
}

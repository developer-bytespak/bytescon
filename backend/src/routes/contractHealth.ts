// =============================================================
// §7.1 — Contract health read API.
//
// Deliberately small. Runs, schedules, artifacts and escalations are already
// served by the generic `/api/agents` surface and are NOT recreated here. These
// two endpoints exist only because the contract UI needs a contract-shaped,
// backend-authoritative view that would otherwise require the client to join
// artifacts to contracts itself — and health must never be recomputed in React.
//
// Mounted at /api/contract-health. Tenant-scoped; contract ownership is
// verified explicitly, never inferred from an id.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { NotFoundError } from '../utils/errors'
import { prisma } from '../config/database'
import { CONTRACT_POLICY_DOC, MONITORED_CONTRACT_STATUSES, type ContractHealthState } from '../services/agents/contract/policy'
import { CONTRACT_ENTITY_TYPE } from '../services/agents/contract/contractAdministrationHandler'

const router = Router()
router.use(authenticateJWT, enforceTenantScope)
router.use(requireActiveBase)

const AGENT_KEY = 'CONTRACT_ADMINISTRATION' as const

/** Latest non-superseded CONTRACT_HEALTH artifact per contract for this firm. */
async function latestHealthArtifacts(consultingFirmId: string, contractIds?: string[]) {
  return prisma.agentArtifact.findMany({
    where: {
      consultingFirmId,
      agentKey: AGENT_KEY,
      artifactType: 'CONTRACT_HEALTH',
      supersededByArtifactId: null,
      ...(contractIds ? { sourceEntityId: { in: contractIds } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, runId: true, sourceEntityId: true, title: true, summary: true,
      structuredData: true, confidenceState: true, createdAt: true, isHumanVerified: true,
    },
  })
}

/**
 * Portfolio roll-up for /contracts.
 *
 * Every health figure comes from the persisted artifact the agent produced —
 * the frontend renders, it does not calculate.
 */
router.get('/portfolio', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const [contracts, artifacts, lastRun, openEscalations, schedule] = await Promise.all([
      prisma.contract.findMany({
        where: { consultingFirmId, isArchived: false, status: { in: [...MONITORED_CONTRACT_STATUSES] } },
        select: { id: true, contractNumber: true, title: true, status: true, endDate: true, ownerUserId: true },
        orderBy: { endDate: 'asc' },
      }),
      latestHealthArtifacts(consultingFirmId),
      prisma.agentRun.findFirst({
        where: { consultingFirmId, agentKey: AGENT_KEY },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true, finishedAt: true, outputSummary: true, triggerType: true },
      }),
      prisma.agentEscalation.findMany({
        where: { consultingFirmId, agentKey: AGENT_KEY, status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
        select: { id: true, severity: true, title: true, entityType: true, entityId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      prisma.agentSchedule.findUnique({
        where: { consultingFirmId_agentKey: { consultingFirmId, agentKey: AGENT_KEY } },
        select: { isEnabled: true, nextRunAt: true, lastSuccessfulRunAt: true, autonomyLevel: true, cronExpression: true },
      }),
    ])

    const byContract = new Map(artifacts.map((a) => [a.sourceEntityId, a]))

    const tally: Record<ContractHealthState, number> = { HEALTHY: 0, ATTENTION: 0, CRITICAL: 0, INSUFFICIENT_DATA: 0 }
    let overdueDeliverables = 0
    let dueSoonDeliverables = 0
    let openOptionWindows = 0
    let popApproaching = 0
    let fundingWarnings = 0

    const rows = contracts.map((c) => {
      const artifact = byContract.get(c.id)
      const data = (artifact?.structuredData ?? null) as Record<string, unknown> | null
      const health = (data?.overallHealth as ContractHealthState) ?? null
      if (health) tally[health]++

      const deliverables = (data?.deliverables ?? {}) as { overdue?: number; dueSoon?: number }
      const funding = (data?.funding ?? {}) as { thresholdState?: string; fundedRemaining?: string; ceilingRemaining?: string }
      const options = (data?.options ?? {}) as { openWindowCount?: number }
      const pop = (data?.periodOfPerformance ?? {}) as { state?: string; daysRemaining?: number }

      overdueDeliverables += deliverables.overdue ?? 0
      dueSoonDeliverables += deliverables.dueSoon ?? 0
      openOptionWindows += options.openWindowCount ?? 0
      if (pop.state === 'APPROACHING_END' || pop.state === 'EXPIRED' || pop.state === 'OPTION_WINDOW') popApproaching++
      if (funding.thresholdState && funding.thresholdState !== 'OK' && funding.thresholdState !== 'INSUFFICIENT_DATA') fundingWarnings++

      return {
        contractId: c.id,
        contractNumber: c.contractNumber,
        title: c.title,
        status: c.status,
        endDate: c.endDate,
        ownerUserId: c.ownerUserId,
        // null means the agent has not assessed this contract yet — the UI says
        // "not assessed" rather than inventing a healthy state.
        health,
        summary: artifact?.summary ?? null,
        assessedAt: artifact?.createdAt ?? null,
        artifactId: artifact?.id ?? null,
        runId: artifact?.runId ?? null,
        overdueDeliverables: deliverables.overdue ?? 0,
        dueSoonDeliverables: deliverables.dueSoon ?? 0,
        fundingThresholdState: funding.thresholdState ?? null,
        fundedRemaining: funding.fundedRemaining ?? null,
        ceilingRemaining: funding.ceilingRemaining ?? null,
        openOptionWindows: options.openWindowCount ?? 0,
        popState: pop.state ?? null,
        popDaysRemaining: pop.daysRemaining ?? null,
      }
    })

    res.json({
      success: true,
      data: {
        agentKey: AGENT_KEY,
        schedule: schedule ?? null,
        lastRun,
        totals: {
          monitoredContracts: contracts.length,
          assessedContracts: rows.filter((r) => r.health !== null).length,
          ...tally,
          overdueDeliverables,
          dueSoonDeliverables,
          openOptionWindows,
          popApproaching,
          fundingWarnings,
          openEscalations: openEscalations.length,
        },
        contracts: rows,
        escalations: openEscalations,
        policy: CONTRACT_POLICY_DOC,
      },
    })
  } catch (err) { next(err) }
})

/**
 * Health detail for one contract.
 *
 * Ownership is verified on the contract itself before any artifact is read, so
 * a valid artifact id from another tenant can never be reached through a
 * contract id guess.
 */
router.get('/:contractId', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req)

    const contract = await prisma.contract.findFirst({
      where: { id: req.params.contractId, consultingFirmId },
      select: { id: true, contractNumber: true, title: true, status: true, ownerUserId: true, startDate: true, endDate: true },
    })
    if (!contract) throw new NotFoundError('Contract')

    const [artifact, lastRun, escalations] = await Promise.all([
      prisma.agentArtifact.findFirst({
        where: {
          consultingFirmId,
          agentKey: AGENT_KEY,
          artifactType: 'CONTRACT_HEALTH',
          sourceEntityType: CONTRACT_ENTITY_TYPE,
          sourceEntityId: contract.id,
          supersededByArtifactId: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.agentRun.findFirst({
        where: { consultingFirmId, agentKey: AGENT_KEY },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, status: true, triggerType: true, createdAt: true, startedAt: true, finishedAt: true,
          outputSummary: true, confidenceState: true, dataSufficiency: true, warnings: true, limitations: true,
          tokenInput: true, tokenOutput: true, estimatedCostUsd: true,
        },
      }),
      prisma.agentEscalation.findMany({
        where: {
          consultingFirmId,
          agentKey: AGENT_KEY,
          status: { in: ['OPEN', 'ACKNOWLEDGED'] },
          OR: [
            { entityId: contract.id },
            { entityType: 'ContractDeliverable' },
            { entityType: 'ContractOptionPeriod' },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 25,
      }),
    ])

    res.json({
      success: true,
      data: {
        contract,
        // Honest missing state: no artifact means the agent has not run for
        // this contract yet, which the UI reports plainly.
        health: artifact
          ? {
              artifactId: artifact.id,
              runId: artifact.runId,
              assessedAt: artifact.createdAt,
              confidenceState: artifact.confidenceState,
              isHumanVerified: artifact.isHumanVerified,
              summary: artifact.summary,
              ...(artifact.structuredData as object),
            }
          : null,
        lastRun,
        escalations,
        policy: CONTRACT_POLICY_DOC,
      },
    })
  } catch (err) { next(err) }
})

export default router

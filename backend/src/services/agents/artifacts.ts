// =============================================================
// §7.0 — Artifact persistence.
//
// Artifacts are the durable, structured output of a run. Two rules matter:
//
//  1. A human-verified artifact is NEVER mutated. A newer result supersedes it,
//     preserving the decision trail. This is the same contract §6 already
//     enforces for ClauseObligation.isManuallyVerified and MANUAL-origin
//     opportunity records.
//  2. Persistence is idempotent per (run, supersedeKey) so a BullMQ retry of the
//     same attempt cannot duplicate artifacts.
// =============================================================
import { Prisma } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import type { ProposedArtifact } from './types'
import type { AgentKey } from '@prisma/client'

export interface PersistArtifactsArgs {
  consultingFirmId: string
  runId: string
  agentKey: AgentKey
  artifacts: ProposedArtifact[]
}

export interface PersistArtifactsResult {
  created: number
  superseded: number
  skippedVerified: number
  duplicatesIgnored: number
}

/**
 * Writes a run's artifacts, superseding prior artifacts that describe the same
 * subject. Returns counters rather than throwing on partial failure — an
 * artifact problem must not lose the whole run's outcome.
 */
export async function persistArtifacts(args: PersistArtifactsArgs): Promise<PersistArtifactsResult> {
  const result: PersistArtifactsResult = { created: 0, superseded: 0, skippedVerified: 0, duplicatesIgnored: 0 }
  if (!args.artifacts.length) return result

  for (const artifact of args.artifacts) {
    try {
      // Retry-safety: an artifact of this type already written by THIS run means
      // the attempt is being replayed. Do not write a second copy.
      const existingForRun = await prisma.agentArtifact.findFirst({
        where: {
          runId: args.runId,
          artifactType: artifact.artifactType,
          sourceEntityType: artifact.sourceEntityType ?? null,
          sourceEntityId: artifact.sourceEntityId ?? null,
        },
        select: { id: true },
      })
      if (existingForRun) {
        result.duplicatesIgnored++
        continue
      }

      const created = await prisma.$transaction(async (tx) => {
        // Supersede the previous artifact describing the same subject, but never
        // touch one a human has verified.
        let priorIds: string[] = []
        if (artifact.supersedeKey || artifact.sourceEntityId) {
          const priors = await tx.agentArtifact.findMany({
            where: {
              consultingFirmId: args.consultingFirmId,
              agentKey: args.agentKey,
              artifactType: artifact.artifactType,
              sourceEntityType: artifact.sourceEntityType ?? null,
              sourceEntityId: artifact.sourceEntityId ?? null,
              supersededByArtifactId: null,
            },
            select: { id: true, isHumanVerified: true },
          })
          priorIds = priors.filter((p) => !p.isHumanVerified).map((p) => p.id)
          result.skippedVerified += priors.filter((p) => p.isHumanVerified).length
        }

        const row = await tx.agentArtifact.create({
          data: {
            consultingFirmId: args.consultingFirmId,
            runId: args.runId,
            agentKey: args.agentKey,
            artifactType: artifact.artifactType,
            title: artifact.title,
            summary: artifact.summary ?? null,
            structuredData: artifact.structuredData as Prisma.InputJsonObject,
            evidence: artifact.evidence ? (artifact.evidence as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
            sourceEntityType: artifact.sourceEntityType ?? null,
            sourceEntityId: artifact.sourceEntityId ?? null,
            confidenceState: artifact.confidenceState ?? 'MEDIUM',
          },
        })

        if (priorIds.length) {
          await tx.agentArtifact.updateMany({
            where: { id: { in: priorIds } },
            data: { supersededByArtifactId: row.id, supersededAt: new Date() },
          })
        }
        return { row, supersededCount: priorIds.length }
      })

      result.created++
      result.superseded += created.supersededCount
    } catch (err) {
      logger.error('Failed to persist agent artifact', {
        runId: args.runId,
        artifactType: artifact.artifactType,
        error: (err as Error).message,
      })
    }
  }

  return result
}

/**
 * Marks an artifact as human-verified. From this point the runtime will never
 * supersede or overwrite it.
 */
export async function verifyArtifact(
  consultingFirmId: string,
  artifactId: string,
  userId: string,
): Promise<boolean> {
  const updated = await prisma.agentArtifact.updateMany({
    where: { id: artifactId, consultingFirmId, isHumanVerified: false },
    data: { isHumanVerified: true, verifiedByUserId: userId, verifiedAt: new Date() },
  })
  return updated.count > 0
}

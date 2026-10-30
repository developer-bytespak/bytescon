// =============================================================
// Client review packets — documents a firm sends to a client's portal for
// review & approval, and the client's verdict on them.
//
// A packet is an ordinary ClientDocument, so it appears in the client portal's
// Proposals tab with the existing approve / request-changes / comment flow.
// Packets generated from a Proposal or Pricing workspace carry a storageKey
// prefixed with their source ("proposal-<id>-", "pricing-<id>-"); that prefix
// is how a workspace finds the reviews of what it sent, with no schema change.
// =============================================================
import fs from 'fs'
import path from 'path'
import { ClientDocumentType } from '@prisma/client'
import { prisma } from '../config/database'
import { runBackground } from '../utils/asyncSafe'
import { notifyDeliverableReady } from './emailService'
import { smsDeliverableReady } from './smsService'

export type ClientReviewStatus = 'APPROVED' | 'CHANGES_REQUESTED'

export interface ClientReview {
  status: ClientReviewStatus
  notes: string | null
  at: Date
}

/** Prefix that ties a generated packet back to the workspace it came from. */
export function packetSourcePrefix(kind: 'proposal' | 'pricing', sourceId: string): string {
  return `${kind}-${sourceId}-`
}

/**
 * Email/SMS every opted-in active portal user of the client that a new
 * deliverable is waiting for review. Fire-and-forget; failures are recorded by
 * runBackground rather than thrown.
 */
export function notifyPortalUsersOfDeliverable(opts: {
  consultingFirmId: string
  clientCompanyId: string
  deliverableId: string
  title: string
}): void {
  runBackground(
    'client-deliverable-created-notify',
    async () => {
      const portalUsers = await prisma.clientPortalUser.findMany({
        where: {
          clientCompanyId: opts.clientCompanyId,
          isActive: true,
          OR: [{ notifyDeliverables: true }, { smsEnabled: true }],
        },
        select: { email: true, firstName: true, lastName: true, notifyDeliverables: true, smsEnabled: true, smsPhone: true },
      })
      const portalUrl = (process.env.FRONTEND_URL || 'http://localhost:3000') + '/client-portal'
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: opts.consultingFirmId },
        select: { name: true, brandingDisplayName: true },
      })
      const firmDisplayName = firm?.brandingDisplayName || firm?.name || 'Bytescon'

      await Promise.all(portalUsers.flatMap((u) => {
        const tasks: Promise<unknown>[] = []
        if (u.notifyDeliverables) {
          tasks.push(notifyDeliverableReady({
            firmId: opts.consultingFirmId,
            recipientEmail: u.email,
            recipientName: `${u.firstName} ${u.lastName}`.trim(),
            deliverableTitle: opts.title,
            portalUrl,
          }))
        }
        if (u.smsEnabled && u.smsPhone) {
          tasks.push(smsDeliverableReady({
            to: u.smsPhone,
            consultingFirmId: opts.consultingFirmId,
            firmDisplayName,
            deliverableTitle: opts.title,
          }))
        }
        return tasks
      }))
    },
    {
      consultingFirmId: opts.consultingFirmId,
      entityType: 'DocumentRequirement',
      entityId: opts.deliverableId,
      failureAction: 'EMAIL_DELIVERY_FAILED',
    },
  )
}

/**
 * Store a generated PDF as a ClientDocument in the client's portal and notify
 * the client. The caller has already verified the client belongs to the firm.
 */
export async function publishPdfToClient(opts: {
  consultingFirmId: string
  clientCompanyId: string
  sourcePrefix: string
  title: string
  fileName: string
  documentType: ClientDocumentType
  notes?: string | null
  pdf: Buffer
}) {
  const storageKey = `${opts.sourcePrefix}${Date.now()}.pdf`
  const uploadDir = path.join(process.cwd(), 'uploads')
  await fs.promises.mkdir(uploadDir, { recursive: true })
  await fs.promises.writeFile(path.join(uploadDir, storageKey), opts.pdf)

  const doc = await prisma.clientDocument.create({
    data: {
      consultingFirmId: opts.consultingFirmId,
      clientCompanyId: opts.clientCompanyId,
      title: opts.title,
      documentType: opts.documentType,
      fileName: opts.fileName,
      fileType: 'application/pdf',
      fileSize: opts.pdf.length,
      storageKey,
      notes: opts.notes ?? null,
    },
  })

  notifyPortalUsersOfDeliverable({
    consultingFirmId: opts.consultingFirmId,
    clientCompanyId: opts.clientCompanyId,
    deliverableId: doc.id,
    title: opts.title,
  })
  return doc
}

/**
 * Attach the client's latest portal verdict and comment count to each document.
 * Approve / request-changes are recorded as ComplianceLog rows (APPROVED /
 * IN_PROGRESS) keyed on the document id.
 */
export async function withClientReview<T extends { id: string }>(
  consultingFirmId: string,
  docs: T[],
): Promise<(T & { clientReview: ClientReview | null; commentCount: number })[]> {
  if (docs.length === 0) return []
  const ids = docs.map((d) => d.id)
  const [verdicts, counts] = await Promise.all([
    prisma.complianceLog.findMany({
      where: { consultingFirmId, entityType: 'DOCUMENT_REQUIREMENT', entityId: { in: ids }, toStatus: { in: ['APPROVED', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
      select: { entityId: true, toStatus: true, reason: true, createdAt: true },
    }),
    prisma.deliverableComment.groupBy({ by: ['deliverableId'], where: { deliverableId: { in: ids } }, _count: { _all: true } }),
  ])
  const latest = new Map<string, (typeof verdicts)[number]>()
  for (const v of verdicts) if (!latest.has(v.entityId)) latest.set(v.entityId, v)
  const countById = new Map(counts.map((c) => [c.deliverableId, c._count._all]))

  return docs.map((doc) => {
    const v = latest.get(doc.id)
    return {
      ...doc,
      commentCount: countById.get(doc.id) ?? 0,
      clientReview: v
        ? { status: v.toStatus === 'APPROVED' ? 'APPROVED' : 'CHANGES_REQUESTED', notes: v.reason, at: v.createdAt }
        : null,
    }
  })
}

/** Packets a workspace has sent, newest first, with client name and verdict. */
export async function listPacketsForSource(consultingFirmId: string, sourcePrefix: string) {
  const docs = await prisma.clientDocument.findMany({
    where: { consultingFirmId, storageKey: { startsWith: sourcePrefix } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, title: true, fileName: true, createdAt: true, clientCompanyId: true,
      clientCompany: { select: { id: true, name: true } },
    },
  })
  return withClientReview(consultingFirmId, docs)
}

// =============================================================
// §6.3D — Standing document library.
//
// Integrates the documents the platform ALREADY stores rather than copying
// them. A registration document, certification file, insurance certificate,
// past-performance attachment or proposal file is surfaced in the library as a
// REFERENCE (sourceSystem + sourceRecordId) to the same secure file record.
// No file is ever duplicated.
//
// Availability is established here — from the library — and never from
// solicitation text, which is what the §6.3A extraction prompt requires.
// =============================================================
import {
  DocumentVerificationState,
  Prisma,
  StandingDocumentCategory,
} from '@prisma/client'
import { prisma } from '../config/database'
import { checkExpiryAgainstLifecycle, type ExpiryState, type LifecycleDates } from './documentExpiry'

export type SourceSystem = 'REGISTRATION' | 'CERTIFICATION' | 'INSURANCE' | 'PAST_PERFORMANCE' | 'PROPOSAL' | 'SUBMISSION' | 'LIBRARY'

export interface SyncResult {
  created: number
  updated: number
  skipped: number
}

/**
 * Mirror existing certification and insurance records into the library as
 * references. Idempotent: re-running updates the same rows.
 */
export async function syncExistingDocuments(consultingFirmId: string, now: Date = new Date()): Promise<SyncResult> {
  let created = 0
  let updated = 0
  let skipped = 0

  const certifications = await prisma.certification.findMany({
    where: { consultingFirmId, isArchived: false },
    select: { id: true, name: true, category: true, expiryDate: true, issueDate: true, documentKey: true, ownerUserId: true, notes: true },
  })

  for (const cert of certifications) {
    const existing = await prisma.standingDocument.findFirst({
      where: { consultingFirmId, sourceSystem: 'CERTIFICATION', sourceRecordId: cert.id },
      select: { id: true },
    })
    const data = {
      category: StandingDocumentCategory.CERTIFICATION,
      name: cert.name,
      description: cert.notes,
      effectiveDate: cert.issueDate,
      expiryDate: cert.expiryDate,
      ownerUserId: cert.ownerUserId,
      relatedCertificationId: cert.id,
    }
    if (existing) {
      await prisma.standingDocument.update({ where: { id: existing.id }, data })
      updated++
      continue
    }
    const doc = await prisma.standingDocument.create({
      data: {
        consultingFirmId,
        ...data,
        // A reference to the existing secure file — never a copy of it.
        sourceSystem: 'CERTIFICATION',
        sourceRecordId: cert.id,
        tags: ['certification'],
        currentVersionNo: 1,
      },
    })
    await prisma.standingDocumentVersion.create({
      data: { documentId: doc.id, versionNo: 1, fileKey: cert.documentKey, fileName: cert.documentKey, isCurrent: true, changeNote: 'Imported reference to the existing certification record.' },
    })
    created++
  }

  const policies = await prisma.insurancePolicy.findMany({
    where: { consultingFirmId, isArchived: false },
    select: { id: true, policyType: true, carrier: true, expiryDate: true, effectiveDate: true, documentKey: true, ownerUserId: true, notes: true },
  })

  for (const policy of policies) {
    const isBond = /BOND/.test(policy.policyType)
    const existing = await prisma.standingDocument.findFirst({
      where: { consultingFirmId, sourceSystem: 'INSURANCE', sourceRecordId: policy.id },
      select: { id: true },
    })
    const data = {
      category: isBond ? StandingDocumentCategory.BOND : StandingDocumentCategory.INSURANCE,
      name: `${policy.policyType}${policy.carrier ? ` — ${policy.carrier}` : ''}`,
      description: policy.notes,
      effectiveDate: policy.effectiveDate,
      expiryDate: policy.expiryDate,
      ownerUserId: policy.ownerUserId,
      relatedInsurancePolicyId: policy.id,
    }
    if (existing) {
      await prisma.standingDocument.update({ where: { id: existing.id }, data })
      updated++
      continue
    }
    const doc = await prisma.standingDocument.create({
      data: {
        consultingFirmId, ...data,
        sourceSystem: 'INSURANCE',
        sourceRecordId: policy.id,
        tags: [isBond ? 'bond' : 'insurance'],
        currentVersionNo: 1,
      },
    })
    await prisma.standingDocumentVersion.create({
      data: { documentId: doc.id, versionNo: 1, fileKey: policy.documentKey, fileName: policy.documentKey, isCurrent: true, changeNote: 'Imported reference to the existing insurance record.' },
    })
    created++
  }

  // Registration evidence — one library entry per firm registration profile.
  const registration = await prisma.registrationProfile.findUnique({
    where: { consultingFirmId },
    select: { samStatus: true, samExpiryDate: true, uei: true, cageCode: true, ownerUserId: true },
  })
  if (registration) {
    const existing = await prisma.standingDocument.findFirst({
      where: { consultingFirmId, sourceSystem: 'REGISTRATION' },
      select: { id: true },
    })
    const data = {
      category: StandingDocumentCategory.REGISTRATION,
      name: `SAM.gov registration${registration.uei ? ` (UEI ${registration.uei})` : ''}`,
      description: `SAM status ${registration.samStatus}${registration.cageCode ? `, CAGE ${registration.cageCode}` : ''}`,
      expiryDate: registration.samExpiryDate,
      ownerUserId: registration.ownerUserId,
      verification: registration.samStatus === 'ACTIVE' ? DocumentVerificationState.VERIFIED : DocumentVerificationState.UNVERIFIED,
      verifiedAt: registration.samStatus === 'ACTIVE' ? now : null,
    }
    if (existing) {
      await prisma.standingDocument.update({ where: { id: existing.id }, data })
      updated++
    } else {
      const doc = await prisma.standingDocument.create({
        data: { consultingFirmId, ...data, sourceSystem: 'REGISTRATION', sourceRecordId: consultingFirmId, tags: ['registration', 'sam'], currentVersionNo: 1 },
      })
      await prisma.standingDocumentVersion.create({
        data: { documentId: doc.id, versionNo: 1, isCurrent: true, changeNote: 'Imported reference to the firm registration profile.' },
      })
      created++
    }
  } else {
    skipped++
  }

  return { created, updated, skipped }
}

export interface DocumentHealth {
  id: string
  name: string
  category: StandingDocumentCategory
  expiryDate: Date | null
  expiryState: ExpiryState
  expiryMessage: string
  approvedForReuse: boolean
  verification: DocumentVerificationState
  usageCount: number
  sourceSystem: string | null
  /** How many times this document has been superseded. A version resets approval. */
  currentVersionNo: number
}

/**
 * Library health for a firm, optionally evaluated against one opportunity's
 * lifecycle so expiry is measured against real dates rather than "today".
 */
export async function getLibraryHealth(
  consultingFirmId: string,
  lifecycle: LifecycleDates = {},
  now: Date = new Date(),
): Promise<DocumentHealth[]> {
  const documents = await prisma.standingDocument.findMany({
    where: { consultingFirmId, isArchived: false },
    select: {
      id: true, name: true, category: true, expiryDate: true, approvedForReuse: true,
      verification: true, sourceSystem: true, currentVersionNo: true,
      _count: { select: { links: true } },
    },
    orderBy: [{ expiryDate: 'asc' }, { name: 'asc' }],
  })

  return documents.map((doc) => {
    const check = checkExpiryAgainstLifecycle({ expiryDate: doc.expiryDate, lifecycle, now })
    return {
      id: doc.id,
      name: doc.name,
      category: doc.category,
      expiryDate: doc.expiryDate,
      expiryState: check.state,
      expiryMessage: check.message,
      approvedForReuse: doc.approvedForReuse,
      verification: doc.verification,
      usageCount: doc._count.links,
      sourceSystem: doc.sourceSystem,
      currentVersionNo: doc.currentVersionNo,
    }
  })
}

/** Add a new version. The prior version is retained; nothing is overwritten. */
export async function addDocumentVersion(
  consultingFirmId: string,
  documentId: string,
  version: { fileKey?: string | null; fileName?: string | null; fileType?: string | null; fileSize?: number | null; fileHash?: string | null; pageCount?: number | null; changeNote?: string | null; uploadedByUserId?: string | null },
) {
  const doc = await prisma.standingDocument.findFirst({
    where: { id: documentId, consultingFirmId },
    select: { id: true, currentVersionNo: true },
  })
  if (!doc) throw new Error('Document not found')

  const nextVersion = doc.currentVersionNo + 1
  return prisma.$transaction(async (tx) => {
    await tx.standingDocumentVersion.updateMany({ where: { documentId: doc.id }, data: { isCurrent: false } })
    const created = await tx.standingDocumentVersion.create({
      data: { documentId: doc.id, versionNo: nextVersion, isCurrent: true, ...version },
    })
    await tx.standingDocument.update({
      where: { id: doc.id },
      data: {
        currentVersionNo: nextVersion,
        // A new version invalidates the prior approval — it must be re-approved.
        approvedForReuse: false,
        approvedByUserId: null,
        approvedAt: null,
        verification: DocumentVerificationState.UNVERIFIED,
        verifiedByUserId: null,
        verifiedAt: null,
      },
    })
    return created
  })
}

/** Where a document is used. Powers the "see where this is used" view. */
export async function getDocumentUsage(consultingFirmId: string, documentId: string) {
  return prisma.standingDocumentLink.findMany({
    where: { consultingFirmId, documentId },
    orderBy: { createdAt: 'desc' },
  })
}

export async function linkDocument(
  consultingFirmId: string,
  args: { documentId: string; targetType: string; targetId: string; opportunityId?: string | null; note?: string | null; linkedByUserId?: string | null },
) {
  const doc = await prisma.standingDocument.findFirst({ where: { id: args.documentId, consultingFirmId }, select: { id: true } })
  if (!doc) throw new Error('Document not found')
  return prisma.standingDocumentLink.upsert({
    where: { documentId_targetType_targetId: { documentId: args.documentId, targetType: args.targetType, targetId: args.targetId } },
    create: {
      consultingFirmId,
      documentId: args.documentId,
      targetType: args.targetType,
      targetId: args.targetId,
      opportunityId: args.opportunityId ?? null,
      note: args.note ?? null,
      linkedByUserId: args.linkedByUserId ?? null,
    },
    update: { note: args.note ?? null },
  })
}

export type StandingDocumentJson = Prisma.InputJsonValue

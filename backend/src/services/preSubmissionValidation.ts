// =============================================================
// §6.3E — Pre-submission validation.
//
// Extends the existing Submission Workspace validation (§5) into an evidence-
// preserving, versioned check suite.
//
// The governing rule: NEVER claim a document passed a check the system did not
// actually perform. Every check declares its method:
//   AUTOMATED    — the system genuinely inspected the file
//   MANUAL       — a human must confirm; recorded with user + timestamp
//   UNSUPPORTED  — the check cannot be performed on this file type, and says so
//
// Checks are APPEND-ONLY. Revalidation writes a new runId; prior evidence is
// never erased.
// =============================================================
import { createHash, randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'
import { Prisma, ValidationOutcome } from '@prisma/client'
import { prisma } from '../config/database'
import { checkExpiryAgainstLifecycle, type LifecycleDates } from './documentExpiry'

export const VALIDATOR_VERSION = 'v1'
const UPLOAD_DIR = path.join(process.cwd(), 'uploads')

export interface CheckDefinition {
  key: string
  label: string
  /** Whether this check can be performed automatically at all. */
  automatable: boolean
  note?: string
}

/**
 * The full published check catalogue. `automatable: false` entries are shown to
 * users as explicitly unsupported rather than quietly omitted, so nobody
 * assumes a check ran that did not.
 */
export const CHECK_CATALOGUE: CheckDefinition[] = [
  { key: 'FILE_PRESENT', label: 'Required file is attached', automatable: true },
  { key: 'FILE_EXISTS_ON_DISK', label: 'Attached file is retrievable', automatable: true },
  { key: 'FILE_EXTENSION', label: 'File extension matches the requirement', automatable: true },
  { key: 'FILE_NAME_PATTERN', label: 'File name matches the required pattern', automatable: true },
  { key: 'FILE_SIZE', label: 'File size is within the limit', automatable: true },
  { key: 'PDF_PAGE_COUNT', label: 'PDF page count is within the limit', automatable: true, note: 'PDF only. Counted from the document structure.' },
  { key: 'DOCX_PAGE_COUNT', label: 'DOCX page count', automatable: false, note: 'A .docx file stores no reliable page count — pagination depends on the renderer. Confirm manually against a PDF export.' },
  { key: 'FONT_FAMILY', label: 'Font family', automatable: false, note: 'Font inspection is not performed. Confirm manually.' },
  { key: 'FONT_SIZE', label: 'Font size', automatable: false, note: 'Font inspection is not performed. Confirm manually.' },
  { key: 'MARGINS', label: 'Page margins', automatable: false, note: 'Margin inspection is not performed. Confirm manually.' },
  { key: 'SIGNATURE_PRESENT', label: 'Required signature', automatable: false, note: 'No cryptographic or structural signature is verifiable on this file, so this must be confirmed by a person.' },
  { key: 'REQUIRED_FORM_VERSION', label: 'Required form and version', automatable: false, note: 'Confirm the form edition manually against the solicitation.' },
  { key: 'DUPLICATE_DOCUMENT', label: 'No duplicate document attached', automatable: true },
  { key: 'FINAL_APPROVED_VERSION', label: 'Attached version is the approved one', automatable: false, note: 'Confirm this is the approved final version.' },
  { key: 'CERTIFICATION_VALID', label: 'Certification is not expired', automatable: true },
  { key: 'INSURANCE_COVERAGE_WINDOW', label: 'Insurance covers the required date', automatable: true },
  { key: 'DOCUMENT_COVERS_POP', label: 'Document does not expire during the performance period', automatable: true },
  { key: 'AMENDMENT_ACKNOWLEDGED', label: 'All amendments acknowledged', automatable: true },
  { key: 'MANDATORY_ITEM_COMPLETE', label: 'Mandatory checklist item is complete', automatable: true },
]

export function getCheck(key: string): CheckDefinition | undefined {
  return CHECK_CATALOGUE.find((c) => c.key === key)
}

export interface CheckRecord {
  checkKey: string
  checkLabel: string
  outcome: ValidationOutcome
  method: 'AUTOMATED' | 'MANUAL' | 'UNSUPPORTED'
  expected: string | null
  actual: string | null
  evidence: string | null
  message: string
  isMandatory: boolean
  isBlocking: boolean
  checklistItemId: string | null
}

/**
 * Count pages in a PDF by scanning its object structure. Returns null when the
 * file is not a readable PDF — never a guess.
 */
export function countPdfPages(buffer: Buffer): number | null {
  const header = buffer.subarray(0, 5).toString('latin1')
  if (!header.startsWith('%PDF-')) return null
  const text = buffer.toString('latin1')

  // Prefer the page-tree /Count, which is authoritative.
  const counts = [...text.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]))
  if (counts.length > 0) {
    const max = Math.max(...counts)
    if (Number.isFinite(max) && max > 0) return max
  }
  // Fall back to counting page objects.
  const pageObjects = (text.match(/\/Type\s*\/Page\b(?!s)/g) ?? []).length
  return pageObjects > 0 ? pageObjects : null
}

function safeReadUpload(key: string): Buffer | null {
  try {
    // Contain reads to the uploads root — a stored key must never escape it.
    const resolved = path.resolve(UPLOAD_DIR, key)
    if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) return null
    if (!fs.existsSync(resolved)) return null
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) return null
    return fs.readFileSync(resolved)
  } catch {
    return null
  }
}

export function fileStat(key: string): { exists: boolean; size: number | null; hash: string | null } {
  const buf = safeReadUpload(key)
  if (!buf) return { exists: false, size: null, hash: null }
  return { exists: true, size: buf.length, hash: createHash('sha256').update(buf).digest('hex') }
}

export interface ItemRequirements {
  expectedExtensions?: string[] | null
  expectedNameIncludes?: string | null
  maxSizeBytes?: number | null
  maxPageCount?: number | null
  requiresSignature?: boolean
  requiresFormVersion?: string | null
}

/**
 * Parse per-item requirements from the checklist item's own description.
 * Deliberately conservative: only unambiguous directives are recognised, so a
 * check is never invented from vague prose.
 */
export function parseItemRequirements(description: string | null): ItemRequirements {
  const req: ItemRequirements = {}
  if (!description) return req

  const ext = /\b(?:must be|submit as|format:?)\s+(?:an?\s+)?\.?(pdf|docx?|xlsx?|zip)\b/i.exec(description)
  if (ext) req.expectedExtensions = [ext[1].toLowerCase()]

  const pages = /\b(?:not exceed|no more than|maximum of|limit(?:ed)? to)\s+(\d{1,3})\s+pages?\b/i.exec(description)
  if (pages) req.maxPageCount = Number(pages[1])

  const nameToken = /\bfile name (?:must )?(?:include|contain)s?\s+"([^"]+)"/i.exec(description)
  if (nameToken) req.expectedNameIncludes = nameToken[1]

  const mb = /\b(?:max(?:imum)?|not exceed)\s+(\d{1,4})\s*MB\b/i.exec(description)
  if (mb) req.maxSizeBytes = Number(mb[1]) * 1024 * 1024

  if (/\bsigned|signature\b/i.test(description)) req.requiresSignature = true

  const form = /\b(SF-?\d{2,4}|Standard Form \d+)\b/i.exec(description)
  if (form) req.requiresFormVersion = form[1]

  return req
}

/** Runs every automatable check for one checklist item. */
export function validateItem(
  item: {
    id: string
    title: string
    description: string | null
    itemType: string
    isMandatory: boolean
    status: string
    attachmentKey: string | null
    attachmentName: string | null
  },
  seenHashes: Map<string, string>,
): CheckRecord[] {
  const records: CheckRecord[] = []
  const requirements = parseItemRequirements(item.description)
  const needsDocument = ['DOCUMENT', 'FORM', 'CERTIFICATION', 'ATTACHMENT'].includes(item.itemType)

  const add = (
    checkKey: string,
    outcome: ValidationOutcome,
    message: string,
    extra: Partial<CheckRecord> = {},
  ) => {
    const def = getCheck(checkKey)
    records.push({
      checkKey,
      checkLabel: def?.label ?? checkKey,
      outcome,
      method: outcome === ValidationOutcome.UNSUPPORTED ? 'UNSUPPORTED' : outcome === ValidationOutcome.MANUAL_REQUIRED ? 'MANUAL' : 'AUTOMATED',
      expected: null, actual: null, evidence: null,
      message,
      isMandatory: item.isMandatory,
      isBlocking: item.isMandatory && outcome === ValidationOutcome.FAILED,
      checklistItemId: item.id,
      ...extra,
    })
  }

  // --- presence ----------------------------------------------------
  if (!item.attachmentKey) {
    if (needsDocument) {
      add('FILE_PRESENT', ValidationOutcome.FAILED, 'No file is attached to this required document item.', { expected: 'A file attachment', actual: 'none' })
    } else {
      add('FILE_PRESENT', ValidationOutcome.NOT_APPLICABLE, `This item is a ${item.itemType} and does not require a file attachment.`)
      add('MANDATORY_ITEM_COMPLETE',
        ['COMPLETE', 'VALIDATED', 'NA'].includes(item.status) ? ValidationOutcome.PASSED : item.isMandatory ? ValidationOutcome.FAILED : ValidationOutcome.MANUAL_REQUIRED,
        `Item status is ${item.status}.`, { expected: 'COMPLETE', actual: item.status })
    }
    return records
  }

  add('FILE_PRESENT', ValidationOutcome.PASSED, `A file is attached: ${item.attachmentName ?? item.attachmentKey}.`, { actual: item.attachmentName })

  const stat = fileStat(item.attachmentKey)
  if (!stat.exists) {
    add('FILE_EXISTS_ON_DISK', ValidationOutcome.FAILED, 'The attached file could not be retrieved from storage. Re-upload it before submitting.')
    return records
  }
  add('FILE_EXISTS_ON_DISK', ValidationOutcome.PASSED, `File retrieved successfully (${stat.size} bytes).`, {
    actual: `${stat.size} bytes`, evidence: `sha256:${stat.hash?.slice(0, 16)}…`,
  })

  const name = (item.attachmentName ?? item.attachmentKey).toLowerCase()

  // --- extension ---------------------------------------------------
  if (requirements.expectedExtensions?.length) {
    const ok = requirements.expectedExtensions.some((e) => name.endsWith(`.${e}`))
    add('FILE_EXTENSION', ok ? ValidationOutcome.PASSED : ValidationOutcome.FAILED,
      ok ? `File extension matches the required ${requirements.expectedExtensions.join('/')} format.` : `File is not one of the required formats: ${requirements.expectedExtensions.join(', ')}.`,
      { expected: requirements.expectedExtensions.join(', '), actual: path.extname(name) || 'none' })
  }

  // --- name pattern -------------------------------------------------
  if (requirements.expectedNameIncludes) {
    const ok = name.includes(requirements.expectedNameIncludes.toLowerCase())
    add('FILE_NAME_PATTERN', ok ? ValidationOutcome.PASSED : ValidationOutcome.FAILED,
      ok ? 'File name contains the required token.' : `File name does not contain "${requirements.expectedNameIncludes}".`,
      { expected: requirements.expectedNameIncludes, actual: item.attachmentName })
  }

  // --- size ---------------------------------------------------------
  if (requirements.maxSizeBytes && stat.size !== null) {
    const ok = stat.size <= requirements.maxSizeBytes
    add('FILE_SIZE', ok ? ValidationOutcome.PASSED : ValidationOutcome.FAILED,
      ok ? 'File size is within the stated limit.' : `File is ${stat.size} bytes, over the ${requirements.maxSizeBytes}-byte limit.`,
      { expected: `<= ${requirements.maxSizeBytes} bytes`, actual: `${stat.size} bytes` })
  }

  // --- page count ---------------------------------------------------
  if (requirements.maxPageCount) {
    if (name.endsWith('.pdf')) {
      const buf = safeReadUpload(item.attachmentKey)
      const pages = buf ? countPdfPages(buf) : null
      if (pages === null) {
        add('PDF_PAGE_COUNT', ValidationOutcome.MANUAL_REQUIRED,
          'The page count could not be read from this PDF, so the page limit has not been checked. Confirm it manually.',
          { expected: `<= ${requirements.maxPageCount} pages` })
      } else {
        const ok = pages <= requirements.maxPageCount
        add('PDF_PAGE_COUNT', ok ? ValidationOutcome.PASSED : ValidationOutcome.FAILED,
          ok ? `PDF has ${pages} page(s), within the ${requirements.maxPageCount}-page limit.` : `PDF has ${pages} page(s), over the ${requirements.maxPageCount}-page limit.`,
          { expected: `<= ${requirements.maxPageCount} pages`, actual: `${pages} pages`, evidence: 'Counted from the PDF page tree.' })
      }
    } else if (/\.docx?$/.test(name)) {
      // A .docx has no reliable page count — this is stated, never faked.
      add('DOCX_PAGE_COUNT', ValidationOutcome.UNSUPPORTED,
        `${getCheck('DOCX_PAGE_COUNT')?.note} The ${requirements.maxPageCount}-page limit has NOT been verified.`,
        { expected: `<= ${requirements.maxPageCount} pages` })
    } else {
      add('PDF_PAGE_COUNT', ValidationOutcome.UNSUPPORTED,
        `Page count cannot be read from this file type. The ${requirements.maxPageCount}-page limit has NOT been verified.`,
        { expected: `<= ${requirements.maxPageCount} pages` })
    }
  }

  // --- typography / layout: honestly unsupported ---------------------
  for (const key of ['FONT_FAMILY', 'FONT_SIZE', 'MARGINS'] as const) {
    if (item.description && new RegExp(key === 'MARGINS' ? 'margin' : 'font', 'i').test(item.description)) {
      add(key, ValidationOutcome.UNSUPPORTED, `${getCheck(key)?.note} This requirement has NOT been verified by the system.`)
    }
  }

  // --- signature -----------------------------------------------------
  if (requirements.requiresSignature) {
    add('SIGNATURE_PRESENT', ValidationOutcome.MANUAL_REQUIRED, getCheck('SIGNATURE_PRESENT')?.note ?? 'Confirm the signature manually.')
  }
  if (requirements.requiresFormVersion) {
    add('REQUIRED_FORM_VERSION', ValidationOutcome.MANUAL_REQUIRED,
      `Confirm this is the correct edition of ${requirements.requiresFormVersion}.`, { expected: requirements.requiresFormVersion })
  }

  // --- duplicates -----------------------------------------------------
  if (stat.hash) {
    const priorItemId = seenHashes.get(stat.hash)
    if (priorItemId && priorItemId !== item.id) {
      add('DUPLICATE_DOCUMENT', ValidationOutcome.FAILED,
        'This file is byte-identical to a file attached to another checklist item. Confirm the right document is attached to each.',
        { evidence: `Duplicate of checklist item ${priorItemId}` })
    } else {
      seenHashes.set(stat.hash, item.id)
      add('DUPLICATE_DOCUMENT', ValidationOutcome.PASSED, 'No other checklist item has this exact file attached.')
    }
  }

  add('FINAL_APPROVED_VERSION', ValidationOutcome.MANUAL_REQUIRED, getCheck('FINAL_APPROVED_VERSION')?.note ?? 'Confirm this is the approved final version.')

  return records
}

export interface ValidationRunResult {
  runId: string
  submissionId: string
  checks: CheckRecord[]
  passed: number
  failed: number
  manualRequired: number
  unsupported: number
  notApplicable: number
  blockingFailures: number
  /** Readiness is affected only by FAILED mandatory checks. */
  readinessBlocked: boolean
  validatorVersion: string
  performedAt: string
}

/**
 * Validate a whole submission and persist the evidence.
 * Append-only: a new runId is written each time; previous evidence survives.
 */
export async function runSubmissionValidation(
  consultingFirmId: string,
  submissionId: string,
  options: { actorUserId?: string | null; now?: Date } = {},
): Promise<ValidationRunResult> {
  const now = options.now ?? new Date()
  const runId = randomUUID()

  const submission = await prisma.proposalSubmission.findFirst({
    where: { id: submissionId, consultingFirmId },
    select: {
      id: true, opportunityId: true, finalDeadline: true,
      items: {
        select: {
          id: true, title: true, description: true, itemType: true, isMandatory: true,
          status: true, attachmentKey: true, attachmentName: true,
        },
        orderBy: { sortOrder: 'asc' },
      },
    },
  })
  if (!submission) throw new Error('Submission not found')

  const checks: CheckRecord[] = []
  const seenHashes = new Map<string, string>()
  for (const item of submission.items) {
    checks.push(...validateItem(item, seenHashes))
  }

  // --- amendment acknowledgement -------------------------------------
  const unacknowledged = await prisma.amendmentRevision.count({
    where: { consultingFirmId, opportunityId: submission.opportunityId, acknowledgedAt: null },
  })
  checks.push({
    checkKey: 'AMENDMENT_ACKNOWLEDGED',
    checkLabel: getCheck('AMENDMENT_ACKNOWLEDGED')!.label,
    outcome: unacknowledged === 0 ? ValidationOutcome.PASSED : ValidationOutcome.FAILED,
    method: 'AUTOMATED',
    expected: 'All tracked amendments acknowledged',
    actual: `${unacknowledged} unacknowledged`,
    evidence: null,
    message: unacknowledged === 0
      ? 'Every tracked amendment on this opportunity has been acknowledged.'
      : `${unacknowledged} tracked amendment(s) have not been acknowledged. Most solicitations treat unacknowledged amendments as grounds for rejection.`,
    isMandatory: true,
    isBlocking: unacknowledged > 0,
    checklistItemId: null,
  })

  // --- certification + insurance expiry against the lifecycle --------
  const lifecycle = await loadLifecycle(consultingFirmId, submission.opportunityId, submission.finalDeadline)

  const certifications = await prisma.certification.findMany({
    where: { consultingFirmId, isArchived: false },
    select: { id: true, name: true, expiryDate: true },
  })
  for (const cert of certifications) {
    const result = checkExpiryAgainstLifecycle({ expiryDate: cert.expiryDate, lifecycle, now })
    if (result.state === 'VALID' || result.state === 'NO_EXPIRY') continue
    checks.push({
      checkKey: result.state === 'EXPIRED' ? 'CERTIFICATION_VALID' : 'DOCUMENT_COVERS_POP',
      checkLabel: result.state === 'EXPIRED' ? getCheck('CERTIFICATION_VALID')!.label : getCheck('DOCUMENT_COVERS_POP')!.label,
      outcome: result.state === 'INSUFFICIENT_DATA' ? ValidationOutcome.MANUAL_REQUIRED : result.isBlocking ? ValidationOutcome.FAILED : ValidationOutcome.MANUAL_REQUIRED,
      method: result.state === 'INSUFFICIENT_DATA' ? 'MANUAL' : 'AUTOMATED',
      expected: result.comparedDate ? `Valid through ${result.comparedDate.toISOString().slice(0, 10)}` : null,
      actual: cert.expiryDate ? cert.expiryDate.toISOString().slice(0, 10) : 'no expiry recorded',
      evidence: `Certification record ${cert.id}`,
      message: `${cert.name}: ${result.message}`,
      isMandatory: true,
      isBlocking: result.isBlocking,
      checklistItemId: null,
    })
  }

  const policies = await prisma.insurancePolicy.findMany({
    where: { consultingFirmId, isArchived: false },
    select: { id: true, policyType: true, expiryDate: true },
  })
  for (const policy of policies) {
    const result = checkExpiryAgainstLifecycle({ expiryDate: policy.expiryDate, lifecycle, now })
    if (result.state === 'VALID' || result.state === 'NO_EXPIRY') continue
    checks.push({
      checkKey: 'INSURANCE_COVERAGE_WINDOW',
      checkLabel: getCheck('INSURANCE_COVERAGE_WINDOW')!.label,
      outcome: result.state === 'INSUFFICIENT_DATA' ? ValidationOutcome.MANUAL_REQUIRED : result.isBlocking ? ValidationOutcome.FAILED : ValidationOutcome.MANUAL_REQUIRED,
      method: result.state === 'INSUFFICIENT_DATA' ? 'MANUAL' : 'AUTOMATED',
      expected: result.comparedDate ? `Coverage through ${result.comparedDate.toISOString().slice(0, 10)}` : null,
      actual: policy.expiryDate ? policy.expiryDate.toISOString().slice(0, 10) : 'no expiry recorded',
      evidence: `Insurance policy record ${policy.id}`,
      message: `${policy.policyType}: ${result.message}`,
      isMandatory: true,
      isBlocking: result.isBlocking,
      checklistItemId: null,
    })
  }

  // Persist — a new run, never a replacement of prior evidence.
  await prisma.submissionValidationCheck.createMany({
    data: checks.map((c) => ({
      consultingFirmId,
      submissionId,
      checklistItemId: c.checklistItemId,
      checkKey: c.checkKey,
      checkLabel: c.checkLabel,
      outcome: c.outcome,
      method: c.method,
      expected: c.expected,
      actual: c.actual,
      evidence: c.evidence,
      message: c.message,
      isMandatory: c.isMandatory,
      isBlocking: c.isBlocking,
      validatorVersion: VALIDATOR_VERSION,
      runId,
      performedByUserId: options.actorUserId ?? null,
      performedAt: now,
    })) as Prisma.SubmissionValidationCheckCreateManyInput[],
  })

  const passed = checks.filter((c) => c.outcome === ValidationOutcome.PASSED).length
  const failed = checks.filter((c) => c.outcome === ValidationOutcome.FAILED).length
  const manualRequired = checks.filter((c) => c.outcome === ValidationOutcome.MANUAL_REQUIRED).length
  const unsupported = checks.filter((c) => c.outcome === ValidationOutcome.UNSUPPORTED).length
  const notApplicable = checks.filter((c) => c.outcome === ValidationOutcome.NOT_APPLICABLE).length
  const blockingFailures = checks.filter((c) => c.isBlocking).length

  return {
    runId, submissionId, checks,
    passed, failed, manualRequired, unsupported, notApplicable, blockingFailures,
    readinessBlocked: blockingFailures > 0,
    validatorVersion: VALIDATOR_VERSION,
    performedAt: now.toISOString(),
  }
}

/** Assemble the award lifecycle dates for expiry comparison. */
export async function loadLifecycle(
  consultingFirmId: string,
  opportunityId: string,
  finalDeadline: Date | null,
): Promise<LifecycleDates> {
  const [opportunity, contract, awardMilestone, forecast] = await Promise.all([
    prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: { responseDeadline: true } }),
    prisma.contract.findFirst({
      where: { consultingFirmId, opportunityId },
      select: { startDate: true, endDate: true, optionPeriods: { select: { endDate: true } } },
    }),
    prisma.opportunityMilestone.findFirst({
      where: { consultingFirmId, opportunityId, milestoneType: 'ANTICIPATED_AWARD' },
      select: { startAt: true },
    }),
    prisma.agencyForecast.findFirst({
      where: { consultingFirmId, linkedOpportunityId: opportunityId },
      select: { anticipatedAwardDate: true },
    }),
  ])

  const optionEnds = (contract?.optionPeriods ?? []).map((o) => o.endDate).filter((d): d is Date => d instanceof Date).sort((a, b) => a.getTime() - b.getTime())

  return {
    proposalDeadline: finalDeadline ?? opportunity?.responseDeadline ?? null,
    anticipatedAward: awardMilestone?.startAt ?? forecast?.anticipatedAwardDate ?? null,
    contractStart: contract?.startDate ?? null,
    basePeriodEnd: contract?.endDate ?? null,
    optionPeriodEnds: optionEnds,
    fullPeriodEnd: optionEnds[optionEnds.length - 1] ?? contract?.endDate ?? null,
  }
}

/** Record a human confirmation for a MANUAL_REQUIRED / UNSUPPORTED check. */
export async function recordManualCheck(
  consultingFirmId: string,
  submissionId: string,
  args: { checkKey: string; checklistItemId?: string | null; outcome: 'PASSED' | 'FAILED'; note: string; actorUserId: string; now?: Date },
) {
  const now = args.now ?? new Date()
  const def = getCheck(args.checkKey)
  return prisma.submissionValidationCheck.create({
    data: {
      consultingFirmId,
      submissionId,
      checklistItemId: args.checklistItemId ?? null,
      checkKey: args.checkKey,
      checkLabel: def?.label ?? args.checkKey,
      outcome: args.outcome === 'PASSED' ? ValidationOutcome.PASSED : ValidationOutcome.FAILED,
      // Truthfully recorded as a human judgement, with who and when.
      method: 'MANUAL',
      evidence: `Manually confirmed by user ${args.actorUserId} on ${now.toISOString()}`,
      message: args.note,
      isMandatory: true,
      isBlocking: args.outcome === 'FAILED',
      validatorVersion: VALIDATOR_VERSION,
      runId: `manual-${randomUUID()}`,
      performedByUserId: args.actorUserId,
      performedAt: now,
    },
  })
}

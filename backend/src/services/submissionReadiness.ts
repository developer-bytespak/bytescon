// =============================================================
// Submission readiness (§5.1 Stage 7). Pure, deterministic, backend-authoritative
// so readiness is unit-testable and never computed on the frontend. Completion %
// and readiness state are DISTINCT: a submission with 100% completion is still not
// READY_TO_SUBMIT while an unresolved blocker or an incomplete mandatory item
// remains.
// =============================================================
export const COMPLETE_ITEM_STATES = ['COMPLETE', 'VALIDATED', 'NA'] as const
export const CHECKLIST_ITEM_TYPES = ['PROPOSAL_SECTION', 'DOCUMENT', 'FORM', 'CERTIFICATION', 'SIGNATURE', 'ATTACHMENT', 'FILE_VALIDATION', 'SUBMISSION_CONFIRMATION', 'OTHER'] as const

export interface ReadinessItem {
  status: string
  isMandatory: boolean
  isBlocker: boolean
  dueDate?: Date | null
}

export interface Readiness {
  total: number
  complete: number
  overallPercent: number
  mandatoryTotal: number
  mandatoryComplete: number
  mandatoryPercent: number
  blockerCount: number
  incompleteMandatoryCount: number
  overdueCount: number
  canBeReady: boolean
  blockingReasons: string[]
}

const isComplete = (s: string) => (COMPLETE_ITEM_STATES as readonly string[]).includes(s)

export function computeReadiness(items: ReadinessItem[], now: Date = new Date()): Readiness {
  const total = items.length
  const complete = items.filter((i) => isComplete(i.status)).length
  const mandatory = items.filter((i) => i.isMandatory)
  const mandatoryComplete = mandatory.filter((i) => isComplete(i.status)).length
  const blockers = items.filter((i) => i.isBlocker && !isComplete(i.status))
  const incompleteMandatory = mandatory.filter((i) => !isComplete(i.status))
  const overdue = items.filter((i) => i.dueDate && i.dueDate.getTime() < now.getTime() && !isComplete(i.status))

  const blockingReasons: string[] = []
  if (incompleteMandatory.length > 0) blockingReasons.push(`${incompleteMandatory.length} mandatory item(s) incomplete`)
  if (blockers.length > 0) blockingReasons.push(`${blockers.length} unresolved blocker(s)`)

  return {
    total,
    complete,
    overallPercent: total ? Math.round((complete / total) * 100) : 0,
    mandatoryTotal: mandatory.length,
    mandatoryComplete,
    mandatoryPercent: mandatory.length ? Math.round((mandatoryComplete / mandatory.length) * 100) : 100,
    blockerCount: blockers.length,
    incompleteMandatoryCount: incompleteMandatory.length,
    overdueCount: overdue.length,
    canBeReady: incompleteMandatory.length === 0 && blockers.length === 0,
    blockingReasons,
  }
}

export interface ValidationInput {
  itemType: string
  attachmentKey: string | null
  attachmentName: string | null
  fileExists: boolean
  fileSize?: number | null
  expectedExtensions?: string[] | null // e.g. ['pdf']
  expectedNameIncludes?: string | null
  maxSizeBytes?: number | null
}
export interface ValidationResult {
  state: 'PASSED' | 'FAILED' | 'MANUAL_REQUIRED'
  evidence: string
}

// Validate ONLY what can be reliably verified from stored metadata. Everything
// else honestly reports MANUAL_REQUIRED — never a claim the system can't back.
export function validateDocumentItem(input: ValidationInput): ValidationResult {
  const needsDoc = ['DOCUMENT', 'FORM', 'CERTIFICATION', 'ATTACHMENT'].includes(input.itemType)
  if (needsDoc && !input.attachmentKey) return { state: 'FAILED', evidence: 'Required document is missing (no file attached).' }
  if (!input.attachmentKey) return { state: 'MANUAL_REQUIRED', evidence: 'No attachment — manual verification required for this item type.' }
  if (!input.fileExists) return { state: 'FAILED', evidence: 'Attached file is not present on disk.' }

  const name = (input.attachmentName ?? '').toLowerCase()
  if (input.expectedExtensions && input.expectedExtensions.length > 0) {
    const ok = input.expectedExtensions.some((e) => name.endsWith(`.${e.toLowerCase().replace(/^\./, '')}`))
    if (!ok) return { state: 'FAILED', evidence: `File type does not match required extension(s): ${input.expectedExtensions.join(', ')}.` }
  }
  if (input.expectedNameIncludes && !name.includes(input.expectedNameIncludes.toLowerCase())) {
    return { state: 'FAILED', evidence: `File name does not contain the required token "${input.expectedNameIncludes}".` }
  }
  if (input.maxSizeBytes && input.fileSize != null && input.fileSize > input.maxSizeBytes) {
    return { state: 'FAILED', evidence: `File exceeds the maximum size of ${input.maxSizeBytes} bytes.` }
  }
  // Page-count, signature presence, and content correctness cannot be read reliably.
  if (['SIGNATURE', 'FILE_VALIDATION'].includes(input.itemType)) {
    return { state: 'MANUAL_REQUIRED', evidence: 'File present; signature/page-content checks require manual verification.' }
  }
  return { state: 'PASSED', evidence: `File present${input.attachmentName ? ` (${input.attachmentName})` : ''} and metadata checks passed.` }
}

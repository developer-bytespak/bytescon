// =============================================================
// GB-107 shared types
// =============================================================

export const GB107_STATUS = {
  QUEUED: 'QUEUED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  NOT_FOUND: 'NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
} as const

export type Gb107Status = (typeof GB107_STATUS)[keyof typeof GB107_STATUS]

/** extractionMethod marker on MatrixRequirement rows this module owns. */
export const GB107_EXTRACTION_METHOD = 'GB107_REGEX'

export type RequirementType =
  | 'FAR_CLAUSE'
  | 'DFARS_CLAUSE'
  | 'EVAL_FACTOR'
  | 'SUBMISSION_REQ'
  | 'DELIVERY_REQ'

export interface ExtractedRequirement {
  requirementType: RequirementType
  /** Bare clause code ("52.212-1") for clauses; null for keyword-derived items. */
  reference: string | null
  /** Short human label ("52.212-1 — Instructions to Offerors…", "Evaluation approach: best value"). */
  description: string
  isMandatory: boolean
  /** Up to ~500 chars of surrounding context from the solicitation text. */
  extractedText: string
}

export interface EnrichOutcome {
  status: Gb107Status
  message: string
  /** 'api' | 'sibling-copy' — set on COMPLETED. */
  source?: 'api' | 'sibling-copy'
  requirementsWritten?: number
}

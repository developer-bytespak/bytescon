// =============================================================
// §6.1D — Pre-solicitation notice classification.
//
// Deterministic mapping from a feed's notice-type string (and, only as a
// fallback, the title) onto the pre-solicitation kinds §6.1D tracks. Pure and
// side-effect free so it is fully unit-testable and gives identical results for
// identical inputs.
//
// It classifies. It does not claim that responding to a notice influences or
// guarantees anything — that wording lives in the presentation layer and is
// asserted by tests.
// =============================================================

export const PRESOLICITATION_KINDS = [
  'SOURCES_SOUGHT',
  'RFI',
  'SPECIAL_NOTICE',
  'DRAFT_RFP',
  'PRESOLICITATION',
  'INDUSTRY_DAY',
] as const

export type PresolicitationKind = (typeof PRESOLICITATION_KINDS)[number]

export interface NoticeClassification {
  /** Null when the notice is an active solicitation or cannot be classified. */
  kind: PresolicitationKind | null
  /** True only for the pre-solicitation kinds above. */
  isPreSolicitation: boolean
  /** Which input produced the classification — feed field or title fallback. */
  basis: 'NOTICE_TYPE' | 'TITLE' | 'NONE'
  label: string
  /**
   * Why an early response may matter. Phrased as opportunity, never as a
   * promise of influence or award.
   */
  whyEarlyResponseMayMatter: string | null
  /** Default alert priority for this notice kind. */
  suggestedPriority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
}

const LABELS: Record<PresolicitationKind, string> = {
  SOURCES_SOUGHT: 'Sources Sought',
  RFI: 'Request for Information',
  SPECIAL_NOTICE: 'Special Notice',
  DRAFT_RFP: 'Draft RFP',
  PRESOLICITATION: 'Presolicitation',
  INDUSTRY_DAY: 'Industry Day',
}

// Wording is deliberately conditional. Responding never guarantees influence,
// consideration, a set-aside decision, or an award.
const WHY: Record<PresolicitationKind, string> = {
  SOURCES_SOUGHT:
    'Agencies use sources-sought responses to gauge the market, which can inform the eventual set-aside decision. Responding does not guarantee influence, consideration, or award.',
  RFI:
    'An RFI response is an opportunity to describe your capability before requirements are fixed. Responding does not guarantee influence, consideration, or award.',
  SPECIAL_NOTICE:
    'Special notices often carry schedule, scope or process information ahead of a solicitation. Reviewing it early can inform your bid/no-bid timing. It does not guarantee influence or award.',
  DRAFT_RFP:
    'A draft RFP is the usual window for comment on instructions and evaluation criteria before they are finalised. Commenting does not guarantee changes, influence, or award.',
  PRESOLICITATION:
    'A presolicitation notice signals an expected solicitation, which gives more time for teaming and capture work. It does not guarantee that a solicitation will be issued.',
  INDUSTRY_DAY:
    'Industry days are a chance to hear requirements directly and meet potential partners. Attending does not guarantee influence, consideration, or award.',
}

const PRIORITY: Record<PresolicitationKind, NoticeClassification['suggestedPriority']> = {
  SOURCES_SOUGHT: 'HIGH',
  RFI: 'HIGH',
  DRAFT_RFP: 'HIGH',
  PRESOLICITATION: 'MEDIUM',
  INDUSTRY_DAY: 'MEDIUM',
  SPECIAL_NOTICE: 'LOW',
}

/** Ordered longest-first so "sources sought" wins before a bare "sources". */
const NOTICE_TYPE_PATTERNS: Array<[RegExp, PresolicitationKind]> = [
  [/pre[\s-]?proposal\s+conference|industry\s*day|vendor\s*day|industry\s*outreach/i, 'INDUSTRY_DAY'],
  [/sources\s*sought|market\s*survey|market\s*research/i, 'SOURCES_SOUGHT'],
  [/draft\s*(rfp|rfq|solicitation|pws|sow|statement)/i, 'DRAFT_RFP'],
  [/request\s+for\s+information|\brfi\b/i, 'RFI'],
  [/special\s*notice/i, 'SPECIAL_NOTICE'],
  [/pre[\s-]?solicitation|presol\b/i, 'PRESOLICITATION'],
]

function match(text: string | null | undefined): PresolicitationKind | null {
  if (!text) return null
  for (const [re, kind] of NOTICE_TYPE_PATTERNS) {
    if (re.test(text)) return kind
  }
  return null
}

/**
 * Classify a notice. `noticeType` (the feed's own field) is authoritative; the
 * title is only consulted when the feed supplied no usable notice type, and the
 * basis is reported so the UI can show how the classification was reached.
 */
export function classifyNotice(
  noticeType: string | null | undefined,
  title?: string | null,
): NoticeClassification {
  const fromType = match(noticeType)
  if (fromType) {
    return {
      kind: fromType,
      isPreSolicitation: true,
      basis: 'NOTICE_TYPE',
      label: LABELS[fromType],
      whyEarlyResponseMayMatter: WHY[fromType],
      suggestedPriority: PRIORITY[fromType],
    }
  }

  // Only fall back to the title when the feed gave no notice type at all. A
  // feed that says "Solicitation" is trusted over a title that mentions "RFI".
  if (!noticeType || !noticeType.trim()) {
    const fromTitle = match(title)
    if (fromTitle) {
      return {
        kind: fromTitle,
        isPreSolicitation: true,
        basis: 'TITLE',
        label: LABELS[fromTitle],
        whyEarlyResponseMayMatter: WHY[fromTitle],
        suggestedPriority: PRIORITY[fromTitle],
      }
    }
  }

  return {
    kind: null,
    isPreSolicitation: false,
    basis: 'NONE',
    label: noticeType?.trim() || 'Solicitation',
    whyEarlyResponseMayMatter: null,
    suggestedPriority: 'MEDIUM',
  }
}

export function isPresolicitationKind(value: string | null | undefined): value is PresolicitationKind {
  return Boolean(value) && (PRESOLICITATION_KINDS as readonly string[]).includes(value as string)
}

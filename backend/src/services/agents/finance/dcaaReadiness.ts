// =============================================================
// §7.8 — Timekeeping readiness checks.
//
// WHAT THIS IS, AND WHAT IT IS NOT
// ------------------------------------------------------------
// This is a Bytescon PRODUCT READINESS CHECKLIST over the firm's own
// timekeeping records. It is NOT a DCAA audit, NOT a certification, and NOT an
// opinion that an audit would pass. No output of this module may say
// "DCAA compliant", "DCAA approved", "DCAA certified" or "will pass audit" —
// only a government auditor can establish any of those, and the platform holds
// no such record.
//
// The thresholds below are Bytescon product policy. The codebase configures no
// timekeeping deadline, so rather than cite an official mandate we do not have,
// they are named as ours and pinned by tests.
//
// A rule the schema cannot answer returns UNSUPPORTED. A rule with nothing to
// judge returns INSUFFICIENT_DATA. Neither is a PASS — quietly grading an
// unanswerable question as a pass is how a readiness score becomes a lie.
// =============================================================
import { Prisma } from '@prisma/client'
import { workingDaysBetween, type WorkingCalendar } from '../../milestones/workingDays'

export const DCAA_RULE_VERSION = 'bytescon-readiness-v1'

/** The disclaimer that must travel with every readiness result. */
export const READINESS_DISCLAIMER =
  'Bytescon readiness indicator. This is a product checklist over your own timekeeping records — it is not a DCAA audit, certification or approval, and it does not predict an audit outcome.'

// -------------------------------------------------------------
// Product policy thresholds
// -------------------------------------------------------------

/**
 * Working days after the work date by which an entry should be submitted.
 *
 * Bytescon policy. Chosen conservatively to reflect the common expectation of
 * contemporaneous daily timekeeping without asserting a specific federal rule.
 */
export const SUBMISSION_TIMELINESS_WORKING_DAYS = 5

/** How far back a routine sweep looks. */
export const READINESS_LOOKBACK_DAYS = 45

export type Verdict = 'PASS' | 'FAIL' | 'WARNING' | 'MANUAL_REVIEW' | 'INSUFFICIENT_DATA' | 'UNSUPPORTED'
export type Severity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO'

export interface RuleResult {
  ruleKey: string
  ruleVersion: string
  title: string
  verdict: Verdict
  severity: Severity
  dataSufficiency: 'SUFFICIENT' | 'PARTIAL' | 'INSUFFICIENT_DATA'
  summary: string
  evidence: string[]
  sourceRecordIds: string[]
  recordsChecked: number
  recordsFailing: number
  limitations: string[]
}

/**
 * Rules whose failure is a critical readiness gap.
 *
 * Deliberately short. Labelling every warning critical would make the word
 * meaningless and bury the two findings that genuinely matter: time recorded
 * for work that has not happened, and adjustments with no reason recorded.
 */
export const CRITICAL_RULE_KEYS = ['NO_FUTURE_DATED_TIME', 'ADJUSTMENT_REASON_RECORDED'] as const

export const isCriticalRule = (ruleKey: string): boolean =>
  (CRITICAL_RULE_KEYS as readonly string[]).includes(ruleKey)

// -------------------------------------------------------------
// Inputs
// -------------------------------------------------------------

export interface ReadinessTimeEntry {
  id: string
  userId: string
  contractId: string
  laborCategory: string
  workDate: Date
  hours: Prisma.Decimal
  status: string
  submittedAt: Date | null
  approverUserId: string | null
  createdAt: Date
  updatedAt: Date
}

/** An AuditEvent row for a TimeEntry. The canonical adjustment trail. */
export interface ReadinessAuditEvent {
  id: string
  entityId: string | null
  action: string
  actorUserId: string | null
  rationale: string | null
  beforeJson: unknown
  afterJson: unknown
  createdAt: Date
}

export interface ReadinessInput {
  entries: ReadinessTimeEntry[]
  auditEvents: ReadinessAuditEvent[]
  periodStart: Date
  periodEnd: Date
  now: Date
  calendar: WorkingCalendar
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

// -------------------------------------------------------------
// Rule 1 — daily completeness
// -------------------------------------------------------------

/**
 * Did every person who charged time in the period record time on each working
 * day between their first and last charge?
 *
 * Bounded by the person's own first and last entry deliberately: someone who
 * joined mid-month or was on leave has not created a readiness gap, and
 * flagging them would train reviewers to ignore the rule.
 */
function ruleDailyCompleteness(input: ReadinessInput): RuleResult {
  const base = { ruleKey: 'DAILY_TIME_COMPLETENESS', ruleVersion: DCAA_RULE_VERSION, title: 'Daily time entry completeness', severity: 'MEDIUM' as Severity }
  const live = input.entries.filter((e) => e.status !== 'VOIDED')
  if (live.length === 0) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', dataSufficiency: 'INSUFFICIENT_DATA', summary: 'No time entries exist in this period, so completeness cannot be assessed.', evidence: [], sourceRecordIds: [], recordsChecked: 0, recordsFailing: 0, limitations: ['No time entries in the period.'] }
  }

  const byUser = new Map<string, ReadinessTimeEntry[]>()
  for (const e of live) {
    const list = byUser.get(e.userId) ?? []
    list.push(e)
    byUser.set(e.userId, list)
  }

  const evidence: string[] = []
  const sourceRecordIds: string[] = []
  let missingDays = 0

  for (const [userId, entries] of byUser) {
    const sorted = [...entries].sort((a, b) => a.workDate.getTime() - b.workDate.getTime())
    const charged = new Set(sorted.map((e) => dayKey(e.workDate)))
    const cursor = new Date(sorted[0].workDate)
    const last = sorted[sorted.length - 1].workDate
    const gaps: string[] = []
    while (cursor <= last) {
      const weekday = cursor.getUTCDay() === 0 ? 7 : cursor.getUTCDay()
      const isWorking = input.calendar.workingDays.includes(weekday) && !input.calendar.holidays.has(dayKey(cursor))
      if (isWorking && !charged.has(dayKey(cursor))) gaps.push(dayKey(cursor))
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    if (gaps.length > 0) {
      missingDays += gaps.length
      evidence.push(`User ${userId} charged no time on ${gaps.length} working day(s) between their first and last entry: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '…' : ''}.`)
      sourceRecordIds.push(...sorted.slice(0, 5).map((e) => e.id))
    }
  }

  return {
    ...base,
    verdict: missingDays === 0 ? 'PASS' : 'WARNING',
    dataSufficiency: 'SUFFICIENT',
    summary: missingDays === 0
      ? `Every person who charged time recorded it on each working day between their first and last entry (${byUser.size} person(s)).`
      : `${missingDays} working day(s) have no time recorded between a person's first and last charge.`,
    evidence,
    sourceRecordIds,
    recordsChecked: live.length,
    recordsFailing: missingDays,
    limitations: ['Absence, leave and non-working assignments are not modelled, so a genuine day off is indistinguishable from a missing entry.'],
  }
}

// -------------------------------------------------------------
// Rule 2 — timely submission
// -------------------------------------------------------------

function ruleTimelySubmission(input: ReadinessInput): RuleResult {
  const base = { ruleKey: 'TIMELY_SUBMISSION', ruleVersion: DCAA_RULE_VERSION, title: `Submitted within ${SUBMISSION_TIMELINESS_WORKING_DAYS} working days`, severity: 'MEDIUM' as Severity }
  const submitted = input.entries.filter((e) => e.submittedAt != null && e.status !== 'VOIDED')
  if (submitted.length === 0) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', dataSufficiency: 'INSUFFICIENT_DATA', summary: 'No submitted time entries in this period.', evidence: [], sourceRecordIds: [], recordsChecked: 0, recordsFailing: 0, limitations: ['Nothing has been submitted, so timeliness cannot be measured.'] }
  }

  const late: ReadinessTimeEntry[] = []
  for (const e of submitted) {
    const days = workingDaysBetween(e.workDate, e.submittedAt!, input.calendar)
    if (days > SUBMISSION_TIMELINESS_WORKING_DAYS) late.push(e)
  }

  return {
    ...base,
    verdict: late.length === 0 ? 'PASS' : 'WARNING',
    dataSufficiency: 'SUFFICIENT',
    summary: late.length === 0
      ? `All ${submitted.length} submitted entries met the ${SUBMISSION_TIMELINESS_WORKING_DAYS}-working-day Bytescon submission policy.`
      : `${late.length} of ${submitted.length} submitted entries were submitted more than ${SUBMISSION_TIMELINESS_WORKING_DAYS} working days after the work date.`,
    evidence: late.slice(0, 20).map((e) => `Entry ${e.id} for ${dayKey(e.workDate)} was submitted on ${dayKey(e.submittedAt!)} — ${workingDaysBetween(e.workDate, e.submittedAt!, input.calendar)} working days later.`),
    sourceRecordIds: late.map((e) => e.id),
    recordsChecked: submitted.length,
    recordsFailing: late.length,
    limitations: [`The ${SUBMISSION_TIMELINESS_WORKING_DAYS}-working-day threshold is Bytescon product policy, not a cited federal requirement.`],
  }
}

// -------------------------------------------------------------
// Rule 3 — an adjustment trail exists for changed entries
// -------------------------------------------------------------

/**
 * A submitted entry that was later modified must have an audit trail.
 *
 * `updatedAt` alone is deliberately NOT treated as proof of an adjustment — it
 * moves for reasons that are not edits. It is used only to detect that
 * something happened after submission, at which point the AuditEvent trail is
 * what must account for it.
 */
function ruleAdjustmentTrail(input: ReadinessInput): RuleResult {
  const base = { ruleKey: 'ADJUSTMENT_TRAIL_EXISTS', ruleVersion: DCAA_RULE_VERSION, title: 'Post-submission changes have an audit trail', severity: 'HIGH' as Severity }
  const submitted = input.entries.filter((e) => e.submittedAt != null)
  // With nothing submitted there is no post-submission change to account for,
  // so the rule has nothing to judge. Returning PASS here would be a vacuous
  // pass that lifts the readiness score on an empty period.
  if (submitted.length === 0) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', dataSufficiency: 'INSUFFICIENT_DATA', summary: 'No submitted time entries exist in this period, so there is no post-submission change to account for.', evidence: [], sourceRecordIds: [], recordsChecked: 0, recordsFailing: 0, limitations: ['Nothing has been submitted, so the rule has nothing to judge.'] }
  }

  const postSubmission = submitted.filter((e) => e.updatedAt.getTime() > e.submittedAt!.getTime() + 1000)
  if (postSubmission.length === 0) {
    return { ...base, verdict: 'PASS', dataSufficiency: 'SUFFICIENT', summary: `None of the ${submitted.length} submitted time entr(ies) was modified after submission.`, evidence: [], sourceRecordIds: [], recordsChecked: submitted.length, recordsFailing: 0, limitations: [] }
  }

  const trailByEntry = new Map<string, ReadinessAuditEvent[]>()
  for (const a of input.auditEvents) {
    if (!a.entityId) continue
    const list = trailByEntry.get(a.entityId) ?? []
    list.push(a)
    trailByEntry.set(a.entityId, list)
  }

  const untracked = postSubmission.filter((e) => {
    const trail = trailByEntry.get(e.id) ?? []
    return !trail.some((a) => a.createdAt.getTime() >= e.submittedAt!.getTime())
  })

  return {
    ...base,
    verdict: untracked.length === 0 ? 'PASS' : 'FAIL',
    dataSufficiency: 'SUFFICIENT',
    summary: untracked.length === 0
      ? `All ${postSubmission.length} post-submission change(s) have a corresponding audit record.`
      : `${untracked.length} entr(ies) changed after submission with no audit record of the change.`,
    evidence: untracked.slice(0, 20).map((e) => `Entry ${e.id} for ${dayKey(e.workDate)} was modified after submission on ${e.updatedAt.toISOString()} with no audit event recorded at or after submission.`),
    sourceRecordIds: untracked.map((e) => e.id),
    recordsChecked: postSubmission.length,
    recordsFailing: untracked.length,
    limitations: [],
  }
}

// -------------------------------------------------------------
// Rule 4 — adjustments carry a reason
// -------------------------------------------------------------

function ruleAdjustmentReason(input: ReadinessInput): RuleResult {
  const base = { ruleKey: 'ADJUSTMENT_REASON_RECORDED', ruleVersion: DCAA_RULE_VERSION, title: 'Time adjustments record a reason', severity: 'CRITICAL' as Severity }
  const adjustments = input.auditEvents.filter((a) => a.action === 'UPDATE' || a.action === 'DELETE')
  if (adjustments.length === 0) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', dataSufficiency: 'INSUFFICIENT_DATA', summary: 'No time-entry adjustments were recorded in this period.', evidence: [], sourceRecordIds: [], recordsChecked: 0, recordsFailing: 0, limitations: ['Nothing was adjusted, so the rule has nothing to judge.'] }
  }

  const missing = adjustments.filter((a) => !a.rationale || a.rationale.trim().length === 0)
  return {
    ...base,
    verdict: missing.length === 0 ? 'PASS' : 'FAIL',
    dataSufficiency: 'SUFFICIENT',
    summary: missing.length === 0
      ? `All ${adjustments.length} time adjustment(s) recorded a reason.`
      : `${missing.length} of ${adjustments.length} time adjustment(s) recorded no reason.`,
    evidence: missing.slice(0, 20).map((a) => `Audit event ${a.id} on time entry ${a.entityId ?? 'unknown'} at ${a.createdAt.toISOString()} records no reason for the change.`),
    sourceRecordIds: missing.map((a) => a.entityId).filter((x): x is string => Boolean(x)),
    recordsChecked: adjustments.length,
    recordsFailing: missing.length,
    limitations: [],
  }
}

// -------------------------------------------------------------
// Rule 5 — adjustments are attributable to a person
// -------------------------------------------------------------

function ruleAdjustmentActor(input: ReadinessInput): RuleResult {
  const base = { ruleKey: 'ADJUSTMENT_ACTOR_RECORDED', ruleVersion: DCAA_RULE_VERSION, title: 'Time adjustments are attributable to a person', severity: 'HIGH' as Severity }
  const adjustments = input.auditEvents.filter((a) => a.action === 'UPDATE' || a.action === 'DELETE' || a.action === 'APPROVAL')
  if (adjustments.length === 0) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', dataSufficiency: 'INSUFFICIENT_DATA', summary: 'No time-entry adjustments or approvals were recorded in this period.', evidence: [], sourceRecordIds: [], recordsChecked: 0, recordsFailing: 0, limitations: ['Nothing was adjusted or approved, so the rule has nothing to judge.'] }
  }

  // A null actor is a legitimate SYSTEM action in this schema, so it is a
  // review prompt rather than an outright failure.
  const systemActions = adjustments.filter((a) => a.actorUserId == null)
  return {
    ...base,
    verdict: systemActions.length === 0 ? 'PASS' : 'MANUAL_REVIEW',
    dataSufficiency: 'SUFFICIENT',
    summary: systemActions.length === 0
      ? `All ${adjustments.length} adjustment(s) and approval(s) name the person who made them.`
      : `${systemActions.length} of ${adjustments.length} adjustment(s) were recorded as system actions with no named person.`,
    evidence: systemActions.slice(0, 20).map((a) => `Audit event ${a.id} on time entry ${a.entityId ?? 'unknown'} has no actor recorded — the schema uses a null actor for system and scheduled actions, so a person must confirm this was one.`),
    sourceRecordIds: systemActions.map((a) => a.entityId).filter((x): x is string => Boolean(x)),
    recordsChecked: adjustments.length,
    recordsFailing: systemActions.length,
    limitations: ['A null actor legitimately means "system action" in this schema, so it cannot be distinguished from a missing attribution automatically.'],
  }
}

// -------------------------------------------------------------
// Rule 6 — direct/indirect segregation
// -------------------------------------------------------------

/**
 * UNSUPPORTED, honestly.
 *
 * `TimeEntry` has a free-text `laborCategory` and a mandatory `contractId`. It
 * carries no direct/indirect flag and no cost-pool reference, so whether time
 * is segregated correctly cannot be determined from structured data. Guessing
 * from category names would produce a confident answer built on string
 * matching, which is worse than admitting the gap.
 */
function ruleDirectIndirectSegregation(input: ReadinessInput): RuleResult {
  return {
    ruleKey: 'DIRECT_INDIRECT_SEGREGATION',
    ruleVersion: DCAA_RULE_VERSION,
    title: 'Direct and indirect time are segregated',
    verdict: 'UNSUPPORTED',
    severity: 'MEDIUM',
    dataSufficiency: 'INSUFFICIENT_DATA',
    summary: 'This check is not supported by the current data model.',
    evidence: [],
    sourceRecordIds: [],
    recordsChecked: input.entries.length,
    recordsFailing: 0,
    limitations: [
      'TimeEntry records a free-text labour category and a contract, but no direct/indirect classification and no cost-pool reference. Segregation cannot be verified from structured data, and inferring it from category names would be guesswork presented as a finding.',
    ],
  }
}

// -------------------------------------------------------------
// Rule 7 — no future-dated time
// -------------------------------------------------------------

function ruleNoFutureDatedTime(input: ReadinessInput): RuleResult {
  const base = { ruleKey: 'NO_FUTURE_DATED_TIME', ruleVersion: DCAA_RULE_VERSION, title: 'No time recorded for future dates', severity: 'CRITICAL' as Severity }
  const live = input.entries.filter((e) => e.status !== 'VOIDED')
  if (live.length === 0) {
    return { ...base, verdict: 'INSUFFICIENT_DATA', dataSufficiency: 'INSUFFICIENT_DATA', summary: 'No time entries exist in this period.', evidence: [], sourceRecordIds: [], recordsChecked: 0, recordsFailing: 0, limitations: ['No time entries in the period.'] }
  }

  const endOfToday = new Date(Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate(), 23, 59, 59, 999))
  const future = live.filter((e) => e.workDate.getTime() > endOfToday.getTime())

  return {
    ...base,
    verdict: future.length === 0 ? 'PASS' : 'FAIL',
    dataSufficiency: 'SUFFICIENT',
    summary: future.length === 0
      ? `None of the ${live.length} entries are dated in the future.`
      : `${future.length} time entr(ies) are dated in the future — time recorded for work that has not happened.`,
    evidence: future.slice(0, 20).map((e) => `Entry ${e.id} records ${e.hours} hours on ${dayKey(e.workDate)}, which is after today.`),
    sourceRecordIds: future.map((e) => e.id),
    recordsChecked: live.length,
    recordsFailing: future.length,
    limitations: [],
  }
}

// -------------------------------------------------------------
// Aggregate
// -------------------------------------------------------------

export interface ReadinessReport {
  ruleVersion: string
  disclaimer: string
  periodStart: string
  periodEnd: string
  rules: RuleResult[]
  rulesChecked: number
  /** Rules that produced a real verdict — the only ones the score is built on. */
  scorableRules: number
  passing: number
  failing: number
  warnings: number
  manualReview: number
  unsupportedRules: number
  insufficientDataRules: number
  criticalFailures: RuleResult[]
  /**
   * Percentage of SCORABLE rules that passed, or null when nothing is scorable.
   * Never includes UNSUPPORTED or INSUFFICIENT_DATA in the denominator.
   */
  readinessScore: number | null
  /**
   * The headline. A critical failure forces CRITICAL_GAP regardless of score,
   * so a high average can never bury it.
   */
  readinessState: 'CRITICAL_GAP' | 'GAPS_PRESENT' | 'REVIEW_REQUIRED' | 'NO_GAPS_DETECTED' | 'INSUFFICIENT_DATA'
  limitations: string[]
}

export function buildReadinessReport(input: ReadinessInput): ReadinessReport {
  const rules: RuleResult[] = [
    ruleDailyCompleteness(input),
    ruleTimelySubmission(input),
    ruleAdjustmentTrail(input),
    ruleAdjustmentReason(input),
    ruleAdjustmentActor(input),
    ruleDirectIndirectSegregation(input),
    ruleNoFutureDatedTime(input),
  ]

  const passing = rules.filter((r) => r.verdict === 'PASS').length
  const failing = rules.filter((r) => r.verdict === 'FAIL').length
  const warnings = rules.filter((r) => r.verdict === 'WARNING').length
  const manualReview = rules.filter((r) => r.verdict === 'MANUAL_REVIEW').length
  const unsupportedRules = rules.filter((r) => r.verdict === 'UNSUPPORTED').length
  const insufficientDataRules = rules.filter((r) => r.verdict === 'INSUFFICIENT_DATA').length

  const scorable = rules.filter((r) => r.verdict !== 'UNSUPPORTED' && r.verdict !== 'INSUFFICIENT_DATA')
  const readinessScore = scorable.length === 0
    ? null
    : Math.round((scorable.filter((r) => r.verdict === 'PASS').length / scorable.length) * 100)

  const criticalFailures = rules.filter((r) => r.verdict === 'FAIL' && isCriticalRule(r.ruleKey))

  const readinessState: ReadinessReport['readinessState'] =
    criticalFailures.length > 0 ? 'CRITICAL_GAP'
      : scorable.length === 0 ? 'INSUFFICIENT_DATA'
        : failing > 0 ? 'GAPS_PRESENT'
          : warnings > 0 || manualReview > 0 ? 'REVIEW_REQUIRED'
            : 'NO_GAPS_DETECTED'

  const limitations = [READINESS_DISCLAIMER]
  if (unsupportedRules > 0) {
    limitations.push(`${unsupportedRules} rule(s) cannot be checked from the current data model and are excluded from the score rather than counted as passing.`)
  }
  if (insufficientDataRules > 0) {
    limitations.push(`${insufficientDataRules} rule(s) had no records to judge and are excluded from the score.`)
  }

  return {
    ruleVersion: DCAA_RULE_VERSION,
    disclaimer: READINESS_DISCLAIMER,
    periodStart: input.periodStart.toISOString(),
    periodEnd: input.periodEnd.toISOString(),
    rules,
    rulesChecked: rules.length,
    scorableRules: scorable.length,
    passing,
    failing,
    warnings,
    manualReview,
    unsupportedRules,
    insufficientDataRules,
    criticalFailures,
    readinessScore,
    readinessState,
    limitations,
  }
}

/** Wording for a critical readiness gap. Describes records; claims nothing. */
export function criticalEscalationReason(rule: RuleResult): string {
  return (
    `${rule.summary} ` +
    `Affected records: ${rule.sourceRecordIds.slice(0, 10).join(', ')}${rule.sourceRecordIds.length > 10 ? `, and ${rule.sourceRecordIds.length - 10} more` : ''}. ` +
    READINESS_DISCLAIMER +
    ' The agent has not edited, approved or removed any time entry.'
  )
}

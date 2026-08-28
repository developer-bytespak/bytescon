// =============================================================
// §7.8 — the finance engines, with no database and no provider.
//
// These pin the arithmetic and the honesty rules that the integration suite
// then exercises end to end: exact cents at both ends of the scale, ageing
// boundaries at every edge, a readiness rule that cannot be answered staying
// UNSUPPORTED rather than passing, an actual rate that is never invented, and a
// projection that reports NET FLOW because no opening balance exists.
// =============================================================
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { makeCalendar } from '../../milestones/workingDays'
import { agingBucketFor, overdueDays, receivablesAging, D } from '../../contractFinance'
import {
  assembleInvoice,
  eligibleTimeWhere,
  eligibleCostWhere,
  lastClosedMonth,
  periodAlreadyInvoiced,
  nextInvoiceNumber,
  billingPeriodKey,
  AGENT_INVOICE_STATUS,
  BILLABLE_SOURCE_STATUS,
} from './invoiceBuilder'
import {
  ageReceivables,
  overdueEscalationReason,
  ESCALATION_OVERDUE_DAYS,
  RECEIVABLE_STATUSES,
  NON_RECEIVABLE_STATUSES,
} from './receivablesAgeing'
import {
  computeRateVariances,
  provisionalRatesFromTemplate,
  varianceState,
  varianceEscalationReason,
  VARIANCE_MATERIAL_PCT,
  VARIANCE_REVIEW_PCT,
  SEMANTIC_MAPPING_NOTE,
} from './rateVariance'
import {
  buildReadinessReport,
  isCriticalRule,
  READINESS_DISCLAIMER,
  SUBMISSION_TIMELINESS_WORKING_DAYS,
  CRITICAL_RULE_KEYS,
  type ReadinessTimeEntry,
  type ReadinessAuditEvent,
} from './dcaaReadiness'
import {
  projectCashFlow,
  negativeNetFlowReason,
  NEGATIVE_NET_FLOW_STATE,
  POSITIVE_NET_FLOW_STATE,
  NO_OPENING_BALANCE_LIMITATION,
  MIN_PAYMENTS_FOR_BANDS,
  MIN_PAYMENTS_FOR_TIMING,
} from './cashFlowProjection'

const dec = (v: string | number) => new Prisma.Decimal(v)
const CALENDAR = makeCalendar()
const NOW = new Date('2026-08-12T12:00:00.000Z')

// =============================================================
// Invoice builder
// =============================================================

describe('invoice eligibility', () => {
  it('bills only APPROVED, never-invoiced records', () => {
    const w = eligibleTimeWhere('firm-1', 'contract-1')
    expect(w.status).toBe(BILLABLE_SOURCE_STATUS)
    expect(w.status).toBe('APPROVED')
    expect(w.invoicedInvoiceId).toBeNull()
    expect(w.consultingFirmId).toBe('firm-1')
  })

  it('scopes costs to the tenant and the contract', () => {
    const w = eligibleCostWhere('firm-1', 'contract-1')
    expect(w.consultingFirmId).toBe('firm-1')
    expect(w.contractId).toBe('contract-1')
    expect(w.invoicedInvoiceId).toBeNull()
  })

  it('bounds by the billing period when one is supplied', () => {
    const period = { start: new Date('2026-07-01T00:00:00.000Z'), end: new Date('2026-07-31T23:59:59.999Z') }
    expect(eligibleTimeWhere('f', 'c', period).workDate).toEqual({ gte: period.start, lte: period.end })
    expect(eligibleCostWhere('f', 'c', period).incurredDate).toEqual({ gte: period.start, lte: period.end })
  })

  it('applies no date bound when no period is given', () => {
    expect(eligibleTimeWhere('f', 'c').workDate).toBeUndefined()
  })
})

describe('assembleInvoice', () => {
  const time = (over: Record<string, unknown> = {}) => ({
    id: 't1', clinId: 'clin-1', laborCategory: 'Senior Engineer', hours: dec('10.00'), workDate: new Date('2026-07-06'),
    appliedBillingRate: dec('95.0000'), billingAmount: dec('950.00'), ...over,
  })
  const cost = (over: Record<string, unknown> = {}) => ({
    id: 'c1', clinId: 'clin-2', category: 'TRAVEL', description: 'Site visit', amount: dec('412.37'), incurredDate: new Date('2026-07-10'), ...over,
  })

  // §8.2 — a government invoice bills by CLIN, and the CLIN must be the one on
  // the record behind the line rather than a value re-picked at billing time.
  it('carries each line CLIN down from the record it came from', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [time()], costs: [cost()] })
    const labor = r.lines.find((l) => l.kind === 'LABOR')
    const odc = r.lines.find((l) => l.kind === 'ODC')
    expect(labor!.clinId).toBe('clin-1')
    expect(odc!.clinId).toBe('clin-2')
  })

  it('leaves a line unattributed when its source has no CLIN', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [time({ clinId: null })], costs: [] })
    expect(r.lines[0].clinId).toBeNull()
  })

  it('leaves the fee unattributed — it spans the invoice, not one CLIN', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [], costs: [], feeAmount: dec('500.00') })
    const fee = r.lines.find((l) => l.kind === 'FEE')
    expect(fee!.clinId).toBeNull()
  })

  it('keeps two CLINs separable on one invoice', () => {
    const r = assembleInvoice({
      consultingFirmId: 'f',
      times: [time({ id: 't1', clinId: 'clin-1' }), time({ id: 't2', clinId: 'clin-9' })],
      costs: [],
    })
    expect(r.lines.map((l) => l.clinId)).toEqual(['clin-1', 'clin-9'])
  })

  it('returns nothing billable for no records', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [], costs: [] })
    expect(r.lines).toHaveLength(0)
    expect(r.total.toFixed(2)).toBe('0.00')
  })

  it('bills time only, to the cent', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [time()], costs: [] })
    expect(r.total.toFixed(2)).toBe('950.00')
    expect(r.lines[0].kind).toBe('LABOR')
    expect(r.timeEntryIds).toEqual(['t1'])
  })

  it('bills cost only, to the cent', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [], costs: [cost()] })
    expect(r.total.toFixed(2)).toBe('412.37')
    expect(r.costIds).toEqual(['c1'])
  })

  it('bills time and cost together with exact cents', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [time({ billingAmount: dec('1234.56') })], costs: [cost({ amount: dec('0.01') })] })
    expect(r.total.toFixed(2)).toBe('1234.57')
  })

  it('handles a subcontractor cost as its own line kind', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [], costs: [cost({ category: 'SUBCONTRACTOR' })] })
    expect(r.lines[0].kind).toBe('SUBCONTRACTOR')
  })

  it('bills multiple labour categories separately', () => {
    const r = assembleInvoice({
      consultingFirmId: 'f',
      times: [time(), time({ id: 't2', laborCategory: 'Analyst', billingAmount: dec('300.00') })],
      costs: [],
    })
    expect(r.lines).toHaveLength(2)
    expect(r.total.toFixed(2)).toBe('1250.00')
    expect(r.timeEntryIds).toEqual(['t1', 't2'])
  })

  it('keeps large values exact rather than drifting through float', () => {
    const r = assembleInvoice({
      consultingFirmId: 'f',
      times: [time({ billingAmount: dec('99999999.99') })],
      costs: [cost({ amount: dec('0.02') })],
    })
    expect(r.total.toFixed(2)).toBe('100000000.01')
  })

  it('adds an explicit fee as its own line', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [], costs: [cost()], feeAmount: '100.00' })
    expect(r.lines.some((l) => l.kind === 'FEE')).toBe(true)
    expect(r.total.toFixed(2)).toBe('512.37')
  })

  it('reports an approved entry with no rate rather than silently billing zero', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [time({ billingAmount: null, appliedBillingRate: null })], costs: [] })
    expect(r.total.toFixed(2)).toBe('0.00')
    expect(r.unbillable).toHaveLength(1)
    expect(r.unbillable[0].reason).toContain('No billing rate was in effect')
  })

  it('gives every line a source reference', () => {
    const r = assembleInvoice({ consultingFirmId: 'f', times: [time()], costs: [cost()] })
    expect(r.lines[0].sourceTimeEntryId).toBe('t1')
    expect(r.lines[1].sourceCostId).toBe('c1')
  })

  it('only ever produces a DRAFT status for the agent', () => {
    expect(AGENT_INVOICE_STATUS).toBe('DRAFT')
  })
})

describe('billing periods', () => {
  it('uses the last CLOSED calendar month', () => {
    const p = lastClosedMonth(new Date('2026-08-12T00:00:00.000Z'))
    expect(p.start.toISOString().slice(0, 10)).toBe('2026-07-01')
    expect(p.end.toISOString().slice(0, 10)).toBe('2026-07-31')
  })

  it('rolls back across a year boundary', () => {
    const p = lastClosedMonth(new Date('2026-01-15T00:00:00.000Z'))
    expect(p.start.toISOString().slice(0, 10)).toBe('2025-12-01')
    expect(p.end.toISOString().slice(0, 10)).toBe('2025-12-31')
  })

  it('handles a short February', () => {
    const p = lastClosedMonth(new Date('2026-03-05T00:00:00.000Z'))
    expect(p.end.toISOString().slice(0, 10)).toBe('2026-02-28')
  })

  it('treats a matching non-void invoice as covering the period', () => {
    const p = lastClosedMonth(NOW)
    expect(periodAlreadyInvoiced([{ status: 'DRAFT', periodStart: p.start, periodEnd: p.end }], p)).toBe(true)
    expect(periodAlreadyInvoiced([{ status: 'SUBMITTED', periodStart: p.start, periodEnd: p.end }], p)).toBe(true)
  })

  it('does NOT treat a voided invoice as coverage — its sources were released', () => {
    const p = lastClosedMonth(NOW)
    expect(periodAlreadyInvoiced([{ status: 'VOIDED', periodStart: p.start, periodEnd: p.end }], p)).toBe(false)
  })

  it('ignores an invoice for a different period', () => {
    const p = lastClosedMonth(NOW)
    expect(periodAlreadyInvoiced([{ status: 'SUBMITTED', periodStart: new Date('2026-05-01'), periodEnd: new Date('2026-05-31') }], p)).toBe(false)
  })

  it('numbers invoices predictably and keys periods stably', () => {
    expect(nextInvoiceNumber(0)).toBe('INV-00001')
    expect(nextInvoiceNumber(41)).toBe('INV-00042')
    const p = lastClosedMonth(NOW)
    expect(billingPeriodKey('c1', p)).toBe('c1:2026-07-01:2026-07-31')
  })
})

// =============================================================
// Ageing
// =============================================================

describe('ageing boundaries', () => {
  it.each([
    [0, 'CURRENT'], [1, 'D1_30'], [30, 'D1_30'], [31, 'D31_60'], [60, 'D31_60'],
    [61, 'D61_90'], [90, 'D61_90'], [91, 'D91_120'], [120, 'D91_120'], [121, 'D120_PLUS'],
  ])('places %i days overdue in %s', (days, bucket) => {
    expect(agingBucketFor(days)).toBe(bucket)
  })

  it('treats a future due date as current', () => {
    expect(agingBucketFor(-5)).toBe('CURRENT')
    expect(overdueDays(new Date('2026-09-01'), NOW)).toBeLessThan(0)
  })

  it('treats a missing due date as not overdue', () => {
    expect(overdueDays(null, NOW)).toBe(0)
  })

  it('keeps the legacy 90+ bucket equal to the two new bands', () => {
    const b = receivablesAging([
      { dueDate: new Date(NOW.getTime() - 100 * 86_400_000), outstanding: D('100.00') },
      { dueDate: new Date(NOW.getTime() - 200 * 86_400_000), outstanding: D('50.00') },
    ], NOW)
    expect(b.d91_120).toBe('100.00')
    expect(b.d120plus).toBe('50.00')
    expect(b.d90plus).toBe('150.00')
  })
})

describe('ageReceivables', () => {
  const inv = (over: Record<string, unknown> = {}) => ({
    id: 'i1', invoiceNumber: 'INV-00001', contractId: 'c1', status: 'SUBMITTED',
    invoiceDate: new Date('2026-06-01'), dueDate: new Date('2026-07-01'),
    total: dec('1000.00'), amountPaid: dec('0.00'), customerName: 'DoD', ...over,
  })

  it('excludes a DRAFT invoice — it is not a receivable', () => {
    const r = ageReceivables([inv({ status: 'DRAFT' })], NOW)
    expect(r.receivables).toHaveLength(0)
    expect(r.excludedNonReceivable).toBe(1)
    expect(r.buckets.totalOutstanding).toBe('0.00')
  })

  it.each([...NON_RECEIVABLE_STATUSES])('excludes a %s invoice', (status) => {
    expect(ageReceivables([inv({ status })], NOW).receivables).toHaveLength(0)
  })

  it.each([...RECEIVABLE_STATUSES])('includes a %s invoice', (status) => {
    expect(ageReceivables([inv({ status })], NOW).receivables).toHaveLength(1)
  })

  it('ages a partial payment on the remaining balance only', () => {
    const r = ageReceivables([inv({ amountPaid: dec('250.50'), status: 'PARTIALLY_PAID' })], NOW)
    expect(r.receivables[0].outstanding).toBe('749.50')
    expect(r.buckets.totalOutstanding).toBe('749.50')
  })

  it('drops a fully paid invoice from the ageing', () => {
    expect(ageReceivables([inv({ amountPaid: dec('1000.00'), status: 'PARTIALLY_PAID' })], NOW).receivables).toHaveLength(0)
  })

  it('reports a future due date as current with no overdue days', () => {
    const r = ageReceivables([inv({ dueDate: new Date('2026-12-01') })], NOW)
    expect(r.receivables[0].bucket).toBe('CURRENT')
    expect(r.receivables[0].overdueDays).toBe(0)
  })

  it('states the limitation rather than inventing Net 30 for a missing due date', () => {
    const r = ageReceivables([inv({ dueDate: null })], NOW)
    expect(r.receivables[0].dueDateUnknown).toBe(true)
    expect(r.receivables[0].bucket).toBe('CURRENT')
    expect(r.dataSufficiency).toBe('PARTIAL')
    expect(r.limitations.join(' ')).toContain('no payment-term policy')
  })

  it('flags only genuinely severe overdue balances', () => {
    const old = new Date(NOW.getTime() - 100 * 86_400_000)
    const r = ageReceivables([inv({ dueDate: old }), inv({ id: 'i2', invoiceNumber: 'INV-2' })], NOW)
    expect(r.severelyOverdue).toHaveLength(1)
    expect(r.severelyOverdue[0].overdueDays).toBeGreaterThan(ESCALATION_OVERDUE_DAYS)
  })

  it('changes the dedupe key when a partial payment changes the balance', () => {
    const a = ageReceivables([inv()], NOW).receivables[0]
    const b = ageReceivables([inv({ amountPaid: dec('100.00') })], NOW).receivables[0]
    expect(b.dedupeKey).not.toBe(a.dedupeKey)
  })

  it('keeps the dedupe key stable when nothing changed', () => {
    expect(ageReceivables([inv()], NOW).receivables[0].dedupeKey)
      .toBe(ageReceivables([inv()], NOW).receivables[0].dedupeKey)
  })

  it('states the facts and draws no conclusion about the customer', () => {
    const r = ageReceivables([inv({ dueDate: new Date(NOW.getTime() - 100 * 86_400_000) })], NOW)
    const reason = overdueEscalationReason(r.severelyOverdue[0])
    expect(reason).toContain('more than 90 days past its due date')
    expect(reason).toContain('does not contact the customer')
    expect(reason).not.toMatch(/will not pay|refus|dispute|bad debt/i)
  })
})

// =============================================================
// Rate variance
// =============================================================

describe('rate variance', () => {
  const prov = (over: Record<string, unknown> = {}) => ({
    rateType: 'FRINGE', percent: dec('30.0000'), source: 'PRICING_TEMPLATE' as const,
    sourceReference: 'Standard v1', effectiveDate: null, endDate: null, ...over,
  })
  const act = (over: Record<string, unknown> = {}) => ({
    id: 'a1', rateType: 'FRINGE', poolName: 'Fringe', actualRate: dec('30.0000'),
    periodStart: new Date('2026-01-01'), periodEnd: new Date('2026-06-30'), fiscalYear: 2026,
    status: 'FINAL', isHumanVerified: true, source: 'MANUAL_ENTRY', sourceReference: null, ...over,
  })

  it.each([
    [null, 'INSUFFICIENT_DATA'], [0, 'WITHIN_MONITORING_RANGE'], [4.99, 'WITHIN_MONITORING_RANGE'],
    [VARIANCE_REVIEW_PCT, 'REVIEW_RECOMMENDED'], [14.99, 'REVIEW_RECOMMENDED'],
    [VARIANCE_MATERIAL_PCT, 'MATERIAL_VARIANCE'], [-20, 'MATERIAL_VARIANCE'],
  ])('grades %s as %s', (pct, state) => {
    expect(varianceState(pct as number | null)).toBe(state)
  })

  it('reports zero variance for an identical rate', () => {
    const [v] = computeRateVariances({ provisionals: [prov()], actuals: [act()] })
    expect(v.absoluteVariance).toBe('0.0000')
    expect(v.relativeVariancePct).toBe(0)
    expect(v.state).toBe('WITHIN_MONITORING_RANGE')
  })

  it('computes an exact material variance', () => {
    const [v] = computeRateVariances({ provisionals: [prov()], actuals: [act({ actualRate: dec('36.0000') })] })
    expect(v.absoluteVariance).toBe('6.0000')
    expect(v.relativeVariancePct).toBe(20)
    expect(v.state).toBe('MATERIAL_VARIANCE')
  })

  it('keeps four-decimal rate precision', () => {
    const [v] = computeRateVariances({ provisionals: [prov({ percent: dec('30.1234') })], actuals: [act({ actualRate: dec('30.5678') })] })
    expect(v.absoluteVariance).toBe('0.4444')
  })

  it('never invents a baseline when no provisional exists', () => {
    const [v] = computeRateVariances({ provisionals: [], actuals: [act()] })
    expect(v.state).toBe('INSUFFICIENT_DATA')
    expect(v.provisionalRate).toBeNull()
    expect(v.provisionalSource).toBe('NONE')
    expect(v.limitations.join(' ')).toContain('does not substitute one')
  })

  it('produces nothing at all when no actual rate exists', () => {
    expect(computeRateVariances({ provisionals: [prov()], actuals: [] })).toHaveLength(0)
  })

  it('does not match a different pool type', () => {
    const [v] = computeRateVariances({ provisionals: [prov({ rateType: 'OVERHEAD' })], actuals: [act({ rateType: 'GA' })] })
    expect(v.state).toBe('INSUFFICIENT_DATA')
  })

  it('does not match a provisional rate outside the actual period', () => {
    const [v] = computeRateVariances({
      provisionals: [prov({ effectiveDate: new Date('2027-01-01') })],
      actuals: [act()],
    })
    expect(v.state).toBe('INSUFFICIENT_DATA')
  })

  it('always states the proposal-pricing-to-actual mapping', () => {
    const [v] = computeRateVariances({ provisionals: [prov()], actuals: [act()] })
    expect(v.semanticMapping).toBe('PROPOSAL_PRICING_TO_ACTUAL')
    expect(v.evidence.join(' ')).toContain(SEMANTIC_MAPPING_NOTE)
  })

  it('flags an unverified actual rate as a limitation', () => {
    const [v] = computeRateVariances({ provisionals: [prov()], actuals: [act({ isHumanVerified: false })] })
    expect(v.actualIsHumanVerified).toBe(false)
    expect(v.limitations.join(' ')).toContain('not been verified by a person')
  })

  it('reports an absolute difference when the provisional is zero', () => {
    const [v] = computeRateVariances({ provisionals: [prov({ percent: dec('0.0000') })], actuals: [act({ actualRate: dec('5.0000') })] })
    expect(v.absoluteVariance).toBe('5.0000')
    expect(v.relativeVariancePct).toBeNull()
    expect(v.state).toBe('INSUFFICIENT_DATA')
  })

  it('says plainly that nothing was changed', () => {
    const [v] = computeRateVariances({ provisionals: [prov()], actuals: [act({ actualRate: dec('40.0000') })] })
    expect(varianceEscalationReason(v)).toContain('changed no rate, invoice or pricing record')
  })

  it('reads a template rate set and skips malformed entries', () => {
    const rates = provisionalRatesFromTemplate({
      id: 't1', name: 'Standard', version: 2, effectiveDate: null,
      indirectRatesJson: [
        { rateType: 'FRINGE', percent: 30 },
        { rateType: 'OVERHEAD', percent: '85.5' },
        { percent: 10 },
        { rateType: 'GA', percent: 'not-a-number' },
      ],
    })
    expect(rates.map((r) => r.rateType)).toEqual(['FRINGE', 'OVERHEAD'])
    expect(rates[0].sourceReference).toBe('Standard v2')
  })

  it('returns nothing for a missing template', () => {
    expect(provisionalRatesFromTemplate(null)).toHaveLength(0)
  })
})

// =============================================================
// Readiness
// =============================================================

describe('timekeeping readiness', () => {
  const entry = (over: Partial<ReadinessTimeEntry> = {}): ReadinessTimeEntry => ({
    id: 'e1', userId: 'u1', contractId: 'c1', laborCategory: 'Engineer',
    workDate: new Date('2026-08-03T00:00:00.000Z'), hours: dec('8.00'), status: 'SUBMITTED',
    submittedAt: new Date('2026-08-04T09:00:00.000Z'), approverUserId: null,
    createdAt: new Date('2026-08-03T17:00:00.000Z'), updatedAt: new Date('2026-08-04T09:00:00.000Z'),
    ...over,
  })
  const audit = (over: Partial<ReadinessAuditEvent> = {}): ReadinessAuditEvent => ({
    id: 'a1', entityId: 'e1', action: 'UPDATE', actorUserId: 'u2', rationale: 'Corrected hours.',
    beforeJson: null, afterJson: null, createdAt: new Date('2026-08-05T10:00:00.000Z'), ...over,
  })
  const build = (entries: ReadinessTimeEntry[], auditEvents: ReadinessAuditEvent[] = []) =>
    buildReadinessReport({
      entries, auditEvents,
      periodStart: new Date('2026-07-01T00:00:00.000Z'), periodEnd: NOW, now: NOW, calendar: CALENDAR,
    })

  const rule = (r: ReturnType<typeof build>, key: string) => r.rules.find((x) => x.ruleKey === key)!

  it('checks exactly seven rules', () => {
    expect(build([entry()]).rulesChecked).toBe(7)
  })

  it('passes a complete, timely week', () => {
    // Mon–Fri 3–7 August 2026.
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    const entries = days.map((d, i) => entry({
      id: `e${i}`, workDate: new Date(`${d}T00:00:00.000Z`), submittedAt: new Date(`${d}T18:00:00.000Z`),
      updatedAt: new Date(`${d}T18:00:00.000Z`),
    }))
    const r = build(entries)
    expect(rule(r, 'DAILY_TIME_COMPLETENESS').verdict).toBe('PASS')
    expect(rule(r, 'TIMELY_SUBMISSION').verdict).toBe('PASS')
    expect(rule(r, 'NO_FUTURE_DATED_TIME').verdict).toBe('PASS')
  })

  it('warns about a missing working day between first and last charge', () => {
    const r = build([
      entry({ id: 'e1', workDate: new Date('2026-08-03T00:00:00.000Z') }),
      entry({ id: 'e2', workDate: new Date('2026-08-05T00:00:00.000Z') }),
    ])
    const c = rule(r, 'DAILY_TIME_COMPLETENESS')
    expect(c.verdict).toBe('WARNING')
    expect(c.evidence.join(' ')).toContain('2026-08-04')
  })

  it('does not count a weekend as a missing day', () => {
    const r = build([
      entry({ id: 'e1', workDate: new Date('2026-08-07T00:00:00.000Z') }),
      entry({ id: 'e2', workDate: new Date('2026-08-10T00:00:00.000Z') }),
    ])
    expect(rule(r, 'DAILY_TIME_COMPLETENESS').verdict).toBe('PASS')
  })

  it('passes submission exactly at the policy boundary', () => {
    const r = build([entry({
      workDate: new Date('2026-08-03T00:00:00.000Z'),
      submittedAt: new Date('2026-08-10T09:00:00.000Z'), // 5 working days later
    })])
    expect(rule(r, 'TIMELY_SUBMISSION').verdict).toBe('PASS')
  })

  it('warns one working day past the boundary', () => {
    const r = build([entry({
      workDate: new Date('2026-08-03T00:00:00.000Z'),
      submittedAt: new Date('2026-08-11T09:00:00.000Z'), // 6 working days later
    })])
    expect(rule(r, 'TIMELY_SUBMISSION').verdict).toBe('WARNING')
  })

  it('names the timeliness threshold as product policy, not a federal rule', () => {
    const r = build([entry()])
    expect(rule(r, 'TIMELY_SUBMISSION').limitations.join(' ')).toContain('Bytescon product policy')
    expect(SUBMISSION_TIMELINESS_WORKING_DAYS).toBe(5)
  })

  it('fails on a future-dated entry, and that is critical', () => {
    const r = build([entry({ workDate: new Date('2026-09-01T00:00:00.000Z') })])
    const c = rule(r, 'NO_FUTURE_DATED_TIME')
    expect(c.verdict).toBe('FAIL')
    expect(c.severity).toBe('CRITICAL')
    expect(r.readinessState).toBe('CRITICAL_GAP')
  })

  it('passes an adjustment that records a reason', () => {
    const r = build([entry({ updatedAt: new Date('2026-08-05T10:00:00.000Z') })], [audit()])
    expect(rule(r, 'ADJUSTMENT_REASON_RECORDED').verdict).toBe('PASS')
  })

  it('fails an adjustment with no reason, and that is critical', () => {
    const r = build([entry({ updatedAt: new Date('2026-08-05T10:00:00.000Z') })], [audit({ rationale: null })])
    const c = rule(r, 'ADJUSTMENT_REASON_RECORDED')
    expect(c.verdict).toBe('FAIL')
    expect(isCriticalRule(c.ruleKey)).toBe(true)
    expect(r.criticalFailures).toHaveLength(1)
  })

  it('fails a post-submission change with no audit trail at all', () => {
    const r = build([entry({ updatedAt: new Date('2026-08-06T10:00:00.000Z') })], [])
    expect(rule(r, 'ADJUSTMENT_TRAIL_EXISTS').verdict).toBe('FAIL')
  })

  it('passes when the trail accounts for the change', () => {
    const r = build([entry({ updatedAt: new Date('2026-08-06T10:00:00.000Z') })], [audit({ createdAt: new Date('2026-08-06T10:00:00.000Z') })])
    expect(rule(r, 'ADJUSTMENT_TRAIL_EXISTS').verdict).toBe('PASS')
  })

  it('passes actor attribution when a person is named', () => {
    const r = build([entry()], [audit({ actorUserId: 'u2' })])
    expect(rule(r, 'ADJUSTMENT_ACTOR_RECORDED').verdict).toBe('PASS')
  })

  it('asks for review — not failure — when the actor is a system action', () => {
    const r = build([entry()], [audit({ actorUserId: null })])
    const c = rule(r, 'ADJUSTMENT_ACTOR_RECORDED')
    expect(c.verdict).toBe('MANUAL_REVIEW')
    expect(c.limitations.join(' ')).toContain('system action')
  })

  it('handles multiple adjustments on one entry', () => {
    const r = build([entry({ updatedAt: new Date('2026-08-07T10:00:00.000Z') })], [
      audit({ id: 'a1', rationale: 'First fix.' }),
      audit({ id: 'a2', rationale: null, createdAt: new Date('2026-08-07T10:00:00.000Z') }),
    ])
    const c = rule(r, 'ADJUSTMENT_REASON_RECORDED')
    expect(c.recordsChecked).toBe(2)
    expect(c.recordsFailing).toBe(1)
  })

  it('reports segregation as UNSUPPORTED rather than guessing from category names', () => {
    const c = rule(build([entry()]), 'DIRECT_INDIRECT_SEGREGATION')
    expect(c.verdict).toBe('UNSUPPORTED')
    expect(c.limitations.join(' ')).toContain('no direct/indirect classification')
  })

  it('reports INSUFFICIENT_DATA when there is nothing to judge', () => {
    const r = build([])
    expect(rule(r, 'DAILY_TIME_COMPLETENESS').verdict).toBe('INSUFFICIENT_DATA')
    expect(r.readinessState).toBe('INSUFFICIENT_DATA')
    expect(r.readinessScore).toBeNull()
  })

  it('never counts UNSUPPORTED or INSUFFICIENT_DATA as a pass', () => {
    const r = build([entry()])
    expect(r.scorableRules).toBe(r.rulesChecked - r.unsupportedRules - r.insufficientDataRules)
    expect(r.scorableRules).toBeLessThan(r.rulesChecked)
  })

  it('never lets a high score bury a critical failure', () => {
    const days = ['2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07']
    const good = days.map((d, i) => entry({ id: `g${i}`, workDate: new Date(`${d}T00:00:00.000Z`), submittedAt: new Date(`${d}T18:00:00.000Z`), updatedAt: new Date(`${d}T18:00:00.000Z`) }))
    const r = build([...good, entry({ id: 'bad', workDate: new Date('2026-09-01T00:00:00.000Z') })])
    // The point is that the state overrides the score, not the exact number.
    expect(r.readinessScore).toBeGreaterThanOrEqual(50)
    expect(r.readinessState).toBe('CRITICAL_GAP')
  })

  it('carries evidence or an explicit reason on every rule', () => {
    for (const rl of build([entry({ updatedAt: new Date('2026-08-06T10:00:00.000Z') })], [audit({ rationale: null })]).rules) {
      const explained = rl.evidence.length > 0 || rl.limitations.length > 0 || rl.verdict === 'PASS'
      expect(explained, `${rl.ruleKey} must carry evidence or say why it cannot`).toBe(true)
    }
  })

  it('keeps the critical rule set short and explicit', () => {
    expect([...CRITICAL_RULE_KEYS]).toEqual(['NO_FUTURE_DATED_TIME', 'ADJUSTMENT_REASON_RECORDED'])
  })
})

describe('readiness claim safety', () => {
  const FORBIDDEN = /DCAA[- ](compliant|approved|certified)|will pass (an )?audit|audit[- ]approved|certified compliant/i

  it('never claims compliance, certification or an audit outcome', () => {
    const report = buildReadinessReport({
      entries: [], auditEvents: [],
      periodStart: new Date('2026-07-01'), periodEnd: NOW, now: NOW, calendar: CALENDAR,
    })
    const text = JSON.stringify(report)
    expect(text).not.toMatch(FORBIDDEN)
  })

  it('states the non-certification disclaimer explicitly', () => {
    expect(READINESS_DISCLAIMER).toContain('not a DCAA audit, certification or approval')
    expect(READINESS_DISCLAIMER).toContain('does not predict an audit outcome')
  })
})

// =============================================================
// Cash flow
// =============================================================

describe('cash flow projection', () => {
  const invoice = (over: Record<string, unknown> = {}) => ({
    id: 'i1', invoiceNumber: 'INV-1', total: dec('10000.00'), amountPaid: dec('0.00'),
    dueDate: new Date('2026-09-01'), invoiceDate: new Date('2026-08-01'), status: 'SUBMITTED', ...over,
  })
  const base = {
    outstandingInvoices: [] as ReturnType<typeof invoice>[],
    unbilledApproved: [] as Array<{ contractId: string; amount: Prisma.Decimal }>,
    knownCosts: [] as Array<{ id: string; amount: Prisma.Decimal; incurredDate: Date | null; category: string }>,
    historicalPaymentLagDays: [] as number[],
    pipelineByMonth: [] as Array<{ month: string; expectedValue: number }>,
    now: NOW,
    horizonMonths: 6,
  }

  it('reports nothing to project with no finance data', () => {
    const r = projectCashFlow(base)
    expect(r.dataSufficiency).toBe('INSUFFICIENT_DATA')
    expect(r.netCashFlow).toBe('0.00')
    expect(r.limitations.join(' ')).toContain('nothing to project')
  })

  it('projects one outstanding invoice on its due date', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice()] })
    expect(r.projectedReceipts).toBe('10000.00')
    expect(r.lines[0].sourceClass).toBe('CONTRACTED_RECEIVABLE')
    expect(r.lines[0].dateIsRecorded).toBe(true)
  })

  it('projects the remaining balance after a partial payment', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice({ amountPaid: dec('2500.25') })] })
    expect(r.projectedReceipts).toBe('7499.75')
  })

  it('sums multiple invoices to the cent', () => {
    const r = projectCashFlow({
      ...base,
      outstandingInvoices: [invoice({ total: dec('0.01') }), invoice({ id: 'i2', total: dec('0.02') })],
    })
    expect(r.projectedReceipts).toBe('0.03')
  })

  it('keeps very large amounts exact', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice({ total: dec('99999999.99') })] })
    expect(r.projectedReceipts).toBe('99999999.99')
  })

  it('nets known costs against receipts', () => {
    const r = projectCashFlow({
      ...base,
      outstandingInvoices: [invoice({ total: dec('1000.00') })],
      knownCosts: [{ id: 'c1', amount: dec('400.00'), incurredDate: new Date('2026-08-20'), category: 'TRAVEL' }],
    })
    expect(r.projectedDisbursements).toBe('400.00')
    expect(r.netCashFlow).toBe('600.00')
    expect(r.netCashFlowLabel).toBe(POSITIVE_NET_FLOW_STATE)
  })

  it('labels a negative result as NET CASH FLOW, never a cash position', () => {
    const r = projectCashFlow({
      ...base,
      knownCosts: [{ id: 'c1', amount: dec('5000.00'), incurredDate: new Date('2026-08-20'), category: 'MATERIAL' }],
    })
    expect(r.netCashFlow).toBe('-5000.00')
    expect(r.netCashFlowLabel).toBe(NEGATIVE_NET_FLOW_STATE)
    expect(r.netCashFlowLabel).toBe('PROJECTED_NEGATIVE_NET_CASH_FLOW')
    // The forbidden thing is CLAIMING a negative cash position. Saying "this is
    // not a cash position" is the disclaimer and must survive.
    const CLAIMS_A_POSITION = /(projected|is a|shows a|indicates a|resulting in a)\s+negative cash position/i
    expect(JSON.stringify(r)).not.toMatch(CLAIMS_A_POSITION)
    expect(negativeNetFlowReason(r)).not.toMatch(CLAIMS_A_POSITION)
    expect(negativeNetFlowReason(r)).toContain('net cash flow')
    expect(negativeNetFlowReason(r)).toContain('not a cash position')
  })

  it('always says no opening balance exists', () => {
    const r = projectCashFlow(base)
    expect(r.openingCashBalanceAvailable).toBe(false)
    expect(r.limitations).toContain(NO_OPENING_BALANCE_LIMITATION)
    expect(r).not.toHaveProperty('projectedEndingCash')
  })

  it('EXCLUDES pipeline expected value from contracted receipts', () => {
    const r = projectCashFlow({
      ...base,
      outstandingInvoices: [invoice({ total: dec('1000.00') })],
      pipelineByMonth: [{ month: '2026-09', expectedValue: 500000 }],
    })
    expect(r.projectedReceipts).toBe('1000.00')
    expect(r.netCashFlow).toBe('1000.00')
    expect(r.sourceBreakdown.PIPELINE_EXPECTED_VALUE.receipts).toBe('500000.00')
    expect(r.limitations.join(' ')).toContain('EXCLUDED from projected receipts')
  })

  it('labels pipeline lines as not contracted and not owed', () => {
    const r = projectCashFlow({ ...base, pipelineByMonth: [{ month: '2026-09', expectedValue: 1000 }] })
    expect(r.lines[0].reference).toContain('not contracted, not owed')
    expect(r.lines[0].sourceId).toBeNull()
  })

  it('separates unbilled contracted work from sent invoices', () => {
    const r = projectCashFlow({ ...base, unbilledApproved: [{ contractId: 'c1', amount: dec('750.00') }] })
    expect(r.sourceBreakdown.CONTRACTED_EXPECTED_BILLING.receipts).toBe('750.00')
    expect(r.sourceBreakdown.CONTRACTED_RECEIVABLE.receipts).toBe('0.00')
  })

  it('does not model collection timing from too few settled invoices', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice()], historicalPaymentLagDays: [5, 7, 9] })
    expect(r.paymentTiming.modelled).toBe(false)
    expect(r.limitations.join(' ')).toContain(`below the ${MIN_PAYMENTS_FOR_TIMING} needed`)
  })

  it('models collection timing once enough history exists', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice()], historicalPaymentLagDays: [5, 6, 7, 8, 9, 10] })
    expect(r.paymentTiming.modelled).toBe(true)
    expect(r.paymentTiming.medianLagDays).toBe(7.5)
  })

  it('returns no confidence band rather than a fabricated one', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice()], historicalPaymentLagDays: [5, 6, 7, 8, 9, 10] })
    expect(r.confidenceState).toBe('DETERMINISTIC_ONLY')
    expect(r.confidenceLower).toBeNull()
    expect(r.confidenceUpper).toBeNull()
    expect(r.limitations.join(' ')).toContain(`at least ${MIN_PAYMENTS_FOR_BANDS} settled invoices`)
  })

  it('offers a band once enough settled invoices exist', () => {
    const lags = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice()], historicalPaymentLagDays: lags })
    expect(r.confidenceState).toBe('BANDED')
    expect(r.confidenceLower).not.toBeNull()
    expect(Number(r.confidenceLower)).toBeLessThanOrEqual(Number(r.netCashFlow))
    expect(Number(r.confidenceUpper)).toBeGreaterThanOrEqual(Number(r.netCashFlow))
  })

  it('is reproducible — same inputs, same hash and same band', () => {
    const lags = [2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24]
    const a = projectCashFlow({ ...base, outstandingInvoices: [invoice()], historicalPaymentLagDays: lags })
    const b = projectCashFlow({ ...base, outstandingInvoices: [invoice()], historicalPaymentLagDays: lags })
    expect(b.inputHash).toBe(a.inputHash)
    expect(b.confidenceLower).toBe(a.confidenceLower)
  })

  it('changes the hash when a material input changes', () => {
    const a = projectCashFlow({ ...base, outstandingInvoices: [invoice()] })
    const b = projectCashFlow({ ...base, outstandingInvoices: [invoice({ total: dec('20000.00') })] })
    expect(b.inputHash).not.toBe(a.inputHash)
  })

  it('excludes an invoice that cannot be placed on the timeline', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice({ dueDate: null, invoiceDate: null })] })
    expect(r.lines).toHaveLength(0)
    expect(r.limitations.join(' ')).toContain('cannot be placed on the timeline')
  })

  it('excludes a receipt beyond the horizon', () => {
    const r = projectCashFlow({ ...base, outstandingInvoices: [invoice({ dueDate: new Date('2030-01-01') })] })
    expect(r.lines).toHaveLength(0)
  })
})

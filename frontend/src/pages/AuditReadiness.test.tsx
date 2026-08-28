// =============================================================
// §8.2 — Audit readiness.
//
// The assertions that matter are about honesty, not layout: a blocking gap is
// shown as blocking, an unattributed CLIN is called unattributed rather than
// blank, and the page says out loud that it is evidence and not a submission.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const toast = vi.fn()
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast }) }))

const auditPackage = vi.fn()
const exportAuditPackage = vi.fn()
vi.mock('../services/api', () => ({
  financeApi: {
    auditPackage: (...a: unknown[]) => auditPackage(...a),
    exportAuditPackage: (...a: unknown[]) => exportAuditPackage(...a),
  },
}))

import AuditReadiness from './AuditReadiness'

const PKG = {
  fiscalYear: 2026,
  periodStart: '2026-01-01T00:00:00.000Z',
  periodEnd: '2026-12-31T23:59:59.999Z',
  generatedAt: '2026-08-22T00:00:00.000Z',
  contracts: [{
    contractId: 'c1', contractNumber: 'DE-AC05-26', title: 'Cyber support', agency: 'Department of Energy',
    directLabour: '5593.39', directCosts: '5992.50', subcontract: '39550.00',
    totalIncurred: '51135.89', billed: '58462.50', collected: '8000.00',
    byClin: [
      { clinNumber: '0001', clinLevel: 'CLIN', directLabour: '3660.63', directCosts: '39550.00', total: '43210.63' },
      { clinNumber: null, clinLevel: null, directLabour: '120.00', directCosts: '0.00', total: '120.00' },
    ],
  }],
  totals: {
    directLabour: '5593.39', directCosts: '5992.50', subcontract: '39550.00',
    totalIncurred: '51135.89', billed: '58462.50', collected: '8000.00',
  },
  indirectRates: [
    { rateType: 'FRINGE', poolName: null, actualRate: '31.4200', status: 'FINAL', isHumanVerified: false, periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2026-12-31T00:00:00.000Z' },
  ],
  gaps: [
    { severity: 'BLOCKING', area: 'Timekeeping', count: 3, detail: '3 time entries are still unapproved in this period and are therefore excluded.' },
    { severity: 'REVIEW', area: 'CLIN attribution', count: 1, detail: '1 record carries no CLIN.' },
  ],
  notes: ['This is an evidence package assembled from the firm’s own records. It is not a filed submission.'],
}

beforeEach(() => {
  vi.clearAllMocks()
  auditPackage.mockResolvedValue({ data: PKG })
})

describe('AuditReadiness', () => {
  it('shows a blocking gap as blocking', async () => {
    render(<AuditReadiness />)
    expect(await screen.findByText('BLOCKING')).toBeInTheDocument()
    expect(screen.getByText(/3 time entries are still unapproved/)).toBeInTheDocument()
  })

  it('keeps a review gap separate from a blocking one', async () => {
    render(<AuditReadiness />)
    expect(await screen.findByText('REVIEW')).toBeInTheDocument()
    expect(screen.getByText(/1 record carries no CLIN/)).toBeInTheDocument()
  })

  it('says labour is reported at cost, not at billing rate', async () => {
    render(<AuditReadiness />)
    expect(await screen.findByText(/At cost, not billing rate/i)).toBeInTheDocument()
  })

  it('calls an unattributed CLIN unattributed rather than leaving it blank', async () => {
    render(<AuditReadiness />)
    expect(await screen.findByText('(unattributed)')).toBeInTheDocument()
  })

  it('marks an unverified rate as recorded only', async () => {
    render(<AuditReadiness />)
    expect(await screen.findByText('RECORDED ONLY')).toBeInTheDocument()
  })

  it('states that it is evidence rather than a filed submission', async () => {
    render(<AuditReadiness />)
    expect(await screen.findByText(/not a filed submission/i)).toBeInTheDocument()
  })

  it('reloads when the fiscal year changes', async () => {
    render(<AuditReadiness />)
    await screen.findByText('BLOCKING')
    fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: '2025' } })
    await waitFor(() => expect(auditPackage).toHaveBeenLastCalledWith({ fiscalYear: 2025 }))
  })

  it('exports the year currently on screen', async () => {
    exportAuditPackage.mockResolvedValue(undefined)
    render(<AuditReadiness />)
    fireEvent.click(await screen.findByRole('button', { name: /Export CSV/ }))
    await waitFor(() => expect(exportAuditPackage).toHaveBeenCalledWith(2026))
  })

  it('says plainly when nothing is missing', async () => {
    auditPackage.mockResolvedValue({ data: { ...PKG, gaps: [] } })
    render(<AuditReadiness />)
    expect(await screen.findByText(/Nothing is missing or unverified/i)).toBeInTheDocument()
  })
})

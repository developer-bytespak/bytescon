// =============================================================
// §8.1 / §8.3 — Partner portal access panel.
//
// The two assertions that matter: the invite link is shown once with a warning
// that it cannot be recovered, and a user with no engagement is described as
// having an EMPTY portal rather than as having access.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PartnerPortalAccess } from './PartnerPortalAccess'

const listUsers = vi.fn()
const invite = vi.fn()
const revokeUser = vi.fn()
const grant = vi.fn()
const revokeAccess = vi.fn()
const loadContractOptions = vi.fn()

vi.mock('../../services/crmApi', async () => {
  const actual = await vi.importActual<typeof import('../../services/crmApi')>('../../services/crmApi')
  return {
    ...actual,
    partnerPortalAdminApi: {
      listUsers: (...a: unknown[]) => listUsers(...a),
      invite: (...a: unknown[]) => invite(...a),
      revokeUser: (...a: unknown[]) => revokeUser(...a),
      grant: (...a: unknown[]) => grant(...a),
      revokeAccess: (...a: unknown[]) => revokeAccess(...a),
    },
    loadContractOptions: (...a: unknown[]) => loadContractOptions(...a),
  }
})
vi.mock('../Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }))

const USER = {
  id: 'u1', email: 'sub@demo.test', firstName: 'Demo', lastName: 'Sub',
  isActive: true, invitedAt: '2026-08-01T00:00:00.000Z', acceptedAt: '2026-08-02T00:00:00.000Z',
  lastLoginAt: null, revokedAt: null, partner: { id: 'p1', name: 'Demo Sub LLC' }, access: [],
}

const wrap = () => render(<PartnerPortalAccess partnerId="p1" partnerName="Demo Sub LLC" />)

beforeEach(() => {
  vi.clearAllMocks()
  listUsers.mockResolvedValue([])
  loadContractOptions.mockResolvedValue([{ id: 'c1', contractNumber: 'DEMO-CT-0001', title: 'Demo Cyber Support' }])
})

describe('PartnerPortalAccess', () => {
  it('says plainly that the portal never shows CRM data', async () => {
    wrap()
    expect(await screen.findByText(/never your CRM notes, relationship score or interaction history/i)).toBeInTheDocument()
  })

  it('shows the invite link once, with the warning that it cannot be shown again', async () => {
    invite.mockResolvedValue({ id: 'u9', email: 'new@sub.test', inviteToken: 'RAW-INVITE-TOKEN', inviteExpiresAt: '2026-09-01T00:00:00.000Z' })
    wrap()
    fireEvent.change(await screen.findByLabelText('Portal user email'), { target: { value: 'new@sub.test' } })
    fireEvent.change(screen.getByLabelText('Portal user first name'), { target: { value: 'New' } })
    fireEvent.change(screen.getByLabelText('Portal user last name'), { target: { value: 'Person' } })
    fireEvent.click(screen.getByRole('button', { name: /Invite to portal/i }))

    await waitFor(() => expect(invite).toHaveBeenCalledWith(
      expect.objectContaining({ partnerId: 'p1', email: 'new@sub.test' }),
    ))
    expect(await screen.findByText(/cannot be shown again/i)).toBeInTheDocument()
    expect(screen.getByText(/RAW-INVITE-TOKEN/)).toBeInTheDocument()
    expect(screen.getByText(/\/partner\/accept-invite/)).toBeInTheDocument()
  })

  it('warns that an accepted user with no engagement sees an EMPTY portal', async () => {
    listUsers.mockResolvedValue([USER])
    wrap()
    expect(await screen.findByText(/sign in to an empty portal until you share one/i)).toBeInTheDocument()
  })

  it('distinguishes invited-not-accepted from active', async () => {
    listUsers.mockResolvedValue([{ ...USER, acceptedAt: null }])
    wrap()
    expect(await screen.findByText('INVITED — NOT ACCEPTED')).toBeInTheDocument()
  })

  it('shares a contract as an explicit grant', async () => {
    listUsers.mockResolvedValue([USER])
    grant.mockResolvedValue({ id: 'a1' })
    wrap()
    fireEvent.change(await screen.findByLabelText('Share a contract with sub@demo.test'), { target: { value: 'c1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Share' }))
    await waitFor(() => expect(grant).toHaveBeenCalledWith({
      partnerPortalUserId: 'u1', scopeType: 'CONTRACT', scopeId: 'c1',
    }))
  })

  it('names the shared contract rather than showing a raw id', async () => {
    listUsers.mockResolvedValue([{
      ...USER,
      access: [{ id: 'a1', scopeType: 'CONTRACT' as const, scopeId: 'c1', grantedAt: '2026-08-02T00:00:00.000Z' }],
    }])
    wrap()
    // The same label also appears in the "share a contract" dropdown, which is
    // correct — assert on the granted row specifically.
    const rows = await screen.findAllByText(/DEMO-CT-0001 — Demo Cyber Support/)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((el) => el.tagName !== 'OPTION')).toBe(true)
    expect(await screen.findByRole('button', { name: 'remove' })).toBeInTheDocument()
  })

  it('keeps the access list working when contracts cannot be loaded', async () => {
    loadContractOptions.mockRejectedValue(new Error('offline'))
    listUsers.mockResolvedValue([USER])
    wrap()
    expect(await screen.findByText('sub@demo.test')).toBeInTheDocument()
  })

  it('shows a revoked user as revoked and offers no sharing', async () => {
    listUsers.mockResolvedValue([{ ...USER, isActive: false, revokedAt: '2026-08-05T00:00:00.000Z' }])
    wrap()
    expect(await screen.findByText('REVOKED')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument()
  })
})

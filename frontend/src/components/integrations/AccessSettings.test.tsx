// =============================================================
// §8.5 — Roles and access.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AccessSettings } from './AccessSettings'

const catalog = vi.fn()
const me = vi.fn()
const users = vi.fn()
const updateUser = vi.fn()

vi.mock('../../services/integrationsApi', () => ({
  rbacApi: {
    catalog: () => catalog(), me: () => me(), users: () => users(),
    updateUser: (...a: unknown[]) => updateUser(...a),
  },
}))

const CATALOG = {
  roles: [
    { role: 'ADMIN', permissions: ['LEGACY_ADMIN_WRITE', 'FINANCE_APPROVE'] },
    { role: 'CONSULTANT', permissions: ['CRM_READ'] },
    { role: 'FINANCE', permissions: ['FINANCE_APPROVE'] },
    { role: 'VIEWER', permissions: ['CRM_READ'] },
  ],
  permissions: [{ permission: 'FINANCE_APPROVE', description: 'Approve money.' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  catalog.mockResolvedValue(CATALOG)
  users.mockResolvedValue([
    { id: 'u1', email: 'a@b.test', firstName: 'Ann', lastName: 'Buyer', role: 'FINANCE', extraPermissions: [], isActive: true, lastLoginAt: null },
  ])
})

describe('AccessSettings', () => {
  it('shows what the caller holds', async () => {
    me.mockResolvedValue({ role: 'FINANCE', permissions: ['FINANCE_APPROVE', 'CRM_READ'] })
    // The count is interpolated mid-sentence, so it is asserted on the
    // rendered text rather than as its own element.
    const { container } = render(<AccessSettings />)
    await screen.findAllByText('Your access')
    expect(container.textContent).toContain('2 permission(s)')
    expect(screen.getAllByText('FINANCE_APPROVE').length).toBeGreaterThan(0)
  })

  it('hides team administration from a user without ADMIN_SETTINGS', async () => {
    me.mockResolvedValue({ role: 'FINANCE', permissions: ['FINANCE_APPROVE'] })
    render(<AccessSettings />)
    await screen.findByText('Roles')
    expect(screen.queryByText('Team access')).not.toBeInTheDocument()
    expect(users).not.toHaveBeenCalled()
  })

  it('lets an administrator change a role', async () => {
    me.mockResolvedValue({ role: 'ADMIN', permissions: ['ADMIN_SETTINGS'] })
    updateUser.mockResolvedValue({})
    render(<AccessSettings />)
    fireEvent.change(await screen.findByLabelText('Role for a@b.test'), { target: { value: 'VIEWER' } })
    await waitFor(() => expect(updateUser).toHaveBeenCalledWith('u1', { role: 'VIEWER' }))
  })

  it('explains what each role can do', async () => {
    me.mockResolvedValue({ role: 'ADMIN', permissions: ['ADMIN_SETTINGS'] })
    render(<AccessSettings />)
    expect(await screen.findByText(/Read-only across the platform/i)).toBeInTheDocument()
  })

  it('says a change takes effect on the next request', async () => {
    me.mockResolvedValue({ role: 'ADMIN', permissions: ['ADMIN_SETTINGS'] })
    render(<AccessSettings />)
    expect(await screen.findByText(/next request/i)).toBeInTheDocument()
  })
})

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
const deactivateUser = vi.fn()
const reactivateUser = vi.fn()

vi.mock('../../services/integrationsApi', () => ({
  rbacApi: {
    catalog: () => catalog(), me: () => me(), users: () => users(),
    updateUser: (...a: unknown[]) => updateUser(...a),
    deactivateUser: (...a: unknown[]) => deactivateUser(...a),
    reactivateUser: (...a: unknown[]) => reactivateUser(...a),
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

  it('lets an administrator deactivate and reactivate a member, but not themselves', async () => {
    me.mockResolvedValue({ userId: 'me', role: 'ADMIN', permissions: ['ADMIN_SETTINGS'] })
    users.mockResolvedValue([
      { id: 'me', email: 'me@b.test', firstName: 'My', lastName: 'Self', role: 'ADMIN', extraPermissions: [], isActive: true, lastLoginAt: null },
      { id: 'u1', email: 'a@b.test', firstName: 'Ann', lastName: 'Buyer', role: 'FINANCE', extraPermissions: [], isActive: true, lastLoginAt: null },
      { id: 'u2', email: 'c@b.test', firstName: 'Cy', lastName: 'Gone', role: 'VIEWER', extraPermissions: [], isActive: false, lastLoginAt: null },
    ])
    deactivateUser.mockResolvedValue({ id: 'u1', isActive: false })
    reactivateUser.mockResolvedValue({ id: 'u2', isActive: true })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<AccessSettings />)

    const deactivateButtons = await screen.findAllByRole('button', { name: 'Deactivate' })
    // Only Ann: the signed-in admin has no button, Cy is already deactivated.
    expect(deactivateButtons).toHaveLength(1)
    expect(screen.getByText('deactivated')).toBeInTheDocument()

    fireEvent.click(deactivateButtons[0])
    await waitFor(() => expect(deactivateUser).toHaveBeenCalledWith('u1'))

    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate' }))
    await waitFor(() => expect(reactivateUser).toHaveBeenCalledWith('u2'))
  })

  it('does nothing when the deactivation is not confirmed', async () => {
    me.mockResolvedValue({ userId: 'me', role: 'ADMIN', permissions: ['ADMIN_SETTINGS'] })
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<AccessSettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate' }))
    expect(deactivateUser).not.toHaveBeenCalled()
  })
})

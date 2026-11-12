// The page a verification link opens: verifying, verified, failed, no token.
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyEmail = vi.fn()
vi.mock('../services/api', () => ({ authApi: { verifyEmail: (token: string) => verifyEmail(token) } }))

import { VerifyEmailPage } from './VerifyEmail'

const renderAt = (url: string) => render(<MemoryRouter initialEntries={[url]}><VerifyEmailPage /></MemoryRouter>)

beforeEach(() => { verifyEmail.mockReset() })

describe('VerifyEmailPage', () => {
  it('verifies the token and offers sign-in', async () => {
    verifyEmail.mockResolvedValue({ success: true })
    renderAt('/verify-email?token=abc')
    expect(screen.getByText('Verifying your email…')).toBeInTheDocument()
    expect(await screen.findByText('Email verified')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Sign in →' })).toHaveAttribute('href', '/login')
    expect(verifyEmail).toHaveBeenCalledWith('abc')
  })

  it('shows why a link failed, with ways forward', async () => {
    verifyEmail.mockRejectedValue({ response: { data: { error: 'This link has expired.' } } })
    renderAt('/verify-email?token=old')
    expect(await screen.findByText('Verification failed')).toBeInTheDocument()
    expect(screen.getByText('This link has expired.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Re-register' })).toHaveAttribute('href', '/register')
  })

  it('explains a link with no token, without calling the server', () => {
    renderAt('/verify-email')
    expect(screen.getByText('Missing verification token')).toBeInTheDocument()
    expect(verifyEmail).not.toHaveBeenCalled()
  })
})

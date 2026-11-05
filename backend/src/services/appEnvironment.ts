// =============================================================
// Which environment is this: production or staging?
//
// Both run the same code with NODE_ENV=production; APP_ENV switches on the
// staging-only protections. Unset means production, so nothing changes for an
// instance that has never heard of this setting.
//
// Staging is for the internal team only:
//   - STAGING_ALLOWED_EMAILS decides who may sign in and who receives email
//     ("a@x.com,@bytesplatform.com": exact addresses or whole domains).
//   - STAGING_ALLOWED_PHONES decides who receives SMS.
// Both fail closed: an empty list on staging means nobody.
// =============================================================
import { ForbiddenError } from '../utils/errors'

export type AppEnv = 'staging' | 'demo' | 'production'

export function getAppEnv(): AppEnv {
  const value = (process.env.APP_ENV || '').trim().toLowerCase()
  return value === 'staging' || value === 'demo' ? value : 'production'
}

/** Client demo site: accounts are created by an operator and expire. */
export function isDemo(): boolean {
  return getAppEnv() === 'demo'
}

export function isStaging(): boolean {
  return getAppEnv() === 'staging'
}

function listFrom(name: string): string[] {
  return (process.env[name] || '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
}

/** Always true outside staging. */
export function isStagingEmailAllowed(email: string | null | undefined): boolean {
  if (!isStaging()) return true
  const address = (email || '').trim().toLowerCase()
  const at = address.lastIndexOf('@')
  if (at <= 0) return false
  const domain = address.slice(at)
  return listFrom('STAGING_ALLOWED_EMAILS').some((entry) => (entry.startsWith('@') ? entry === domain : entry === address))
}

/** Always true outside staging. */
export function isStagingPhoneAllowed(phone: string | null | undefined): boolean {
  if (!isStaging()) return true
  const digits = (value: string) => value.replace(/\D/g, '')
  const number = digits(phone || '')
  return number.length > 0 && listFrom('STAGING_ALLOWED_PHONES').some((entry) => digits(entry) === number)
}

/** Refuses a sign-in or session for anyone not on the staging list. */
export function assertStagingSignInAllowed(email: string | null | undefined): void {
  if (!isStagingEmailAllowed(email)) {
    throw new ForbiddenError('This is an internal test environment. Your account is not on its access list.')
  }
}

/**
 * Settings that must never be true on staging. Called once at boot; throwing
 * here stops a misconfigured staging from starting at all.
 */
export function assertSafeStagingSettings(): void {
  if (!isStaging() && !isDemo()) return
  const stripeKey = process.env.STRIPE_SECRET_KEY?.trim() || ''
  if (stripeKey.startsWith('sk_live') || stripeKey.startsWith('rk_live')) {
    throw new Error(`APP_ENV=${getAppEnv()} must not use a live Stripe key.`)
  }
  if (isDemo()) {
    if (!(process.env.PLATFORM_ADMIN_EMAILS || '').trim()) {
      throw new Error('APP_ENV=demo needs PLATFORM_ADMIN_EMAILS, or nobody can create demo accounts.')
    }
    return
  }
  if (listFrom('STAGING_ALLOWED_EMAILS').length === 0) {
    throw new Error('APP_ENV=staging needs STAGING_ALLOWED_EMAILS, or nobody can sign in.')
  }
}

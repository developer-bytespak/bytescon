// =============================================================
// MFA (TOTP) service — secret generation, code verification, and one-time
// recovery codes. Opt-in two-factor for consultant accounts (FIXES.md FIX-3).
// The TOTP secret is stored encrypted at rest by the caller (fieldCrypto);
// recovery codes are stored bcrypt-hashed.
// =============================================================
import * as OTPAuth from 'otpauth'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'

const ISSUER = 'Bytescon'
const DIGITS = 6
const PERIOD = 30

export interface MfaEnrollment {
  secret: string // base32 — for manual entry
  otpauthUri: string // otpauth:// — for the QR code
}

function totpFor(base32Secret: OTPAuth.Secret, label?: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: ISSUER,
    label: label ?? ISSUER,
    algorithm: 'SHA1',
    digits: DIGITS,
    period: PERIOD,
    secret: base32Secret,
  })
}

/** New TOTP secret + provisioning URI for an account (labelled by the user's email). */
export function generateMfaEnrollment(accountLabel: string): MfaEnrollment {
  const secret = new OTPAuth.Secret({ size: 20 })
  return { secret: secret.base32, otpauthUri: totpFor(secret, accountLabel).toString() }
}

/** Verify a 6-digit TOTP code against a base32 secret. Allows ±1 step for clock skew. */
export function verifyTotp(base32Secret: string | null | undefined, code: string): boolean {
  if (!base32Secret) return false
  const clean = String(code).trim()
  if (!/^\d{6}$/.test(clean)) return false
  try {
    const totp = totpFor(OTPAuth.Secret.fromBase32(base32Secret))
    return totp.validate({ token: clean, window: 1 }) !== null
  } catch {
    return false
  }
}

/** N human-friendly recovery codes (display) + their bcrypt hashes (store the hashes). */
export async function generateRecoveryCodes(count = 10): Promise<{ plain: string[]; hashed: string[] }> {
  const plain: string[] = []
  const canonical: string[] = []
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex') // 10 lowercase hex chars
    canonical.push(raw)
    plain.push(`${raw.slice(0, 5)}-${raw.slice(5)}`) // shown as xxxxx-xxxxx
  }
  const hashed = await Promise.all(canonical.map((c) => bcrypt.hash(c, 10)))
  return { plain, hashed }
}

/** Normalize a submitted recovery code to the canonical (dashless, lowercase) form. */
export function normalizeRecoveryCode(code: string): string {
  return String(code).trim().toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** Index of the matched recovery-code hash (to be consumed), or -1. */
export async function matchRecoveryCode(hashedCodes: string[], code: string): Promise<number> {
  const canonical = normalizeRecoveryCode(code)
  if (canonical.length < 8) return -1
  for (let i = 0; i < hashedCodes.length; i++) {
    if (await bcrypt.compare(canonical, hashedCodes[i])) return i
  }
  return -1
}

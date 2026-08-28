// =============================================================
// Field-level encryption for secrets stored at rest (tenant SAM / LLM API keys).
//
// AES-256-GCM (authenticated) with a per-value random IV. Ciphertext is tagged
// with an "enc:v1:" prefix so reads can distinguish encrypted values from legacy
// plaintext and decrypt only when needed — no big-bang data migration required.
//
// GRACEFUL ROLLOUT: if FIELD_ENCRYPTION_KEY is not set, encryptSecret() is a
// pass-through (plaintext is stored, exactly as before) so existing deployments
// keep working. Provision FIELD_ENCRYPTION_KEY (a 64-char hex string = 32 bytes,
// or any passphrase — hashed to 32 bytes) to turn encryption on. Existing
// plaintext rows keep working (decrypt passes them through) and become encrypted
// the next time they are saved; a one-time re-save/migration can encrypt them en
// masse. See CODE_REVIEW_2026-06-27.md (#20).
// =============================================================
import crypto from 'crypto'
import { logger } from './logger'

const PREFIX = 'enc:v1:'
const ALGO = 'aes-256-gcm'
const IV_LEN = 12
const TAG_LEN = 16

function getKey(): Buffer | null {
  const raw = process.env.FIELD_ENCRYPTION_KEY
  if (!raw || raw.trim().length === 0) return null
  const trimmed = raw.trim()
  // 64 hex chars = a real 32-byte key. Anything else is hashed to 32 bytes so a
  // human-typed passphrase still yields a valid AES-256 key.
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  return crypto.createHash('sha256').update(trimmed).digest()
}

let warnedNoKey = false

/** Encrypt a secret for at-rest storage. Pass-through plaintext when no key is set. */
export function encryptSecret(plain: string | null | undefined): string | null {
  if (plain == null || plain === '') return null
  if (plain.startsWith(PREFIX)) return plain // already encrypted — idempotent
  const key = getKey()
  if (!key) {
    if (!warnedNoKey) {
      logger.warn(
        'FIELD_ENCRYPTION_KEY not set — tenant API keys are stored as plaintext. Set it to encrypt secrets at rest.',
      )
      warnedNoKey = true
    }
    return plain
  }
  const iv = crypto.randomBytes(IV_LEN)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64')
}

/** Decrypt a stored secret. Legacy plaintext (no prefix) is returned unchanged. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored == null || stored === '') return null
  if (!stored.startsWith(PREFIX)) return stored // legacy plaintext pass-through
  const key = getKey()
  if (!key) {
    // Ciphertext present but no key to decrypt it. Return null so callers treat
    // it as "not configured" instead of handing ciphertext to an upstream API.
    logger.error('Encrypted secret found but FIELD_ENCRYPTION_KEY is not set — cannot decrypt.')
    return null
  }
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), 'base64')
    const iv = buf.subarray(0, IV_LEN)
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN)
    const ct = buf.subarray(IV_LEN + TAG_LEN)
    const decipher = crypto.createDecipheriv(ALGO, key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch (err) {
    logger.error('Failed to decrypt secret (wrong key or tampered ciphertext)', {
      error: (err as Error).message,
    })
    return null
  }
}

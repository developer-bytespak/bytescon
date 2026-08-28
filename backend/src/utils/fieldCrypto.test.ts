// =============================================================
// fieldCrypto — AES-256-GCM round-trip + graceful-rollout behavior (unit)
// =============================================================
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

import { encryptSecret, decryptSecret } from './fieldCrypto'

const KEY = 'a'.repeat(64) // 64 hex chars = 32 bytes
const ORIGINAL = process.env.FIELD_ENCRYPTION_KEY

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.FIELD_ENCRYPTION_KEY
  else process.env.FIELD_ENCRYPTION_KEY = ORIGINAL
})

describe('fieldCrypto — with a key set', () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = KEY
  })

  it('round-trips a secret and does not leak plaintext', () => {
    const ct = encryptSecret('sk-secret-123')
    expect(ct).toMatch(/^enc:v1:/)
    expect(ct).not.toContain('sk-secret-123')
    expect(decryptSecret(ct)).toBe('sk-secret-123')
  })

  it('is idempotent — does not double-encrypt ciphertext', () => {
    const ct = encryptSecret('abc')!
    expect(encryptSecret(ct)).toBe(ct)
  })

  it('uses a random IV (same input -> different ciphertext)', () => {
    expect(encryptSecret('abc')).not.toBe(encryptSecret('abc'))
  })

  it('still reads legacy plaintext (no prefix) unchanged', () => {
    expect(decryptSecret('legacy-plaintext-key')).toBe('legacy-plaintext-key')
  })

  it('returns null for tampered ciphertext (GCM auth)', () => {
    const ct = encryptSecret('abc')!
    const tampered = ct.slice(0, -4) + (ct.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    expect(decryptSecret(tampered)).toBeNull()
  })
})

describe('fieldCrypto — without a key (graceful no-op)', () => {
  beforeEach(() => {
    delete process.env.FIELD_ENCRYPTION_KEY
  })

  it('stores plaintext as-is', () => {
    expect(encryptSecret('abc')).toBe('abc')
  })

  it('reads plaintext as-is', () => {
    expect(decryptSecret('abc')).toBe('abc')
  })
})

describe('fieldCrypto — null/empty handling', () => {
  it('treats null/empty as null', () => {
    expect(encryptSecret(null)).toBeNull()
    expect(encryptSecret('')).toBeNull()
    expect(decryptSecret(null)).toBeNull()
    expect(decryptSecret(undefined)).toBeNull()
  })
})

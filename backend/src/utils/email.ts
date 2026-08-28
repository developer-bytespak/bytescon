// =============================================================
// Email normalization — single source of truth.
//
// Email addresses are stored and looked up in trimmed-lowercase form.
// Two users registering with "John@x.com" and "john@x.com" otherwise
// create two distinct accounts and one will silently fail to log in.
// =============================================================
import { z } from 'zod'

export const normalizeEmail = (s: string): string => s.trim().toLowerCase()

export const EmailField = z.string().email().transform(normalizeEmail)
export const OptionalEmailField = z.string().email().transform(normalizeEmail).optional()

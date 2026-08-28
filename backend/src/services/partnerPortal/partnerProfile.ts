// =============================================================
// §8.4 — Partner self-service profile: what an external user may propose.
//
// The allowlist is the security boundary, so it is a literal list rather than
// a rule. Everything a prime forms its own opinion with — `notes`,
// `pastRelationship`, `ownerUserId`, `isActive`, `partnerType`, relationship
// strength and every performance record — is absent from it, and absent means
// unrepresentable rather than filtered later.
//
// Nothing here writes to `Partner`. A proposal is stored, a prime ADMIN
// reviews it, and only the approval path applies the allowlisted fields.
// =============================================================
import { z } from 'zod'
import { Prisma } from '@prisma/client'

/** Exactly the Partner columns a partner may propose a value for. */
export const PARTNER_PROFILE_EDITABLE_FIELDS = [
  'website', 'geography', 'contactName', 'contactEmail', 'contactPhone',
  'capabilities', 'certifications', 'primaryNaicsCodes',
] as const

export type PartnerProfileField = (typeof PARTNER_PROFILE_EDITABLE_FIELDS)[number]

/**
 * Columns an external caller must never reach, asserted in tests so a future
 * column added to `Partner` cannot quietly become externally writable.
 */
export const PARTNER_PROFILE_FORBIDDEN_FIELDS = [
  'id', 'consultingFirmId', 'name', 'uei', 'cage', 'notes', 'pastRelationship',
  'ownerUserId', 'isActive', 'partnerType', 'cmmcLevel', 'primarySetAsides',
  'pastPerformanceLink', 'createdAt', 'updatedAt',
] as const

const StringList = z.array(z.string().trim().min(1).max(120)).max(40)

export const PartnerProfileProposalSchema = z.object({
  website: z.string().trim().max(300).nullable().optional(),
  geography: z.string().trim().max(200).nullable().optional(),
  contactName: z.string().trim().max(200).nullable().optional(),
  contactEmail: z.string().trim().email().max(200).nullable().optional(),
  contactPhone: z.string().trim().max(60).nullable().optional(),
  capabilities: StringList.optional(),
  certifications: StringList.optional(),
  primaryNaicsCodes: StringList.optional(),
}).strict()

export type PartnerProfileProposal = z.infer<typeof PartnerProfileProposalSchema>

/** The current values of the allowlisted fields, for the reviewer's comparison. */
export function currentProfileSnapshot(partner: Record<string, unknown>): Prisma.InputJsonObject {
  const out: Record<string, unknown> = {}
  for (const field of PARTNER_PROFILE_EDITABLE_FIELDS) out[field] = partner[field] ?? null
  return out as Prisma.InputJsonObject
}

/**
 * Translate an approved proposal into a Partner update.
 *
 * Re-filtered against the allowlist at apply time rather than trusted from the
 * stored JSON: the row was written by an external actor, and a stored value is
 * still untrusted input when it is read back.
 */
export function buildApprovedProfileUpdate(proposed: unknown): Prisma.PartnerUpdateInput {
  const source = (proposed ?? {}) as Record<string, unknown>
  // Reduce to the allowlist FIRST. A key that is not on it never reaches the
  // validator, so a value written straight into the stored JSON — bypassing
  // the strict schema at submission time — is dropped here rather than
  // invalidating (and silently discarding) the legitimate fields alongside it.
  const candidate: Record<string, unknown> = {}
  for (const field of PARTNER_PROFILE_EDITABLE_FIELDS) {
    if (source[field] !== undefined) candidate[field] = source[field]
  }
  const parsed = PartnerProfileProposalSchema.safeParse(candidate)
  if (!parsed.success) return {}
  return parsed.data as Prisma.PartnerUpdateInput
}

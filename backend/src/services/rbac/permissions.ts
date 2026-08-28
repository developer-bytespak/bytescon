// =============================================================
// §8.5 — Roles and permissions.
//
// THE COMPATIBILITY CONTRACT, first, because everything else depends on it:
//
//   ADMIN keeps every capability it has ever had.
//   CONSULTANT stays read-only, exactly as before.
//
// The granular roles are additive. They exist so a ten-person contractor can
// give its capture lead the CRM without giving them the cheque book, and they
// are built by naming permissions rather than by scattering `role === 'X'`
// checks through the routers.
//
// One rule shapes the sets below: a permission that ENDS A HUMAN DECISION —
// bid/no-bid, proposal approval, submission, budget activation, purchase-order
// approval, invoice approval, payment, resume approval, portal access grant,
// sending an agreement for signature — is never bundled into a general write
// role. Writing a proposal and approving one are different jobs, and a role
// that conflates them removes the review the platform exists to record.
// =============================================================

export const PERMISSIONS = [
  // Customer and pipeline
  'CRM_READ', 'CRM_WRITE',
  'PIPELINE_READ', 'PIPELINE_WRITE',
  // The bid/no-bid decision itself.
  'BID_DECISION',
  // Proposal work, and the separate act of approving it.
  'PROPOSAL_READ', 'PROPOSAL_WRITE', 'PROPOSAL_APPROVE',
  'SUBMISSION_SEND',
  // Contracts and delivery
  'CONTRACT_READ', 'CONTRACT_WRITE',
  // Money
  'FINANCE_READ', 'FINANCE_WRITE', 'FINANCE_APPROVE',
  // Relationships and people
  'PARTNER_MANAGE', 'PARTNER_ACCESS_GRANT',
  'PERSONNEL_MANAGE', 'RESUME_APPROVE',
  // Agreements
  'ESIGN_READ', 'ESIGN_SEND',
  // Platform administration
  'API_TOKEN_MANAGE', 'INTEGRATION_MANAGE', 'SSO_MANAGE', 'ADMIN_SETTINGS',
  // The compatibility gate. Held by ADMIN alone, and by nothing else: it is
  // what every legacy `requireRole('ADMIN')` route resolves to, so adding a
  // granular role can never widen access to a route nobody has reviewed.
  'LEGACY_ADMIN_WRITE',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  CRM_READ: 'Read contacts, activities and follow-ups.',
  CRM_WRITE: 'Create and edit contacts, activities and follow-ups.',
  PIPELINE_READ: 'Read opportunities and the pursuit pipeline.',
  PIPELINE_WRITE: 'Move pursuits through the pipeline and edit their working fields.',
  BID_DECISION: 'Record the bid / no-bid decision.',
  PROPOSAL_READ: 'Read proposals and their sections.',
  PROPOSAL_WRITE: 'Draft and edit proposal content.',
  PROPOSAL_APPROVE: 'Approve proposal content as final.',
  SUBMISSION_SEND: 'Mark a proposal submitted to the government.',
  CONTRACT_READ: 'Read contracts, CLINs and deliverables.',
  CONTRACT_WRITE: 'Create and edit contracts, CLINs and deliverables.',
  FINANCE_READ: 'Read budgets, costs, invoices and receivables.',
  FINANCE_WRITE: 'Create and edit budgets, costs and invoices.',
  FINANCE_APPROVE: 'Activate a budget, approve a purchase order or invoice, and record a payment.',
  PARTNER_MANAGE: 'Manage teaming partners and subcontract relationships.',
  PARTNER_ACCESS_GRANT: 'Invite partner portal users and grant them engagement access.',
  PERSONNEL_MANAGE: 'Manage the personnel and resume library.',
  RESUME_APPROVE: 'Approve a resume version as evidence a proposal may rest on.',
  ESIGN_READ: 'Read signature requests and their status.',
  ESIGN_SEND: 'Send an agreement for signature.',
  API_TOKEN_MANAGE: 'Create and revoke API and connector tokens.',
  INTEGRATION_MANAGE: 'Connect, configure and disconnect external providers.',
  SSO_MANAGE: 'Configure enterprise single sign-on.',
  ADMIN_SETTINGS: 'Change firm-wide settings and branding.',
  LEGACY_ADMIN_WRITE: 'Full administrative access to every route that predates granular permissions.',
}

export const ROLES = [
  'ADMIN', 'CONSULTANT', 'BD_CAPTURE', 'PROPOSAL', 'CONTRACTS', 'FINANCE', 'VIEWER',
] as const

export type RoleKey = (typeof ROLES)[number]

/** Every read permission. The floor for any internal role. */
const ALL_READ: Permission[] = [
  'CRM_READ', 'PIPELINE_READ', 'PROPOSAL_READ', 'CONTRACT_READ', 'FINANCE_READ', 'ESIGN_READ',
]

export const ROLE_PERMISSIONS: Record<RoleKey, readonly Permission[]> = {
  // Unchanged: everything, including the legacy gate.
  ADMIN: PERMISSIONS,

  // Unchanged in effect: read-only across the internal platform, exactly as
  // before §8.5. It holds no write permission and no legacy gate, so no
  // existing consultant account gains anything from this file.
  CONSULTANT: ALL_READ,

  // Capture and business development. Works the pipeline and the relationships;
  // does not decide the bid, touch money, or approve a proposal.
  BD_CAPTURE: [...ALL_READ, 'CRM_WRITE', 'PIPELINE_WRITE', 'PARTNER_MANAGE'],

  // Proposal production. Drafts, edits and approves proposal content; cannot
  // submit to the government, and cannot touch finance.
  PROPOSAL: [...ALL_READ, 'PROPOSAL_WRITE', 'PROPOSAL_APPROVE', 'PERSONNEL_MANAGE', 'RESUME_APPROVE'],

  // Contract administration and delivery. Runs contracts and subcontract
  // relationships; does not approve money and does not mint credentials.
  CONTRACTS: [...ALL_READ, 'CONTRACT_WRITE', 'PARTNER_MANAGE', 'PARTNER_ACCESS_GRANT', 'ESIGN_SEND'],

  // Money. Approves budgets, orders, invoices and payments; has no say in
  // proposal content and cannot approve one.
  FINANCE: [...ALL_READ, 'FINANCE_WRITE', 'FINANCE_APPROVE'],

  // Read-only, for auditors and observers.
  VIEWER: ALL_READ,
}

const PERMISSION_SET = new Set<string>(PERMISSIONS)

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value)
}

export function isRole(value: unknown): value is RoleKey {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value)
}

/**
 * The permissions a user actually holds: their role's set, plus any additive
 * per-user grants.
 *
 * An unknown role resolves to NOTHING rather than to a default. A typo in the
 * role column must fail closed — silently granting reads to an unrecognised
 * role is how a deactivated or mis-migrated account keeps working.
 */
export function resolvePermissions(
  role: string | null | undefined,
  extraPermissions: readonly string[] = [],
): Set<Permission> {
  const out = new Set<Permission>()
  if (isRole(role)) for (const p of ROLE_PERMISSIONS[role]) out.add(p)
  for (const p of extraPermissions) if (isPermission(p)) out.add(p)
  return out
}

export function hasPermission(
  role: string | null | undefined,
  extraPermissions: readonly string[] | undefined,
  permission: Permission,
): boolean {
  return resolvePermissions(role, extraPermissions ?? []).has(permission)
}

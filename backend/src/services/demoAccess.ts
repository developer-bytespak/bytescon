// =============================================================
// Who may use the demo site.
//
// Outside the demo flavour this always answers ACTIVE, so normal firms are never
// affected. On it, only operators (PLATFORM_ADMIN_EMAILS), the pool administrator
// and demo accounts that haven't expired get in. Anything else already in the database stays out.
// =============================================================
import { isDemo } from './appEnvironment'
import { isPlatformAdmin, isPoolAdmin } from '../middleware/platformAdmin'
import { prisma } from '../config/database'
import { businessTypeByKey } from './demoBusinessTypes'
import { OPERATOR_FIRM_EMAIL } from './demoFirms'

export const DEMO_ENDED_MESSAGE = 'Your demo has ended. Please contact your Bytescon representative to continue.'

export type DemoAccess = 'ACTIVE' | 'EXPIRED' | 'NOT_A_DEMO_ACCOUNT'

export function demoAccessOf(email: string, demoExpiresAt: Date | null, now: Date = new Date()): DemoAccess {
  if (!isDemo() || isPlatformAdmin(email) || isPoolAdmin(email)) return 'ACTIVE'
  if (!demoExpiresAt) return 'NOT_A_DEMO_ACCOUNT'
  return demoExpiresAt > now ? 'ACTIVE' : 'EXPIRED'
}

/**
 * For people who sign in through a firm rather than as staff, such as partners.
 * Outside the demo flavour it's always true. On it, the firm must be a demo
 * account that hasn't expired.
 */
export function demoFirmIsOpen(demoExpiresAt: Date | null, now: Date = new Date()): boolean {
  return !isDemo() || (demoExpiresAt !== null && demoExpiresAt > now)
}

/**
 * On the demo, a firm with a business type only sees opportunities in that business,
 * even if a sync or someone adding one brings in others. The operators see everything.
 * Null means no restriction.
 */
export async function demoOpportunityFilter(consultingFirmId: string): Promise<{ OR: Array<{ naicsCode: { startsWith: string } }> } | null> {
  if (!isDemo()) return null
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { demoBusinessType: true, contactEmail: true } })
  if (firm?.contactEmail === OPERATOR_FIRM_EMAIL) return null
  const type = businessTypeByKey(firm?.demoBusinessType)
  return type ? { OR: type.naicsPrefixes.map((prefix) => ({ naicsCode: { startsWith: prefix } })) } : null
}

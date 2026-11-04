// =============================================================
// Who may use the demo site.
//
// Outside the demo flavour this always answers ACTIVE, so normal firms are never
// affected. On it, only operators (PLATFORM_ADMIN_EMAILS) and demo accounts that
// haven't expired get in. Anything else already in the database stays out.
// =============================================================
import { isDemo } from './appEnvironment'
import { isPlatformAdmin } from '../middleware/platformAdmin'

export type DemoAccess = 'ACTIVE' | 'EXPIRED' | 'NOT_A_DEMO_ACCOUNT'

export function demoAccessOf(email: string, demoExpiresAt: Date | null, now: Date = new Date()): DemoAccess {
  if (!isDemo() || isPlatformAdmin(email)) return 'ACTIVE'
  if (!demoExpiresAt) return 'NOT_A_DEMO_ACCOUNT'
  return demoExpiresAt > now ? 'ACTIVE' : 'EXPIRED'
}

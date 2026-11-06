// The two firms the demo runs on besides client accounts: neither is a demo
// account, so neither expires or shows on the operator's list.
import type { Prisma } from '@prisma/client'

/** Holds the operator logins. */
export const OPERATOR_FIRM_EMAIL = 'demo-operators@demo.invalid'
/** Holds the shared SAM.gov pull that client accounts are filled from. */
export const POOL_FIRM_EMAIL = 'demo-sam-pool@demo.invalid'

/** Every account that should carry demo data: open client accounts and the operators. */
export const demoDataFirms = (now: Date = new Date()): Prisma.ConsultingFirmWhereInput => ({
  OR: [{ demoExpiresAt: { gt: now } }, { contactEmail: OPERATOR_FIRM_EMAIL }],
})

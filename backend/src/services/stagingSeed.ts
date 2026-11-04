// =============================================================
// Staging test data: a demo firm, its first staff admin, a demo client and
// sample opportunities. Everything is invented; nothing comes from production.
// Run through prisma/scripts/seedStaging.ts. Refuses to run unless APP_ENV=staging.
// =============================================================
import type { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { isStaging, isStagingEmailAllowed } from './appEnvironment'

const FIRM_CONTACT = 'staging-demo@bytescon.invalid'

const SAMPLE_OPPORTUNITIES = [
  { title: 'STAGING SAMPLE: Medical Equipment Transport', agency: 'Department of Veterans Affairs', naicsCode: '484121', setAsideType: 'SDVOSB', marketCategory: 'LOGISTICS', estimatedValue: 2_500_000, days: 14 },
  { title: 'STAGING SAMPLE: Cybersecurity Assessment Support', agency: 'Department of Homeland Security', naicsCode: '541512', setAsideType: 'SBA', marketCategory: 'SERVICES', estimatedValue: 1_200_000, days: 21 },
  { title: 'STAGING SAMPLE: Facilities Maintenance', agency: 'General Services Administration', naicsCode: '561210', setAsideType: 'WOSB', marketCategory: 'SERVICES', estimatedValue: 800_000, days: 30 },
]

/** Checks the settings before anything is written. Throws with what to fix. */
export function readStagingSeedSettings(): { email: string; password: string } {
  if (!isStaging()) throw new Error('Refusing to run: APP_ENV is not staging.')
  const email = (process.env.STAGING_SEED_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = process.env.STAGING_SEED_ADMIN_PASSWORD || ''
  if (!email || password.length < 12) {
    throw new Error('Set STAGING_SEED_ADMIN_EMAIL and STAGING_SEED_ADMIN_PASSWORD (at least 12 characters).')
  }
  if (!isStagingEmailAllowed(email)) throw new Error('STAGING_SEED_ADMIN_EMAIL is not on STAGING_ALLOWED_EMAILS.')
  return { email, password }
}

/** Demo firm, admin, client and opportunities. Returns the firm id. */
export async function seedStagingData(prisma: PrismaClient): Promise<string> {
  const { email, password } = readStagingSeedSettings()

  const firm = await prisma.consultingFirm.upsert({
    where: { contactEmail: FIRM_CONTACT },
    update: {},
    // Owner-comp: every feature is on without a Stripe subscription.
    create: { name: 'Staging Demo Firm', contactEmail: FIRM_CONTACT, isTest: true, isOwnerComp: true },
  })

  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, consultingFirmId: true } })
  if (existing && existing.consultingFirmId !== firm.id) {
    throw new Error('STAGING_SEED_ADMIN_EMAIL already belongs to another firm in this database.')
  }
  const admin = existing ?? await prisma.user.create({
    data: {
      email,
      passwordHash: await bcrypt.hash(password, 10),
      firstName: 'Staging',
      lastName: 'Admin',
      role: 'ADMIN',
      consultingFirmId: firm.id,
      isEmailVerified: true,
      emailVerifiedAt: new Date(),
    },
    select: { id: true, consultingFirmId: true },
  })

  const tos = await prisma.termsOfServiceVersion.findFirst({ where: { isCurrent: true } })
  if (tos && !(await prisma.userAgreement.findFirst({ where: { userId: admin.id, documentType: 'TOS', version: tos.version } }))) {
    await prisma.userAgreement.create({
      data: { userId: admin.id, documentType: 'TOS', documentId: tos.id, version: tos.version, contentHash: tos.contentHash, ip: '0.0.0.0::seed', userAgent: 'seed-staging' },
    })
  }

  if (!(await prisma.clientCompany.findFirst({ where: { consultingFirmId: firm.id, name: 'Staging Sample Client' } }))) {
    await prisma.clientCompany.create({
      data: { name: 'Staging Sample Client', uei: 'STAGINGUEI01', sdvosb: true, smallBusiness: true, consultingFirmId: firm.id },
    })
  }

  for (const { days, ...sample } of SAMPLE_OPPORTUNITIES) {
    if (await prisma.opportunity.findFirst({ where: { consultingFirmId: firm.id, title: sample.title } })) continue
    await prisma.opportunity.create({
      data: { ...sample, responseDeadline: new Date(Date.now() + days * 86_400_000), consultingFirmId: firm.id },
    })
  }

  return firm.id
}

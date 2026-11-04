// =============================================================
// Demo seed: legal documents and the operator who creates demo accounts.
//
// Refuses to run unless APP_ENV=demo. Safe to re-run. Doesn't reset the
// operator's password once the account exists.
//
// Run once (Render shell on bytescon-api-demo):
//   npm run db:seed-demo
// Needs DEMO_ADMIN_EMAIL (also on PLATFORM_ADMIN_EMAILS) and DEMO_ADMIN_PASSWORD.
// =============================================================
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'
import { loadLegalDocs } from '../seeds/loadLegal'
import { seedNaicsCodes } from '../seedNaics'
import { isDemo } from '../../src/services/appEnvironment'
import { isPlatformAdmin } from '../../src/middleware/platformAdmin'

async function main() {
  if (!isDemo()) throw new Error('Refusing to run: APP_ENV is not demo.')
  const email = (process.env.DEMO_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = process.env.DEMO_ADMIN_PASSWORD || ''
  if (!email || password.length < 12) throw new Error('Set DEMO_ADMIN_EMAIL and DEMO_ADMIN_PASSWORD (at least 12 characters).')
  if (!isPlatformAdmin(email)) throw new Error('DEMO_ADMIN_EMAIL must be on PLATFORM_ADMIN_EMAILS.')

  const prisma = new PrismaClient()
  try {
    await seedNaicsCodes(prisma)
    await loadLegalDocs(prisma)

    const contactEmail = 'demo-operators@demo.invalid'
    const firm = await prisma.consultingFirm.upsert({
      where: { contactEmail },
      update: {},
      create: { name: 'Bytescon Demo Operators', contactEmail, isOwnerComp: true },
    })
    let user = await prisma.user.findUnique({ where: { email }, select: { id: true } })
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          passwordHash: await bcrypt.hash(password, 10),
          firstName: 'Demo',
          lastName: 'Operator',
          role: 'ADMIN',
          consultingFirmId: firm.id,
          isEmailVerified: true,
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      })
    }
    const tos = await prisma.termsOfServiceVersion.findFirst({ where: { isCurrent: true } })
    if (tos && !(await prisma.userAgreement.findFirst({ where: { userId: user.id, documentType: 'TOS', version: tos.version } }))) {
      await prisma.userAgreement.create({
        data: { userId: user.id, documentType: 'TOS', documentId: tos.id, version: tos.version, contentHash: tos.contentHash, ip: '0.0.0.0::seed', userAgent: 'seed-demo' },
      })
    }
    console.log('Demo seed complete.')
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

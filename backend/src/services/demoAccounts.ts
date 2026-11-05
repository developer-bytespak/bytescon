// =============================================================
// Demo accounts: created by an operator, full access until they expire, and
// removed 30 days after that.
// =============================================================
import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors'
import { ensureSamplePipeline, regionForOtherLocation, regionForState, seedDemoSampleData, type UsRegion } from './demoSampleData'
import { ensureFinishedBidCards } from './demoSampleWork'
import { isPlatformAdmin } from '../middleware/platformAdmin'
import { forgetUserStanding } from './userStanding'

export const DEFAULT_DEMO_DAYS = 14
export const MAX_DEMO_DAYS = 90
export const DEMO_RETENTION_DAYS = 30
/** Proposal tokens for the life of the account. There's no monthly top-up. */
export const DEMO_PROPOSAL_TOKENS = 25
/** The form's choice for somewhere not on the state list. */
export const OTHER_LOCATION = 'OTHER'
const OPERATOR_FIRM_EMAIL = 'demo-operators@demo.invalid'

const DAY = 86_400_000
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000

function expiryFrom(days: number | undefined, now: Date): Date {
  const value = days ?? DEFAULT_DEMO_DAYS
  if (!Number.isInteger(value) || value < 1 || value > MAX_DEMO_DAYS) {
    throw new ValidationError(`Days must be a whole number from 1 to ${MAX_DEMO_DAYS}.`)
  }
  return new Date(now.getTime() + value * DAY)
}

/** Easy to read out or paste, with no characters that look alike. */
function generatePassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.randomBytes(16), (b) => alphabet[b % alphabet.length]).join('')
}

function regionFromInput(state: string | undefined, otherLocation: string | undefined): UsRegion | undefined {
  if (state === undefined) return undefined
  if (state === OTHER_LOCATION) {
    const location = (otherLocation ?? '').trim().replace(/\s+/g, ' ')
    // Goes into company names, so letters and ordinary name punctuation only.
    if (!/^\p{L}[\p{L} .'-]{1,39}$/u.test(location)) {
      throw new ValidationError('Enter the other location using letters, up to 40 characters.')
    }
    return regionForOtherLocation(location)
  }
  const region = regionForState(state)
  if (!region) throw new ValidationError('Choose a state from the list, or Other.')
  return region
}

/** Everything a person must have accepted before their first sign-in works. */
async function acceptCurrentTerms(userId: string): Promise<void> {
  const tos = await prisma.termsOfServiceVersion.findFirst({ where: { isCurrent: true } })
  if (!tos) return
  await prisma.userAgreement.create({
    data: { userId, documentType: 'TOS', documentId: tos.id, version: tos.version, contentHash: tos.contentHash, ip: '0.0.0.0::demo', userAgent: 'demo-account' },
  })
}

export async function createDemoAccount(input: {
  companyName: string
  contactName: string
  email: string
  days?: number
  now?: Date
  /** A state's code, or OTHER_LOCATION with the place in otherLocation. Picks the invented companies. */
  state?: string
  otherLocation?: string
}): Promise<{ firmId: string; email: string; password: string; expiresAt: Date }> {
  const now = input.now ?? new Date()
  const email = input.email.trim().toLowerCase()
  const companyName = input.companyName.trim()
  const contactName = input.contactName.trim()
  if (!companyName) throw new ValidationError('A company name is required.')
  if (!contactName) throw new ValidationError('A contact name is required.')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError('A valid email is required.')
  const region = regionFromInput(input.state, input.otherLocation)
  const expiresAt = expiryFrom(input.days, now)

  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) {
    throw new ConflictError('An account with this email already exists.')
  }

  const password = generatePassword()
  const [firstName, ...rest] = contactName.split(/\s+/)
  const firm = await prisma.consultingFirm.create({
    data: {
      name: companyName,
      // Firm contact emails are unique, and a demo firm's isn't used for anything.
      contactEmail: `demo-${crypto.randomUUID()}@demo.invalid`,
      demoExpiresAt: expiresAt,
      proposalTokens: DEMO_PROPOSAL_TOKENS,
    },
  })
  try {
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash: await bcrypt.hash(password, 10),
        firstName,
        lastName: rest.join(' ') || companyName,
        role: 'ADMIN',
        consultingFirmId: firm.id,
        isEmailVerified: true,
        emailVerifiedAt: now,
      },
      select: { id: true },
    })
    await acceptCurrentTerms(user.id)
    await seedDemoSampleData(firm.id, user.id, region)
  } catch (err) {
    // No half-built account left behind. The firm's rows cascade with it.
    await prisma.consultingFirm.delete({ where: { id: firm.id } }).catch(() => undefined)
    throw err
  }
  logger.info('Demo account created', { firmId: firm.id, expiresAt })
  return { firmId: firm.id, email, password, expiresAt }
}

/**
 * The operator who creates demo accounts, from DEMO_ADMIN_EMAIL and
 * DEMO_ADMIN_PASSWORD. Runs at startup because free hosting has no shell to run a
 * setup command in. Never changes an existing account's password.
 */
export async function ensureDemoOperator(): Promise<void> {
  const email = (process.env.DEMO_ADMIN_EMAIL || '').trim().toLowerCase()
  const password = process.env.DEMO_ADMIN_PASSWORD || ''
  if (!email && !password) return
  if (password.length < 12) throw new Error('DEMO_ADMIN_PASSWORD needs at least 12 characters.')
  if (!isPlatformAdmin(email)) throw new Error('DEMO_ADMIN_EMAIL must be on PLATFORM_ADMIN_EMAILS.')

  const firm = await prisma.consultingFirm.upsert({
    where: { contactEmail: OPERATOR_FIRM_EMAIL },
    update: {},
    create: { name: 'Bytescon Demo Operators', contactEmail: OPERATOR_FIRM_EMAIL, isOwnerComp: true },
  })
  if (await prisma.user.findUnique({ where: { email }, select: { id: true } })) return
  const user = await prisma.user.create({
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
  await acceptCurrentTerms(user.id)
  logger.info('Demo operator created')
}

/**
 * Gives the operator login the same sample data as a client, so they can show the
 * product from it. Only ever fills an empty account, so a restart can't undo their
 * changes or add a second copy. Run after startup: it takes several seconds, and
 * failing must not stop the server.
 */
export async function seedDemoOperatorData(): Promise<void> {
  const email = (process.env.DEMO_ADMIN_EMAIL || '').trim().toLowerCase()
  if (!email) return
  const firm = await prisma.consultingFirm.findUnique({ where: { contactEmail: OPERATOR_FIRM_EMAIL }, select: { id: true } })
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, consultingFirmId: true } })
  if (!firm || user?.consultingFirmId !== firm.id) return
  if (await prisma.clientCompany.count({ where: { consultingFirmId: firm.id } })) return
  await seedDemoSampleData(firm.id, user.id)
  logger.info('Sample data added to the demo operator account')
}

/**
 * Brings accounts created earlier up to what a new one starts with, so the operator
 * and every client see the same thing. Only adds what's missing, so it's safe to run
 * at every start and never undoes someone's changes.
 */
export async function topUpDemoAccounts(now: Date = new Date()): Promise<void> {
  const firms = await prisma.consultingFirm.findMany({
    where: { OR: [{ demoExpiresAt: { gt: now } }, { contactEmail: OPERATOR_FIRM_EMAIL }] },
    select: { id: true },
  })
  for (const { id: consultingFirmId } of firms) {
    try {
      const owner = await prisma.user.findFirst({ where: { consultingFirmId, role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } })
      const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId }, orderBy: { createdAt: 'asc' } })
      if (!owner || clients.length < 3) continue
      const placed = await prisma.opportunity.findFirst({ where: { consultingFirmId, placeOfPerformance: { not: null } }, select: { placeOfPerformance: true } })
      await ensureSamplePipeline(consultingFirmId, owner.id, clients, placed?.placeOfPerformance ?? null)
      await ensureFinishedBidCards(consultingFirmId, owner.id)
    } catch (err) {
      // One account's problem mustn't stop the rest. It's retried at the next start.
      logger.error('Could not top up a demo account', { consultingFirmId, error: (err as Error).message })
    }
  }
}

export async function listDemoAccounts(now: Date = new Date()) {
  const firms = await prisma.consultingFirm.findMany({
    where: { demoExpiresAt: { not: null } },
    orderBy: { demoExpiresAt: 'desc' },
    select: {
      id: true,
      name: true,
      demoExpiresAt: true,
      createdAt: true,
      users: { where: { role: 'ADMIN' }, take: 1, orderBy: { createdAt: 'asc' }, select: { email: true, firstName: true, lastName: true } },
    },
  })
  return firms.map((firm) => ({
    firmId: firm.id,
    companyName: firm.name,
    contactName: firm.users[0] ? `${firm.users[0].firstName} ${firm.users[0].lastName}`.trim() : null,
    email: firm.users[0]?.email ?? null,
    createdAt: firm.createdAt,
    expiresAt: firm.demoExpiresAt as Date,
    expired: (firm.demoExpiresAt as Date) <= now,
  }))
}

async function demoFirmUsers(firmId: string): Promise<string[]> {
  const firm = await prisma.consultingFirm.findFirst({
    where: { id: firmId, demoExpiresAt: { not: null } },
    select: { users: { select: { id: true } } },
  })
  if (!firm) throw new NotFoundError('Demo account')
  return firm.users.map((u) => u.id)
}

/** Sets a new end date, counted from now. Also how an expired demo is reopened. */
export async function extendDemoAccount(firmId: string, days: number, now: Date = new Date()): Promise<Date> {
  const expiresAt = expiryFrom(days, now)
  const users = await demoFirmUsers(firmId)
  await prisma.consultingFirm.update({ where: { id: firmId }, data: { demoExpiresAt: expiresAt } })
  users.forEach(forgetUserStanding)
  return expiresAt
}

/** Ends a demo now. Sessions stop at once on this server. */
export async function endDemoAccount(firmId: string, now: Date = new Date()): Promise<void> {
  const users = await demoFirmUsers(firmId)
  await prisma.consultingFirm.update({ where: { id: firmId }, data: { demoExpiresAt: now } })
  users.forEach(forgetUserStanding)
}

/** Replaces a lost password. The new one is only ever shown to the operator. */
export async function resetDemoPassword(firmId: string): Promise<{ email: string; password: string }> {
  const firm = await prisma.consultingFirm.findFirst({
    where: { id: firmId, demoExpiresAt: { not: null } },
    select: { users: { where: { role: 'ADMIN' }, take: 1, orderBy: { createdAt: 'asc' }, select: { id: true, email: true } } },
  })
  const user = firm?.users[0]
  if (!user) throw new NotFoundError('Demo account')
  const password = generatePassword()
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(password, 10) } })
  return { email: user.email, password }
}

/** Removes demo accounts that ended more than DEMO_RETENTION_DAYS ago. */
export async function purgeExpiredDemoAccounts(now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - DEMO_RETENTION_DAYS * DAY)
  const firms = await prisma.consultingFirm.findMany({ where: { demoExpiresAt: { lt: cutoff } }, select: { id: true } })
  let removed = 0
  for (const firm of firms) {
    try {
      await prisma.consultingFirm.delete({ where: { id: firm.id } })
      removed++
    } catch (err) {
      // One stuck account mustn't stop the rest. It's retried on the next pass.
      logger.error('Could not remove an expired demo account', { firmId: firm.id, error: (err as Error).message })
    }
  }
  if (removed) logger.info('Removed expired demo accounts', { removed })
  return removed
}

export function startDemoPurge(): void {
  const run = () => void purgeExpiredDemoAccounts().catch((err) => {
    logger.error('Demo account cleanup failed', { error: (err as Error).message })
  })
  run()
  setInterval(run, PURGE_EVERY_MS).unref()
}

// =============================================================
// Recipient Profile Service
//
// Drill-down for any UEI surfaced in subaward / prime award tables.
// Caches SAM.gov enrichment in `recipient_profiles` and serves
// subaward + prime-award history from the WinnersIntel staging
// tables (already populated by the existing winners-intel worker).
//
// Not tenant-scoped: recipient data is shared public info, identical
// to WinnersAwardStage / WinnersSubawardStage.
// =============================================================

import type { RecipientProfile } from '@prisma/client'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { lookupEntityByUEI } from './samEntityApi'
import {
  getContactProvider,
  getDefaultProvider,
  type ContactRow,
} from './contactProviders'
import { ValidationError } from '../utils/errors'

const STALE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

function isStale(t: Date | null | undefined): boolean {
  return !t || Date.now() - t.getTime() > STALE_MS
}

function normalizeUei(uei: string): string {
  return uei.trim().toUpperCase()
}

export async function getOrFetchProfile(
  rawUei: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<RecipientProfile> {
  const uei = normalizeUei(rawUei)
  if (!/^[A-Z0-9]{12}$/.test(uei)) {
    throw new ValidationError(`Invalid UEI format: ${rawUei}`)
  }

  let row = await prisma.recipientProfile.findUnique({ where: { uei } })

  if (!opts.forceRefresh && row && !isStale(row.samFetchedAt)) {
    return row
  }

  try {
    const sam = await lookupEntityByUEI(uei)
    if (sam) {
      const data = {
        uei,
        legalName: sam.name,
        cageCode: sam.cage,
        samRegStatus: sam.samRegStatus,
        samRegExpiry: sam.samRegExpiry,
        website: sam.website,
        phone: sam.phone,
        streetAddress: sam.streetAddress,
        city: sam.city,
        state: sam.state,
        zipCode: sam.zipCode,
        naicsCodes: sam.naicsCodes,
        sdvosb: sam.sdvosb,
        wosb: sam.wosb,
        hubzone: sam.hubzone,
        smallBusiness: sam.smallBusiness,
        samFetchedAt: new Date(),
      }
      row = await prisma.recipientProfile.upsert({
        where: { uei },
        create: data,
        update: data,
      })
      return row
    }

    logger.info('SAM returned no entity for UEI; serving stub profile', { uei })
  } catch (err) {
    logger.warn('SAM enrichment failed; falling back to cache or stub', {
      uei,
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // SAM miss or failure: return existing row if we have one, else create a minimal stub
  // so the frontend can still render the rest of the drill-down (subawards + primes).
  if (row) return row
  return prisma.recipientProfile.create({ data: { uei } })
}

export interface RecipientSubawardRow {
  id: string
  subAmount: number
  subActionDate: Date | null
  subNaics: string | null
  subDescription: string | null
  primeAwardId: string
  primeRecipientName: string | null
  primeRecipientUei: string | null
  agencyToptierName: string | null
  agencyToptierCode: string | null
}

export async function getSubawardHistory(
  rawUei: string,
  limit = 50,
): Promise<RecipientSubawardRow[]> {
  const uei = normalizeUei(rawUei)
  type Row = {
    id: string
    subAmount: bigint | string | number | null
    subActionDate: Date | null
    subNaics: string | null
    subDescription: string | null
    primeAwardId: string
    primeRecipientName: string | null
    primeRecipientUei: string | null
    agencyToptierName: string | null
    agencyToptierCode: string | null
  }
  const rows = await prisma.$queryRaw<Row[]>`
    SELECT
      sub.id,
      sub."subAmount",
      sub."subActionDate",
      sub."subNaics",
      sub."subDescription",
      sub."primeAwardId",
      prime."recipientName" as "primeRecipientName",
      prime."recipientUei"  as "primeRecipientUei",
      prime."agencyToptierName",
      prime."agencyToptierCode"
    FROM winners_subaward_stage sub
    LEFT JOIN winners_award_stage prime
      ON prime."usaspendingAwardId" = sub."primeAwardId"
    WHERE sub."subRecipientUei" = ${uei}
    ORDER BY sub."subActionDate" DESC NULLS LAST
    LIMIT ${limit}
  `
  return rows.map((r) => ({
    id: r.id,
    subAmount: Number(r.subAmount ?? 0),
    subActionDate: r.subActionDate,
    subNaics: r.subNaics,
    subDescription: r.subDescription,
    primeAwardId: r.primeAwardId,
    primeRecipientName: r.primeRecipientName,
    primeRecipientUei: r.primeRecipientUei,
    agencyToptierName: r.agencyToptierName,
    agencyToptierCode: r.agencyToptierCode,
  }))
}

export interface RecipientPrimeAwardRow {
  id: string
  usaspendingAwardId: string
  agencyToptierName: string | null
  agencyToptierCode: string | null
  naics: string | null
  pscCode: string | null
  totalObligation: number
  baseAndAllOptions: number
  awardDate: Date | null
  periodOfPerformanceStart: Date | null
  periodOfPerformanceEnd: Date | null
  setAsideType: string | null
}

export async function getPrimeAwards(
  rawUei: string,
  limit = 50,
): Promise<RecipientPrimeAwardRow[]> {
  const uei = normalizeUei(rawUei)
  const rows = await prisma.winnersAwardStage.findMany({
    where: { recipientUei: uei },
    orderBy: { awardDate: 'desc' },
    take: limit,
    select: {
      id: true,
      usaspendingAwardId: true,
      agencyToptierName: true,
      agencyToptierCode: true,
      naics: true,
      pscCode: true,
      totalObligation: true,
      baseAndAllOptions: true,
      awardDate: true,
      periodOfPerformanceStart: true,
      periodOfPerformanceEnd: true,
      setAsideType: true,
    },
  })
  return rows.map((r) => ({
    id: r.id,
    usaspendingAwardId: r.usaspendingAwardId,
    agencyToptierName: r.agencyToptierName,
    agencyToptierCode: r.agencyToptierCode,
    naics: r.naics,
    pscCode: r.pscCode,
    totalObligation: Number(r.totalObligation ?? 0),
    baseAndAllOptions: Number(r.baseAndAllOptions ?? 0),
    awardDate: r.awardDate,
    periodOfPerformanceStart: r.periodOfPerformanceStart,
    periodOfPerformanceEnd: r.periodOfPerformanceEnd,
    setAsideType: r.setAsideType,
  }))
}

export interface EnrichContactsResult {
  contacts: ContactRow[]
  provider: string
  fetchedAt: Date | null
}

export async function enrichContacts(
  rawUei: string,
  providerKey?: string,
): Promise<EnrichContactsResult> {
  const uei = normalizeUei(rawUei)

  const provider = providerKey
    ? getContactProvider(providerKey)
    : getDefaultProvider()
  if (!provider) {
    throw new ValidationError(
      providerKey
        ? `Unknown contact provider: ${providerKey}`
        : 'No contact provider is configured. Set SAM_API_KEY or add a provider.',
    )
  }
  if (!provider.isAvailable()) {
    throw new ValidationError(
      `Contact provider ${provider.key} is not configured (missing API key or credentials).`,
    )
  }

  const profile = await getOrFetchProfile(uei)

  const contacts = await provider.fetchContacts({
    uei,
    legalName: profile.legalName ?? null,
    website: profile.website ?? null,
  })

  const providerLabel = provider.key
  const capped = contacts.slice(0, 50)

  const updated = await prisma.recipientProfile.update({
    where: { uei },
    data: {
      contactsJson: capped as unknown as object,
      contactsProvider: providerLabel,
      contactsFetchedAt: new Date(),
    },
    select: { contactsFetchedAt: true },
  })

  return {
    contacts: capped,
    provider: providerLabel,
    fetchedAt: updated.contactsFetchedAt,
  }
}

/**
 * Append supplemental contacts not already represented in the primary set.
 * Dedupe by email (case-insensitive); for emailless rows, by name+phone.
 * Pure — unit-tested without a DB.
 */
export function mergeSupplementalContacts(
  primary: ContactRow[],
  supplemental: ContactRow[],
): ContactRow[] {
  const seenEmails = new Set(
    primary.map((c) => c.email?.toLowerCase()).filter(Boolean) as string[],
  )
  const seenNamePhone = new Set(
    primary.map((c) => `${(c.name ?? '').toLowerCase()}|${c.phone ?? ''}`),
  )
  const additions = supplemental.filter((c) => {
    if (c.email && seenEmails.has(c.email.toLowerCase())) return false
    if (!c.email && seenNamePhone.has(`${(c.name ?? '').toLowerCase()}|${c.phone ?? ''}`)) {
      return false
    }
    return true
  })
  return additions.length ? [...primary, ...additions] : primary
}

export function readCachedContacts(profile: RecipientProfile): {
  contacts: ContactRow[]
  provider: string | null
  fetchedAt: Date | null
} {
  const raw = profile.contactsJson
  let contacts: ContactRow[] = []
  if (Array.isArray(raw)) {
    contacts = raw as unknown as ContactRow[]
  }
  return {
    contacts,
    provider: profile.contactsProvider,
    fetchedAt: profile.contactsFetchedAt,
  }
}

import axios from 'axios'
import { logger } from '../utils/logger'

const SAM_ENTITY_BASE = 'https://api.sam.gov/entity-information/v3/entities'

// SBA business type codes for certifications (in coreData.businessTypes.sbaBusinessTypeList)
const SDVOSB_DESCS = ['service-disabled veteran', 'sdvosb']
const WOSB_DESCS   = ['woman-owned', 'women-owned', 'wosb', 'edwosb']
const HUBZONE_DESCS = ['hubzone']

export interface SamPoc {
  role: string
  name: string | null
  title: string | null
  email: string | null
  phone: string | null
}

function fullName(p: any): string | null {
  if (!p) return null
  const parts = [p.firstName, p.middleInitial, p.lastName].filter(Boolean)
  const name = parts.join(' ').trim()
  return name.length ? name : null
}

function mapPoc(role: string, raw: any): SamPoc | null {
  if (!raw || typeof raw !== 'object') return null
  const name = fullName(raw)
  const email = raw.email ?? null
  const phone = raw.usPhone ?? raw.internationalPhone ?? null
  if (!name && !email && !phone) return null
  return {
    role,
    name,
    title: raw.title ?? null,
    email,
    phone,
  }
}

function extractPocs(entity: any): SamPoc[] {
  const pocs = entity.pointsOfContact ?? {}
  const candidates: Array<[string, any]> = [
    ['government_business', pocs.governmentBusinessPOC],
    ['government_business_alt', pocs.governmentBusinessPOCAlternate],
    ['electronic_business', pocs.electronicBusinessPOC],
    ['electronic_business_alt', pocs.electronicBusinessPOCAlternate],
    ['past_performance', pocs.pastPerformancePOC],
    ['past_performance_alt', pocs.pastPerformancePOCAlternate],
  ]
  return candidates
    .map(([role, raw]) => mapPoc(role, raw))
    .filter((p): p is SamPoc => p !== null)
}

function mapEntity(entity: any) {
  const reg  = entity.entityRegistration ?? {}
  const core = entity.coreData          ?? {}
  const assertions = entity.assertions  ?? {}

  // Address is in coreData.physicalAddress (not entityRegistration)
  const addr = core.physicalAddress ?? {}

  // Website in coreData.entityInformation
  const info = core.entityInformation ?? {}

  // NAICS codes are in assertions.goodsAndServices.naicsList (not naicsCode)
  const naicsArr: any[] = assertions.goodsAndServices?.naicsList ?? []
  const naicsCodes: string[] = naicsArr
    .map((n: any) => String(n.naicsCode ?? ''))
    .filter(Boolean)

  // Determine small business from sbaSmallBusiness flag in naicsList
  const smallBusiness = naicsArr.some((n: any) => n.sbaSmallBusiness === 'Y')

  // Certifications live in coreData.businessTypes.sbaBusinessTypeList
  const sbaBizTypes: any[] = core.businessTypes?.sbaBusinessTypeList ?? []
  const sbaDescs = sbaBizTypes
    .map((b: any) => String(b.sbaBusinessTypeDesc ?? '').toLowerCase())
    .join(' ')

  const sdvosb = SDVOSB_DESCS.some((d) => sbaDescs.includes(d))
  const wosb   = WOSB_DESCS.some((d) => sbaDescs.includes(d))
  const hubzone = HUBZONE_DESCS.some((d) => sbaDescs.includes(d))

  const pocs = extractPocs(entity)
  // Phone preference: governmentBusiness POC, then electronicBusiness, then any.
  const phoneFromPoc =
    pocs.find((p) => p.role === 'government_business')?.phone
    ?? pocs.find((p) => p.role === 'electronic_business')?.phone
    ?? pocs.find((p) => p.phone)?.phone
    ?? null

  return {
    name:          reg.legalBusinessName              ?? null,
    uei:           reg.ueiSAM                         ?? null,
    cage:          reg.cageCode                       ?? null,
    samRegStatus:  reg.registrationStatus             ?? null,
    samRegExpiry:  reg.registrationExpirationDate
      ? new Date(reg.registrationExpirationDate)
      : null,
    website:       info.entityURL                     ?? null,
    phone:         phoneFromPoc,
    streetAddress: addr.addressLine1                  ?? null,
    city:          addr.city                          ?? null,
    state:         addr.stateOrProvinceCode           ?? null,
    zipCode:       addr.zipCode                       ?? null,
    naicsCodes,
    sdvosb,
    wosb,
    hubzone,
    smallBusiness: smallBusiness || sdvosb || wosb || hubzone,
    pocs,
  }
}

export type SamEntity = ReturnType<typeof mapEntity>

async function fetchEntities(params: Record<string, string>) {
  const apiKey = process.env.SAM_API_KEY
  if (!apiKey) throw new Error('SAM_API_KEY not configured')

  let res: any
  try {
    res = await axios.get(SAM_ENTITY_BASE, {
      params: {
        api_key: apiKey,
        includeSections: 'entityRegistration,coreData,assertions,pointsOfContact',
        ...params,
      },
      timeout: 20000,
    })
  } catch (axiosErr: any) {
    const samBody = axiosErr.response?.data
    const samMsg =
      samBody?.message ??
      samBody?.title   ??
      samBody?.error   ??
      axiosErr.message ??
      'SAM.gov request failed'
    const status = axiosErr.response?.status ?? 0
    logger.warn('SAM entity API HTTP error', { status, samMsg, params })
    throw new Error(`SAM.gov (HTTP ${status}): ${samMsg}`)
  }

  // SAM sometimes returns 200 with an error body
  if (res.data?.errorCode || res.data?.message) {
    const msg = res.data.message ?? res.data.detail ?? 'SAM.gov returned an error'
    logger.warn('SAM entity API returned error body', { msg, params })
    throw new Error(`SAM.gov: ${msg}`)
  }

  logger.debug('SAM entity API response', {
    totalRecords: res.data?.totalRecords,
    params,
  })

  const entities: any[] = res.data?.entityData ?? []
  return entities.length > 0 ? mapEntity(entities[0]) : null
}

/** Look up by 12-character UEI (most reliable) */
export async function lookupEntityByUEI(uei: string) {
  const clean = uei.trim().toUpperCase()
  logger.info('SAM entity lookup by UEI', { uei: clean })
  return fetchEntities({ ueiSAM: clean })
}

/** Look up by CAGE code */
export async function lookupEntityByCAGE(cage: string) {
  const clean = cage.trim().toUpperCase()
  logger.info('SAM entity lookup by CAGE', { cage: clean })
  return fetchEntities({ cageCode: clean })
}

/** Look up by legal business name (returns first active match) */
export async function lookupEntityByName(name: string) {
  logger.info('SAM entity lookup by name', { name })
  const result = await fetchEntities({ legalBusinessName: name.trim(), registrationStatus: 'Active' })
  return result
}

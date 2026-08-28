// =============================================================
// Seed loader for the FAR / DFARS / NIST / CMMC / Section 508
// regulatory ontology. Idempotent — safe to run on every seed
// or as a quarterly catalog-refresh cron.
// =============================================================
import * as fs from 'fs'
import * as path from 'path'
import { PrismaClient } from '@prisma/client'

const SEED_DIR = path.join(__dirname, 'far')

interface FarClauseSeed {
  code: string
  partNumber: string
  subpartNumber?: string
  title: string
  prescribedAt?: string | null
  applicableContractTypes?: string[]
  setAsideTriggers?: string[]
  agencyTriggers?: string[]
  flowDownRequired?: boolean
  flowDownThreshold?: number | null
  prerequisiteClauseCodes?: string[]
  prohibitedClauseCodes?: string[]
  commercialItemException?: boolean
  isBlocking?: boolean
  effectiveDate?: string | null
  lastRevisedDate?: string | null
  text?: string
  summary?: string | null
  tags?: string[]
}

interface DfarsClauseSeed extends Omit<FarClauseSeed, 'setAsideTriggers' | 'prohibitedClauseCodes' | 'commercialItemException'> {}

interface NistSeed { controlId: string; family: string; title: string; description?: string; cmmcLevels?: number[] }
interface CmmcSeed { practiceId: string; level: number; domain: string; title: string; description?: string; nistMapping?: string[] }
interface Section508Seed { criterionId: string; category: string; title: string; description?: string; appliesTo?: string[] }

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), 'utf-8')) as T
}

export async function loadFarCatalog(prisma: PrismaClient): Promise<void> {
  const farClauses = readJson<FarClauseSeed[]>('clauses.json')
  const dfarsClauses = readJson<DfarsClauseSeed[]>('dfars.json')
  const nistControls = readJson<NistSeed[]>('nist-800-171.json')
  const cmmcPractices = readJson<CmmcSeed[]>('cmmc-2.json')
  const section508 = readJson<Section508Seed[]>('section-508.json')

  console.log(`Seeding FAR catalog: ${farClauses.length} FAR / ${dfarsClauses.length} DFARS / ${nistControls.length} NIST / ${cmmcPractices.length} CMMC / ${section508.length} Section 508`)

  for (const c of farClauses) {
    await prisma.farClause.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        partNumber: c.partNumber,
        subpartNumber: c.subpartNumber ?? null,
        title: c.title,
        prescribedAt: c.prescribedAt ?? null,
        applicableContractTypes: c.applicableContractTypes ?? [],
        setAsideTriggers: c.setAsideTriggers ?? [],
        agencyTriggers: c.agencyTriggers ?? [],
        flowDownRequired: c.flowDownRequired ?? false,
        flowDownThreshold: c.flowDownThreshold ?? null,
        prerequisiteClauseCodes: c.prerequisiteClauseCodes ?? [],
        prohibitedClauseCodes: c.prohibitedClauseCodes ?? [],
        commercialItemException: c.commercialItemException ?? false,
        isBlocking: c.isBlocking ?? false,
        effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
        lastRevisedDate: c.lastRevisedDate ? new Date(c.lastRevisedDate) : null,
        text: c.text ?? '',
        summary: c.summary ?? null,
        tags: c.tags ?? [],
      },
      update: {
        title: c.title,
        partNumber: c.partNumber,
        subpartNumber: c.subpartNumber ?? null,
        prescribedAt: c.prescribedAt ?? null,
        applicableContractTypes: c.applicableContractTypes ?? [],
        setAsideTriggers: c.setAsideTriggers ?? [],
        agencyTriggers: c.agencyTriggers ?? [],
        flowDownRequired: c.flowDownRequired ?? false,
        flowDownThreshold: c.flowDownThreshold ?? null,
        prerequisiteClauseCodes: c.prerequisiteClauseCodes ?? [],
        prohibitedClauseCodes: c.prohibitedClauseCodes ?? [],
        commercialItemException: c.commercialItemException ?? false,
        isBlocking: c.isBlocking ?? false,
        effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
        lastRevisedDate: c.lastRevisedDate ? new Date(c.lastRevisedDate) : null,
        text: c.text ?? '',
        summary: c.summary ?? null,
        tags: c.tags ?? [],
      },
    })
  }

  for (const c of dfarsClauses) {
    await prisma.dfarsClause.upsert({
      where: { code: c.code },
      create: {
        code: c.code,
        partNumber: c.partNumber,
        title: c.title,
        prescribedAt: c.prescribedAt ?? null,
        applicableContractTypes: c.applicableContractTypes ?? [],
        agencyTriggers: c.agencyTriggers ?? ['DOD'],
        flowDownRequired: c.flowDownRequired ?? false,
        flowDownThreshold: c.flowDownThreshold ?? null,
        prerequisiteClauseCodes: c.prerequisiteClauseCodes ?? [],
        isBlocking: c.isBlocking ?? false,
        effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
        lastRevisedDate: c.lastRevisedDate ? new Date(c.lastRevisedDate) : null,
        text: c.text ?? '',
        summary: c.summary ?? null,
        tags: c.tags ?? [],
      },
      update: {
        title: c.title,
        partNumber: c.partNumber,
        prescribedAt: c.prescribedAt ?? null,
        applicableContractTypes: c.applicableContractTypes ?? [],
        agencyTriggers: c.agencyTriggers ?? ['DOD'],
        flowDownRequired: c.flowDownRequired ?? false,
        flowDownThreshold: c.flowDownThreshold ?? null,
        prerequisiteClauseCodes: c.prerequisiteClauseCodes ?? [],
        isBlocking: c.isBlocking ?? false,
        effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
        lastRevisedDate: c.lastRevisedDate ? new Date(c.lastRevisedDate) : null,
        text: c.text ?? '',
        summary: c.summary ?? null,
        tags: c.tags ?? [],
      },
    })
  }

  for (const n of nistControls) {
    await prisma.nist800171Control.upsert({
      where: { controlId: n.controlId },
      create: {
        controlId: n.controlId,
        family: n.family,
        title: n.title,
        description: n.description ?? '',
        cmmcLevels: n.cmmcLevels ?? [],
      },
      update: {
        family: n.family,
        title: n.title,
        description: n.description ?? '',
        cmmcLevels: n.cmmcLevels ?? [],
      },
    })
  }

  for (const c of cmmcPractices) {
    await prisma.cmmcPractice.upsert({
      where: { practiceId: c.practiceId },
      create: {
        practiceId: c.practiceId,
        level: c.level,
        domain: c.domain,
        title: c.title,
        description: c.description ?? '',
        nistMapping: c.nistMapping ?? [],
      },
      update: {
        level: c.level,
        domain: c.domain,
        title: c.title,
        description: c.description ?? '',
        nistMapping: c.nistMapping ?? [],
      },
    })
  }

  for (const s of section508) {
    await prisma.section508Criterion.upsert({
      where: { criterionId: s.criterionId },
      create: {
        criterionId: s.criterionId,
        category: s.category,
        title: s.title,
        description: s.description ?? '',
        appliesTo: s.appliesTo ?? [],
      },
      update: {
        category: s.category,
        title: s.title,
        description: s.description ?? '',
        appliesTo: s.appliesTo ?? [],
      },
    })
  }

  console.log('FAR catalog seed complete.')
}

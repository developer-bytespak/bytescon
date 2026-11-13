// =============================================================
// Bring a notice's solicitation documents in from SAM.gov.
//
// SAM.gov lists each notice's attachments (Opportunity.resourceLinks, kept by
// the import). This downloads them and adds each as an opportunity document,
// exactly as if a person had uploaded it: stored through fileStorage, the
// SOLICITATION_DOCUMENT_ADDED event, and PDFs queued for requirement
// extraction, which fills the Compliance Matrix with UNVERIFIED requirements
// for a person to check. Nothing is verified here.
//
// Rationed: it runs when a proposal is started or a person asks, at most
// MAX_FILES per notice, MAX_BYTES each, and a file already added (same name)
// is skipped. Files SAM.gov won't hand over (restricted / controlled) are
// reported so the person can download and upload them.
// =============================================================
import axios, { AxiosError } from 'axios'
import crypto from 'crypto'
import path from 'path'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { writeUpload } from './fileStorage'
import { emitSolicitationDocumentAdded } from './agents/compliance/complianceEvents'
import { samAttachments } from './samNoticeDetails'
import { getGb107Config } from '../gb107/config.gb107'

export const MAX_FILES = 10
export const MAX_BYTES = 25 * 1024 * 1024
const TIMEOUT_MS = 60_000

export type AttachmentOutcome = 'imported' | 'already-added' | 'restricted' | 'too-large' | 'failed'
export interface AttachmentResult { label: string; url: string; outcome: AttachmentOutcome; fileName: string | null; readAutomatically: boolean; message: string }

const PDF = 'application/pdf'
const MIME_BY_EXT: Record<string, string> = {
  '.pdf': PDF,
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
}

/** The file name from a Content-Disposition header (RFC 5987 form first). Pure. */
export function fileNameFromDisposition(header: string | undefined | null): string | null {
  if (!header) return null
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/.exec(header)
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/^"|"$/g, '')) } catch { /* fall through */ } }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header)
  return plain ? plain[1].trim() : null
}

/** A safe display name: no folders, no control characters. Pure. */
export function safeFileName(name: string | null, fallback: string): string {
  const base = (name ?? '').split(/[\\/]/).pop()!.replace(/[\x00-\x1f]/g, '').trim()
  return base.slice(0, 200) || fallback
}

async function download(url: string) {
  const attempt = (withKey: boolean) => {
    const key = getGb107Config().samGovApiKey
    const target = new URL(url)
    if (withKey && key) target.searchParams.set('api_key', key)
    return axios.get<ArrayBuffer>(target.toString(), { responseType: 'arraybuffer', timeout: TIMEOUT_MS, maxContentLength: MAX_BYTES, maxRedirects: 5, validateStatus: () => true })
  }
  // SAM.gov's public files usually need no key; try with it only if refused.
  let res = await attempt(false)
  if ((res.status === 401 || res.status === 403) && getGb107Config().samGovApiKey) res = await attempt(true)
  return res
}

/**
 * Import the notice's SAM.gov attachments for this firm. Returns what happened
 * to each, in order. Never throws for one bad file.
 */
export async function importSamAttachments(consultingFirmId: string, opportunityId: string): Promise<{ results: AttachmentResult[]; queuedForReading: number }> {
  const opp = await prisma.opportunity.findFirst({ where: { id: opportunityId, consultingFirmId }, select: { id: true, resourceLinks: true, documents: { select: { fileName: true } } } })
  if (!opp) return { results: [], queuedForReading: 0 }
  const have = new Set(opp.documents.map((d) => d.fileName.toLowerCase()))
  const links = samAttachments(opp.resourceLinks).slice(0, MAX_FILES)
  const results: AttachmentResult[] = []
  const toRead: string[] = []

  for (const link of links) {
    const base = { label: link.label, url: link.url }
    try {
      const res = await download(link.url)
      if (res.status === 401 || res.status === 403) {
        results.push({ ...base, outcome: 'restricted', fileName: null, readAutomatically: false, message: 'SAM.gov restricts this file (often controlled or export-controlled). Download it from SAM.gov and upload it here.' })
        continue
      }
      if (res.status < 200 || res.status >= 300) {
        results.push({ ...base, outcome: 'failed', fileName: null, readAutomatically: false, message: `SAM.gov answered ${res.status}. Try again later, or download it from SAM.gov and upload it here.` })
        continue
      }
      const buffer = Buffer.from(res.data)
      const fileName = safeFileName(fileNameFromDisposition(res.headers['content-disposition'] as string | undefined), `${link.label}.pdf`)
      if (have.has(fileName.toLowerCase())) {
        results.push({ ...base, outcome: 'already-added', fileName, readAutomatically: false, message: 'Already added to this opportunity.' })
        continue
      }
      const ext = path.extname(fileName).toLowerCase()
      const headerType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      const isPdf = ext === '.pdf' || headerType === PDF || buffer.subarray(0, 5).toString('latin1') === '%PDF-'
      const fileType = isPdf ? PDF : (MIME_BY_EXT[ext] ?? 'application/octet-stream')
      const storageKey = `${Date.now()}-${crypto.randomUUID()}${ext || (isPdf ? '.pdf' : '')}`
      await writeUpload(storageKey, buffer, fileType)

      // Same as a person's upload (routes/documents.ts): one transaction with the event.
      const document = await prisma.$transaction(async (tx) => {
        const row = await tx.opportunityDocument.create({
          data: { opportunityId, fileName, fileUrl: null, storageKey, fileType, fileSize: buffer.length, isAmendment: false, analysisStatus: 'PENDING', extractionStatus: isPdf ? 'PENDING' : 'NOT_READ' },
        })
        await emitSolicitationDocumentAdded(tx, { consultingFirmId, documentId: row.id, opportunityId, fileName, fileType, isAmendment: false })
        return row
      })
      have.add(fileName.toLowerCase())
      if (isPdf) toRead.push(document.id)
      results.push({ ...base, outcome: 'imported', fileName, readAutomatically: isPdf, message: isPdf ? 'Added; its requirements are being read into the Compliance Matrix.' : 'Added. Only PDFs are read automatically; add this file\'s requirements by hand.' })
    } catch (err) {
      const e = err as AxiosError
      const tooLarge = /maxContentLength/i.test(e.message ?? '')
      results.push({ ...base, outcome: tooLarge ? 'too-large' : 'failed', fileName: null, readAutomatically: false, message: tooLarge ? 'Larger than 25 MB. Download it from SAM.gov and upload it here.' : 'Could not download it. Try again later, or download it from SAM.gov and upload it here.' })
      logger.warn('SAM.gov attachment import failed', { opportunityId, label: link.label, error: e.message })
    }
  }

  if (toRead.length) {
    const { queueRequirementExtraction } = await import('../workers/requirementExtractionWorker')
    for (const id of toRead) await queueRequirementExtraction(id).catch((err) => logger.warn('Could not queue requirement extraction', { documentId: id, error: (err as Error).message }))
  }
  logger.info('SAM.gov attachments imported', { opportunityId, total: links.length, imported: results.filter((r) => r.outcome === 'imported').length })
  return { results, queuedForReading: toRead.length }
}

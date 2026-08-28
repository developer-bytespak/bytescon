// =============================================================
// Winners Intel — slice writer
//
// Atomic write of MD slice files + manifest.json to disk. Uses tmp-rename
// so a crash mid-write never leaves a half-written slice for the resolver
// to load.
//
// Storage location: uploads/winners/ inside the backend container.
// We deliberately use the existing uploads_data Docker volume (mounted
// in docker-compose.prod.yml) instead of declaring a new winners_intel_data
// volume — uploads_data is already persistent across container recreate,
// and adding a second volume requires a compose change with operator
// coordination. The /uploads/branding/* static handler in server.ts only
// serves the branding subdirectory, so winners files are not exposed.
//
// Future improvement: dedicated volume + dedicated path. Tracked as a
// post-launch infra polish item.
// =============================================================

import path from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { logger } from '../../utils/logger'
import {
  DistillationOutput,
  PrimeWinnerSlice,
} from './distill'
import {
  renderAgencySlice,
  renderGlobalSlice,
  renderNaicsSlice,
} from './render'

const SLICE_ROOT = path.join(process.cwd(), 'uploads', 'winners')

export interface ManifestEntry {
  sliceKey: string
  filePath: string  // path relative to SLICE_ROOT
  sha256: string
  bytes: number
  estimatedTokens: number
  generatedAt: string
  // Slice-routing fields populated for resolver lookup. The resolver matches
  // an opportunity to slices by agency-name fuzzy match and by 6-digit NAICS
  // exact match — these fields let it search the manifest without scanning
  // every file body.
  sliceKind: 'global' | 'agency' | 'naics'
  agencyToptierCode?: string
  agencyToptierName?: string
  naics?: string
}

export interface Manifest {
  refreshBatchId: string
  generatedAt: string
  windowStart: string
  windowEnd: string
  totalBytes: number
  totalEstimatedTokens: number
  slices: ManifestEntry[]
}

export interface WriteResult {
  manifest: Manifest
  slicesWritten: number
  totalBytes: number
}

/**
 * Render the distillation output and write all slices atomically.
 * Existing slice files are overwritten in place; the previous manifest
 * is replaced.
 */
export async function writeSlices(distillation: DistillationOutput): Promise<WriteResult> {
  const startMs = Date.now()
  const slicesDir = SLICE_ROOT
  const byDeptDir = path.join(slicesDir, 'by-department')
  const byNaicsDir = path.join(slicesDir, 'by-naics')

  ensureDir(slicesDir)
  ensureDir(byDeptDir)
  ensureDir(byNaicsDir)

  const entries: ManifestEntry[] = []

  // Global slice — always-on header for every proposal injection.
  entries.push(await writeOne({
    relPath: '_global.md',
    body: renderGlobalSlice(distillation.global),
    slice: distillation.global,
    rootDir: slicesDir,
  }))

  for (const slice of distillation.byAgency) {
    if (!slice.agencyToptierCode) continue
    entries.push(await writeOne({
      relPath: path.join('by-department', `${slice.agencyToptierCode}.md`),
      body: renderAgencySlice(slice),
      slice,
      rootDir: slicesDir,
    }))
  }

  for (const slice of distillation.byNaics) {
    if (!slice.naics) continue
    entries.push(await writeOne({
      relPath: path.join('by-naics', `${slice.naics}.md`),
      body: renderNaicsSlice(slice),
      slice,
      rootDir: slicesDir,
    }))
  }

  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0)
  const totalEstimatedTokens = entries.reduce((sum, e) => sum + e.estimatedTokens, 0)

  const manifest: Manifest = {
    refreshBatchId: distillation.global.refreshBatchId,
    generatedAt: distillation.global.generatedAt,
    windowStart: distillation.windowStart,
    windowEnd: distillation.windowEnd,
    totalBytes,
    totalEstimatedTokens,
    slices: entries,
  }

  // Manifest write is also atomic — resolver reads this file and decides
  // which slices to load, so a half-written manifest would point to
  // missing files.
  await writeAtomic(path.join(slicesDir, '_manifest.json'), JSON.stringify(manifest, null, 2))

  logger.info('Winners intel slices written', {
    refreshBatchId: distillation.global.refreshBatchId,
    slicesWritten: entries.length,
    totalBytes,
    totalEstimatedTokens,
    durationMs: Date.now() - startMs,
  })

  return { manifest, slicesWritten: entries.length, totalBytes }
}

/**
 * Serve the most recent manifest. Returns null when no slices have ever
 * been written. Callers should treat null as "feature not yet usable."
 */
export function readManifest(): Manifest | null {
  const manifestPath = path.join(SLICE_ROOT, '_manifest.json')
  if (!fs.existsSync(manifestPath)) return null
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    return JSON.parse(raw) as Manifest
  } catch (err) {
    logger.warn('Winners intel manifest unreadable; treating as missing', {
      error: (err as Error).message,
    })
    return null
  }
}

/**
 * Read a single slice body by manifest entry. Validates the on-disk
 * checksum against the manifest's recorded sha256 before returning;
 * a mismatch returns null and logs a warning so the resolver can
 * fall back gracefully without serving corrupted content to the LLM.
 */
export function readSlice(entry: ManifestEntry): string | null {
  const abs = path.join(SLICE_ROOT, entry.filePath)
  if (!fs.existsSync(abs)) return null
  try {
    const content = fs.readFileSync(abs, 'utf-8')
    const sha = crypto.createHash('sha256').update(content).digest('hex')
    if (sha !== entry.sha256) {
      logger.warn('Winners intel slice checksum mismatch — refusing to serve', {
        sliceKey: entry.sliceKey,
        expected: entry.sha256,
        actual: sha,
      })
      return null
    }
    return content
  } catch (err) {
    logger.warn('Winners intel slice read failed', {
      sliceKey: entry.sliceKey,
      error: (err as Error).message,
    })
    return null
  }
}

// ---------- internals ----------

interface WriteOneArgs {
  relPath: string
  body: string
  slice: PrimeWinnerSlice
  rootDir: string
}

async function writeOne(args: WriteOneArgs): Promise<ManifestEntry> {
  const abs = path.join(args.rootDir, args.relPath)
  ensureDir(path.dirname(abs))
  await writeAtomic(abs, args.body)

  const bytes = Buffer.byteLength(args.body, 'utf-8')
  const sha256 = crypto.createHash('sha256').update(args.body).digest('hex')
  // Token estimate: GPT/Claude tokenizers average ~4 chars/token in English
  // prose. Within ±15% for our markdown — good enough for the resolver's
  // budget arithmetic. Cheaper than calling tiktoken on every slice.
  const estimatedTokens = Math.ceil(args.body.length / 4)

  return {
    sliceKey: args.slice.sliceKey,
    filePath: args.relPath.replace(/\\/g, '/'),
    sha256,
    bytes,
    estimatedTokens,
    generatedAt: args.slice.generatedAt,
    sliceKind: args.slice.sliceKind,
    agencyToptierCode: args.slice.agencyToptierCode,
    agencyToptierName: args.slice.agencyToptierName,
    naics: args.slice.naics,
  }
}

async function writeAtomic(targetPath: string, content: string): Promise<void> {
  const tmp = targetPath + '.tmp'
  fs.writeFileSync(tmp, content, { encoding: 'utf-8' })
  fs.renameSync(tmp, targetPath)
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// Exposed for tests
export const _internals = {
  SLICE_ROOT,
}

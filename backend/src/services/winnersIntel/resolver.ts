// =============================================================
// Winners Intel — resolver
//
// Picks which slice files to load for a given opportunity, concatenates
// them under the 12K-token cap, and returns a prompt-ready string plus
// the sliceKeys + checksum needed for the audit log.
//
// Always-loaded: _global (the platform-wide baseline)
// Conditional:   one agency slice (matched on agency name)
//                up to two NAICS slices (matched on 6-digit code)
//
// The resolver is gated three ways. If ANY of these is false, it returns
// null and the proposal pathway proceeds with no extra context (zero
// behavior change):
//   1. ENABLE_WINNERS_INTEL=true on the droplet
//   2. ConsultingFirm.winnersIntelOptIn === true for THIS firm
//   3. A manifest.json exists on disk under uploads/winners/
// =============================================================

import crypto from 'crypto'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { readManifest, readSlice, ManifestEntry } from './sliceWriter'

const TOKEN_CAP = 12_000

export interface OpportunityHint {
  /** Free-form agency name from SAM.gov (e.g. "Department of Defense"). */
  agency?: string | null
  /** 6-digit NAICS code on the opportunity record, when present. */
  naicsCode?: string | null
}

export interface ResolvedContext {
  /** The concatenated markdown body to inject into the LLM prompt. */
  context: string
  /** Slice keys that ended up in the context — written to ComplianceLog for audit replay. */
  sliceKeys: string[]
  /** sha256 of the concatenated context — also written to ComplianceLog so a future
   *  replay can confirm what the LLM actually saw. */
  contentSha256: string
  /** Estimated token count actually loaded (sum of selected slices' estimatedTokens). */
  totalEstimatedTokens: number
  /** Age of the manifest. Stale data (>21 days) prompts the resolver to add a banner. */
  manifestGeneratedAt: string
}

/**
 * Resolve the winners-intel context for a single proposal generation. Returns
 * null when the feature is disabled OR no slices exist. Callers should treat
 * null as the no-op case and proceed without injection.
 */
export async function resolveWinnersContext(
  hint: OpportunityHint,
  consultingFirmId: string,
): Promise<ResolvedContext | null> {
  if (!isFeatureEnabled()) return null
  if (!await firmHasOptedIn(consultingFirmId)) return null

  const manifest = readManifest()
  if (!manifest) {
    logger.info('Winners intel resolver: no manifest on disk; skipping injection')
    return null
  }

  // Build the selection: _global always first, then agency match (one), then
  // up to two NAICS matches. Each slice carries its estimatedTokens so we
  // can drop the lowest-priority ones if the running total exceeds the cap.
  const entries = manifest.slices
  const globalEntry = entries.find((e) => e.sliceKind === 'global')
  const agencyEntry = pickAgencyEntry(entries, hint.agency)
  const naicsEntries = pickNaicsEntries(entries, hint.naicsCode)

  const ordered: ManifestEntry[] = []
  if (globalEntry) ordered.push(globalEntry)
  if (agencyEntry) ordered.push(agencyEntry)
  ordered.push(...naicsEntries)

  // Budget enforcement: walk in selection order, drop slices that would
  // overflow the cap. We keep _global no matter what (cheap and broad)
  // and trim NAICS slices first since they're the most numerous.
  const selected: ManifestEntry[] = []
  let usedTokens = 0
  for (const e of ordered) {
    if (usedTokens + e.estimatedTokens > TOKEN_CAP && selected.length > 0) {
      break  // stop accumulating once budget is exhausted (don't fail loudly)
    }
    selected.push(e)
    usedTokens += e.estimatedTokens
  }

  if (selected.length === 0) {
    return null  // nothing matched and even global was missing — degrade silently
  }

  const bodies: string[] = []
  for (const entry of selected) {
    const body = readSlice(entry)
    if (body) bodies.push(body)
  }
  if (bodies.length === 0) {
    logger.warn('Winners intel resolver: all selected slice bodies failed to load')
    return null
  }

  const ageDays = (Date.now() - new Date(manifest.generatedAt).getTime()) / (1000 * 60 * 60 * 24)
  const stalenessBanner = ageDays > 21
    ? `> _Note: This data is ${Math.round(ageDays)} days old. Treat trend observations cautiously._\n\n`
    : ''

  const context =
    `# Federal Contracting Context (Winners Intel)\n\n` +
    `The sections below are statistical summaries of recent federal prime contract awards, ` +
    `grouped by agency and NAICS. Use them to ground your proposal in real patterns ` +
    `(typical award sizes, common recipients, geographic concentration). They are NOT ` +
    `the solicitation — refer to the opportunity description for actual requirements.\n\n` +
    stalenessBanner +
    bodies.join('\n---\n\n')

  const contentSha256 = crypto.createHash('sha256').update(context).digest('hex')

  return {
    context,
    sliceKeys: selected.map((e) => e.sliceKey),
    contentSha256,
    totalEstimatedTokens: usedTokens,
    manifestGeneratedAt: manifest.generatedAt,
  }
}

// ---------- internals ----------

function isFeatureEnabled(): boolean {
  return String(process.env.ENABLE_WINNERS_INTEL || '').toLowerCase() === 'true'
}

async function firmHasOptedIn(consultingFirmId: string): Promise<boolean> {
  try {
    const firm = await prisma.consultingFirm.findUnique({
      where: { id: consultingFirmId },
      select: { winnersIntelOptIn: true },
    })
    return Boolean(firm?.winnersIntelOptIn)
  } catch (err) {
    logger.warn('Winners intel resolver: opt-in lookup failed; defaulting to off', {
      consultingFirmId,
      error: (err as Error).message,
    })
    return false
  }
}

/**
 * Match an opportunity's agency name to a slice. Fuzzy contains-match in both
 * directions — slice name might be "Department of Defense" while opportunity
 * agency is "DEFENSE, DEPARTMENT OF.DARPA (HQ0034)" or similar. Strips common
 * noise (commas, parentheses) before comparing.
 */
function pickAgencyEntry(entries: ManifestEntry[], agencyName: string | null | undefined): ManifestEntry | null {
  if (!agencyName) return null
  const target = normalizeAgency(agencyName)
  if (!target) return null

  const agencyEntries = entries.filter((e) => e.sliceKind === 'agency' && e.agencyToptierName)
  // Score each candidate by how much of its name overlaps with the target.
  // Sort by score descending, take the first with score >= 0.5 of its length.
  let best: { entry: ManifestEntry; score: number } | null = null
  for (const e of agencyEntries) {
    const candidate = normalizeAgency(e.agencyToptierName!)
    if (!candidate) continue
    const score = overlapScore(target, candidate)
    if (!best || score > best.score) {
      best = { entry: e, score }
    }
  }
  return best && best.score >= 0.5 ? best.entry : null
}

/**
 * Match NAICS slices to the opportunity's 6-digit NAICS. Exact match first;
 * if not found, return up to two 4-digit-prefix matches as a fallback (the
 * 6-digit slice may not exist if award count was below the distill threshold,
 * but the parent industry's slice is usually populated).
 */
function pickNaicsEntries(entries: ManifestEntry[], naicsCode: string | null | undefined): ManifestEntry[] {
  if (!naicsCode) return []
  const code = naicsCode.replace(/\D/g, '')
  if (code.length < 4) return []

  const naicsEntries = entries.filter((e) => e.sliceKind === 'naics' && e.naics)

  const exact = naicsEntries.find((e) => e.naics === code)
  if (exact) return [exact]

  const prefix = code.slice(0, 4)
  return naicsEntries
    .filter((e) => e.naics && e.naics.startsWith(prefix))
    .slice(0, 2)
}

function normalizeAgency(s: string): string {
  return s
    .toLowerCase()
    .replace(/[(),.]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\bdepartment\s+of\b/g, '')
    .replace(/\bof\s+the\b/g, '')
    .trim()
}

function overlapScore(a: string, b: string): number {
  const aTokens = new Set(a.split(/\s+/).filter((t) => t.length >= 3))
  const bTokens = new Set(b.split(/\s+/).filter((t) => t.length >= 3))
  if (aTokens.size === 0 || bTokens.size === 0) return 0
  let intersection = 0
  for (const t of aTokens) if (bTokens.has(t)) intersection++
  return intersection / Math.min(aTokens.size, bTokens.size)
}

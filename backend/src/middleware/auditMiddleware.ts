// =============================================================
// Audit Middleware — global capture of mutating actions on /api/*.
//
// Mounted before route handlers so the response-finish listener
// is registered early, but the actual audit write happens AFTER
// the response is flushed. By that point per-route auth has
// populated req.user (or hasn't, in which case we skip).
//
// This is a thin safety-net: critical actions (login, signup,
// agreement acceptance, AI inferences, decision overrides) call
// `logAudit` directly with richer detail. The middleware catches
// the everything-else mutating traffic with method-level granularity.
// =============================================================
import { Response, NextFunction } from 'express'
import { logAudit, AuditAction } from '../services/auditService'
import { AuthenticatedRequest } from '../types'
import { logger } from '../utils/logger'

const SKIP_PATH_PREFIXES = [
  '/api/auth',          // auth.ts emits explicit logAudit calls with rationale
  '/api/far/clauses',   // read-only catalog
  '/api/jobs',          // poll-heavy
  '/api/analytics',     // read-only by convention
]

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE'])

// Read endpoints that must still be audited for compliance: bulk data exports
// (EXPORT) and file downloads (ACCESS). These are GET requests, so without this
// they bypass the mutating-only capture below and never reach the audit trail.
const EXPORT_PATH_RE = /\/export(?:\/|$)/
const DOWNLOAD_PATH_RE = /\/download(?:\/|$)/

function shouldSkip(path: string): boolean {
  return SKIP_PATH_PREFIXES.some((p) => path.startsWith(p))
}

// Explicit route-segment → entity name. The PascalCase+strip-'s' heuristic
// below mislabels several real segments (e.g. "opportunities" → "Opportunitie",
// "clients" → "Client" rather than the schema's ClientCompany, "decision" →
// "Decision" rather than BidDecision), so known segments are resolved here first.
const ROUTE_ENTITY_MAP: Record<string, string> = {
  opportunities: 'Opportunity',
  clients: 'ClientCompany',
  decision: 'BidDecision',
  submissions: 'SubmissionRecord',
  contracts: 'Contract',
  firm: 'ConsultingFirm',
  branding: 'Branding',
  'compliance-matrix': 'ComplianceMatrix',
  'proposal-assist': 'Proposal',
  'proposal-sections': 'ProposalSection',
  'doc-requirements': 'DocumentRequirement',
  'client-deliverables': 'ClientDeliverable',
}

function inferEntityType(path: string): string {
  // /api/opportunities/abc123 → "Opportunity"
  const m = path.match(/^\/api\/([\w-]+)/)
  if (!m) return 'Unknown'
  const seg = m[1].toLowerCase()
  if (ROUTE_ENTITY_MAP[seg]) return ROUTE_ENTITY_MAP[seg]
  // Fallback: dash-case → PascalCase → strip trailing 's'
  const pascal = seg.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')
  return pascal.endsWith('s') ? pascal.slice(0, -1) : pascal
}

function looksLikeId(s: string): boolean {
  // cuid (~25 chars), cuid2, or uuid (36 chars w/ dashes)
  return /^[a-z0-9]{20,30}$/i.test(s) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
}

function inferEntityId(path: string): string | null {
  const segs = path.split('/').filter(Boolean)
  for (let i = segs.length - 1; i >= 0; i--) {
    if (looksLikeId(segs[i])) return segs[i]
  }
  return null
}

function methodToAction(method: string): AuditAction {
  if (method === 'DELETE') return 'DELETE'
  if (method === 'POST') return 'CREATE'
  return 'UPDATE'
}

export function auditMutations(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const isExport = req.method === 'GET' && EXPORT_PATH_RE.test(req.path)
  const isDownload = req.method === 'GET' && DOWNLOAD_PATH_RE.test(req.path)
  const isMutating = MUTATING_METHODS.has(req.method)

  if ((!isMutating && !isExport && !isDownload) || shouldSkip(req.path)) {
    return next()
  }

  res.on('finish', () => {
    // Skip failed requests — no state change and no successful disclosure.
    if (res.statusCode >= 400) return
    // Unauthenticated (rare; usually rejected by route auth before reaching here)
    if (!req.user) return

    const action: AuditAction = isExport
      ? 'EXPORT'
      : isDownload
        ? 'ACCESS'
        : methodToAction(req.method)

    logAudit({
      consultingFirmId: req.user.consultingFirmId,
      actorUserId: req.user.userId,
      actorRole: req.user.role,
      action,
      entityType: inferEntityType(req.path),
      entityId: inferEntityId(req.path),
      sourceIp: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    }).catch((e) =>
      logger.error('audit write failed', {
        path: req.path,
        method: req.method,
        firmId: req.user?.consultingFirmId,
        error: e instanceof Error ? e.message : String(e),
      })
    )
  })

  next()
}

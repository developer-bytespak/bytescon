// =============================================================
// Client Companies Routes
// GET    /api/clients
// POST   /api/clients
// GET    /api/clients/:id
// PUT    /api/clients/:id
// DELETE /api/clients/:id
// GET    /api/clients/:id/stats
// =============================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant';
import { AuthenticatedRequest } from '../types';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logAudit } from '../services/auditService';
import { assertFresh } from '../utils/optimisticLock';
import { enqueueAllOpportunitiesForScoring } from '../workers/scoringWorker';
import { revokeClientTokens } from '../services/tokenRevocation';
import { checkClientLimit } from '../middleware/tierGate';
import { lookupEntityByUEI, lookupEntityByCAGE, lookupEntityByName } from '../services/samEntityApi';
import { createUpload, allowedImageMimeTypes } from '../middleware/upload';
import { ingestBulkNaics } from '../services/bigquery/ingestionService';
import { claimIngestWarm } from '../services/bigquery/ingestGuard';
import { ensureBigQueryDataset } from '../config/bigquery';
import { runBackground } from '../utils/asyncSafe';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

/** RFC 4180-compliant CSV parser — handles quoted fields and embedded commas */
function parseCSV(text: string): Record<string, string>[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return [];

  const parseRow = (line: string): string[] => {
    const result: string[] = [];
    let cell = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cell += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        result.push(cell.trim()); cell = '';
      } else {
        cell += ch;
      }
    }
    result.push(cell.trim());
    return result;
  };

  const headers = parseRow(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = parseRow(line);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
    rows.push(row);
  }
  return rows;
}

const router = Router();
router.use(authenticateJWT, enforceTenantScope);
router.use(requireActiveBase);

const ClientSchema = z.object({
  name: z.string().min(1).max(100),
  cage: z.string().optional(),
  uei: z.string().optional(),
  ein: z.string().optional(),
  email: z.string().email().max(200).nullable().optional().or(z.literal('')),
  primaryContactName: z.string().max(200).nullable().optional(),
  primaryContactEmail: z.string().email().max(200).nullable().optional().or(z.literal('')),
  notes: z.string().max(8000).nullable().optional(),
  naicsCodes: z.array(z.string()).default([]),
  pscCodes: z.array(z.string()).default([]),
  contractVehicles: z.array(z.string()).default([]),
  sdvosb: z.boolean().default(false),
  wosb: z.boolean().default(false),
  hubzone: z.boolean().default(false),
  smallBusiness: z.boolean().default(true),
  phone: z.string().optional(),
  website: z.string().optional(),
  streetAddress: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  samRegStatus: z.string().optional(),
  samRegExpiry: z.coerce.date().optional(),
  bondingCapacity: z.number().nonnegative().nullable().optional(),
  employeeCount: z.number().int().nonnegative().nullable().optional(),
  hasFso: z.boolean().optional(),
  securityClearances: z.array(z.string().max(80)).max(50).optional(),
  isoCertifications: z.array(z.string().max(60)).max(25).optional(),
  agenciesOfInterest: z.array(z.string().max(120)).max(100).optional(),
  capabilityKeywords: z.array(z.string().max(60)).max(100).optional(),
  // z.null() must precede z.coerce.date() — coercion would turn null into 1970-01-01
  sdvosbCertExpiry: z.union([z.null(), z.coerce.date()]).optional(),
  wosbCertExpiry: z.union([z.null(), z.coerce.date()]).optional(),
  hubzoneCertExpiry: z.union([z.null(), z.coerce.date()]).optional(),
});

/**
 * POST /api/clients/import-csv
 * Bulk-import clients from a CSV file. Skips rows where name already exists for this firm.
 */
router.post('/import-csv', upload.single('file'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const text = req.file.buffer.toString('utf-8');
    const rows = parseCSV(text);
    if (!rows.length) return res.status(400).json({ success: false, error: 'CSV is empty or has no data rows' });

    const toBool = (v: string | undefined) => v?.toLowerCase().trim() === 'yes';

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const name = row.company_name?.trim();
      if (!name) { errors.push('Row skipped — missing company_name'); continue; }

      const existing = await prisma.clientCompany.findFirst({
        where: { consultingFirmId, name },
        select: { id: true },
      });
      if (existing) { skipped++; continue; }

      const naicsCodes = row.naics_codes
        ? row.naics_codes.split(/[;|]/).map((s) => s.trim()).filter(Boolean)
        : [];
      // PSC codes are compared uppercase by the matching-v2 PSC dimension
      const pscCodes = row.psc_codes
        ? row.psc_codes.split(/[;|]/).map((s) => s.trim().toUpperCase()).filter(Boolean)
        : [];

      try {
        await prisma.$transaction(async (tx) => {
          const c = await tx.clientCompany.create({
            data: {
              consultingFirmId, name,
              uei:           row.uei?.trim()            || null,
              cage:          row.cage?.trim()           || null,
              ein:           row.ein?.trim()            || null,
              naicsCodes,
              pscCodes,
              sdvosb:        toBool(row.sdvosb),
              wosb:          toBool(row.wosb),
              hubzone:       toBool(row.hubzone),
              smallBusiness: row.small_business ? toBool(row.small_business) : true,
              phone:         row.phone?.trim()          || null,
              website:       row.website?.trim()        || null,
              streetAddress: row.street_address?.trim() || null,
              city:          row.city?.trim()           || null,
              state:         row.state?.trim().toUpperCase() || null,
              zipCode:       row.zip_code?.trim()       || null,
            },
          });
          await tx.performanceStats.create({ data: { clientCompanyId: c.id } });
        });
        created++;
      } catch (err: any) {
        errors.push(`"${name}": ${err.message}`);
      }
    }

    if (created > 0) enqueueAllOpportunitiesForScoring(consultingFirmId).catch((err: Error) => {
      logger.warn('enqueueAllOpportunitiesForScoring failed after bulk client import', { consultingFirmId, error: err.message })
    });

    res.json({ success: true, data: { created, skipped, errors, total: rows.length } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const { page = '1', limit = '20', active, includeArchived } = req.query;
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);

    const where: any = { consultingFirmId };
    if (active !== undefined) where.isActive = active === 'true';
    // Archived clients are hidden unless explicitly requested (Show archived).
    if (String(includeArchived) !== 'true') where.archivedAt = null;

    const [clients, total] = await Promise.all([
      prisma.clientCompany.findMany({
        where,
        include: { performanceStats: true },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        orderBy: { name: 'asc' },
      }),
      prisma.clientCompany.count({ where }),
    ]);

    res.json({
      success: true,
      data: clients,
      meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/clients
 */
router.post('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);

    const limitCheck = await checkClientLimit(consultingFirmId);
    if (!limitCheck.allowed) {
      throw new ValidationError(
        `Client limit reached (${limitCheck.current}/${limitCheck.max}). Upgrade your plan to add more clients.`
      );
    }

    const body = ClientSchema.parse(req.body);

    const client = await prisma.$transaction(async (tx) => {
      const c = await tx.clientCompany.create({
        data: { ...body, consultingFirmId },
      });

      // Initialize performance stats row
      await tx.performanceStats.create({
        data: { clientCompanyId: c.id },
      });

      return c;
    });

    // Enqueue async scoring for this new client across all opportunities
    enqueueAllOpportunitiesForScoring(consultingFirmId).catch((err: Error) => {
      logger.warn('enqueueAllOpportunitiesForScoring failed after client create', { consultingFirmId, error: err.message })
    });

    // Warm BigQuery market intelligence for this client's NAICS in the background
    // so the Analytics market overview is populated by the time the user views it.
    // Best-effort — never blocks or fails client creation (no BQ creds / dataset
    // issues are swallowed by runBackground).
    if (Array.isArray(client.naicsCodes) && client.naicsCodes.length > 0) {
      const codes = [...new Set(client.naicsCodes)];
      // Cooldown-guarded so this doesn't double-insert with the market-preview
      // warm path for the same NAICS set (append-only ingestion inflates totals).
      if (claimIngestWarm(codes)) {
        runBackground(
          'bq-ingest-client-naics',
          async () => {
            await ensureBigQueryDataset();
            await ingestBulkNaics(codes, { maxPages: 3, yearsBack: 5 });
          },
          { consultingFirmId, entityType: 'BQIngest' },
        );
      }
    }

    res.status(201).json({ success: true, data: client });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients/lookup?uei=...  OR  ?cage=...  OR  ?name=...
 * Looks up entity data from SAM.gov — does NOT create a record.
 * EIN lookup is NOT supported by the SAM.gov public API.
 */
router.get('/lookup', authenticateJWT, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { uei, cage, name } = req.query as Record<string, string>;
    if (!uei && !cage && !name) {
      return res.status(400).json({ success: false, error: 'Provide uei, cage, or name query parameter' });
    }

    let result: any = null;
    if (uei) result = await lookupEntityByUEI(uei);
    else if (cage) result = await lookupEntityByCAGE(cage);
    else if (name) result = await lookupEntityByName(name);

    if (!result) {
      return res.status(404).json({ success: false, error: 'Entity not found in SAM.gov registry. Verify the UEI/CAGE is correct and the entity has an active registration.' });
    }

    res.json({ success: true, data: result });
  } catch (err: any) {
    res.status(502).json({ success: false, error: err.message || 'SAM.gov lookup failed' });
  }
});

/**
 * GET /api/clients/lookup-raw?uei=...  (Admin — see exact SAM response for debugging)
 */
router.get('/lookup-raw', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const axiosLib = (await import('axios')).default;
    const { uei, cage, name } = req.query as Record<string, string>;
    const apiKey = process.env.SAM_API_KEY;
    const params: Record<string, string> = { api_key: apiKey!, includeSections: 'entityRegistration,coreData,assertions' };
    if (uei)  params.ueiSAM       = uei.trim().toUpperCase();
    else if (cage) params.cageCode = cage.trim().toUpperCase();
    else if (name) { params.legalBusinessName = name.trim(); params.registrationStatus = 'Active'; }
    else return res.status(400).json({ error: 'Provide uei, cage, or name' });

    const samRes = await axiosLib.get('https://api.sam.gov/entity-information/v3/entities', { params, timeout: 20000 });
    res.json({ status: samRes.status, data: samRes.data });
  } catch (err: any) {
    res.json({ error: err.message, responseStatus: err.response?.status, responseData: err.response?.data });
  }
});

/**
 * GET /api/clients/:id
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const clientId = req.params.id;

    const [client, bidDecisions, allSubmissions] = await Promise.all([
      prisma.clientCompany.findFirst({
        where: { id: clientId, consultingFirmId },
        include: {
          performanceStats: true,
          submissionRecords: {
            include: {
              opportunity: {
                select: { id: true, title: true, agency: true, responseDeadline: true },
              },
            },
            orderBy: { submittedAt: 'desc' },
            take: 20,
          },
          financialPenalties: {
            orderBy: { createdAt: 'desc' },
            take: 10,
          },
        },
      }),
      // Active bid pipeline
      prisma.bidDecision.findMany({
        where: { clientCompanyId: clientId, consultingFirmId },
        select: {
          id: true,
          recommendation: true,
          winProbability: true,
          expectedValue: true,
          netExpectedValue: true,
          roiRatio: true,
          updatedAt: true,
          opportunity: {
            select: { id: true, title: true, agency: true, responseDeadline: true, naicsCode: true, setAsideType: true },
          },
        },
        orderBy: { winProbability: 'desc' },
        take: 50,
      }),
      // All submissions for trend (last 12 months)
      prisma.submissionRecord.findMany({
        where: {
          clientCompanyId: clientId,
          consultingFirmId,
          submittedAt: { gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
        },
        select: { submittedAt: true, status: true, wasOnTime: true },
        orderBy: { submittedAt: 'asc' },
      }),
    ]);

    if (!client) throw new NotFoundError('ClientCompany');

    // Bid pipeline summary
    const pipeline = {
      bidPrime: bidDecisions.filter((d) => d.recommendation === 'BID_PRIME'),
      bidSub: bidDecisions.filter((d) => d.recommendation === 'BID_SUB'),
      noBid: bidDecisions.filter((d) => d.recommendation === 'NO_BID').length,
      totalPipelineValue: bidDecisions
        .filter((d) => d.recommendation !== 'NO_BID')
        .reduce((sum, d) => sum + Number(d.expectedValue || 0), 0),
      avgWinProbability:
        bidDecisions.length > 0
          ? bidDecisions.reduce((sum, d) => sum + Number(d.winProbability || 0), 0) / bidDecisions.length
          : 0,
    };

    // 6-month submission trend bucketed by month
    const monthTrend: Record<string, { won: number; submitted: number; late: number }> = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i);
      const key = d.toISOString().substring(0, 7);
      monthTrend[key] = { won: 0, submitted: 0, late: 0 };
    }
    for (const s of allSubmissions) {
      if (!s.submittedAt) continue;
      const key = s.submittedAt.toISOString().substring(0, 7);
      if (monthTrend[key]) {
        monthTrend[key].submitted++;
        if (s.status === 'APPROVED') monthTrend[key].won++;
        if (!s.wasOnTime) monthTrend[key].late++;
      }
    }
    const submissionTrend = Object.entries(monthTrend).map(([month, data]) => ({ month, ...data }));

    // Client health score (0-100)
    const stats = client.performanceStats;
    const winRate = stats && stats.totalSubmitted > 0 ? stats.totalWon / stats.totalSubmitted : 0;
    const completionRate = Number(stats?.completionRate || 0);
    const penalties = Number(stats?.totalPenalties || 0);
    const penaltyDrag = Math.exp(-penalties / 200000);
    const samOk = client.samRegStatus === 'Active' ? 1 : 0.7;
    const samExpiring = client.samRegExpiry
      ? Math.max(0, (new Date(client.samRegExpiry).getTime() - Date.now()) / (30 * 24 * 60 * 60 * 1000))
      : 12;
    const samFactor = samExpiring < 1 ? 0.5 : samExpiring < 2 ? 0.8 : samOk;
    const healthScore = Math.round(
      (winRate * 0.30 + completionRate * 0.25 + penaltyDrag * 0.25 + samFactor * 0.20) * 100
    );

    res.json({
      success: true,
      data: {
        ...client,
        pipeline,
        submissionTrend,
        healthScore: Math.min(healthScore, 100),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/clients/:id  (ADMIN only)
 */
router.put('/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const existing = await prisma.clientCompany.findFirst({
      where: { id: req.params.id, consultingFirmId },
    });
    if (!existing) throw new NotFoundError('ClientCompany');

    const body = ClientSchema.partial().parse(req.body);
    assertFresh(existing.updatedAt, req.body?.updatedAt);
    // Normalize empty-string email fields to null so the DB never stores ''.
    const normalized: Record<string, unknown> = { ...body };
    for (const k of ['email', 'primaryContactEmail'] as const) {
      if (normalized[k] === '') normalized[k] = null;
    }
    const updated = await prisma.clientCompany.update({
      where: { id: req.params.id },
      data: normalized,
    });
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'ClientCompany', entityId: updated.id, before: existing, after: updated });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/clients/:id/notes — notes-only update, allowed for CONSULTANT too.
// The full profile edit stays ADMIN-only; this is the single field a CONSULTANT
// may change on a client record.
router.patch('/:id/notes', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const existing = await prisma.clientCompany.findFirst({ where: { id: req.params.id, consultingFirmId } });
    if (!existing) throw new NotFoundError('ClientCompany');
    const { notes } = z.object({ notes: z.string().max(8000).nullable(), updatedAt: z.string().datetime().optional() }).parse(req.body);
    assertFresh(existing.updatedAt, req.body?.updatedAt);
    const updated = await prisma.clientCompany.update({ where: { id: existing.id }, data: { notes } });
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'UPDATE', entityType: 'ClientCompany', entityId: updated.id, rationale: 'notes updated' });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/clients/:id/archive — soft-archive (ADMIN). Also deactivates the
// company + revokes portal access so an archived client can't be used. Reversible.
router.patch('/:id/archive', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const existing = await prisma.clientCompany.findFirst({ where: { id: req.params.id, consultingFirmId } });
    if (!existing) throw new NotFoundError('ClientCompany');

    const portalUsers = await prisma.$transaction(async (tx) => {
      await tx.clientCompany.update({ where: { id: existing.id }, data: { archivedAt: new Date(), isActive: false } });
      const users = await tx.clientPortalUser.findMany({ where: { clientCompanyId: existing.id, isActive: true }, select: { id: true } });
      if (users.length > 0) {
        await tx.clientPortalUser.updateMany({ where: { clientCompanyId: existing.id }, data: { isActive: false } });
      }
      return users;
    });
    if (portalUsers.length > 0) {
      await Promise.all(portalUsers.map((u) => revokeClientTokens(u.id)));
    }
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'ARCHIVED', entityType: 'ClientCompany', entityId: existing.id, rationale: req.body?.reason ?? 'archived' });
    res.json({ success: true, data: { id: existing.id, archivedAt: new Date() } });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/clients/:id/restore — clear the archive (ADMIN). Reactivates the
// company; portal users stay revoked and must be re-enabled individually.
router.patch('/:id/restore', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const existing = await prisma.clientCompany.findFirst({ where: { id: req.params.id, consultingFirmId } });
    if (!existing) throw new NotFoundError('ClientCompany');
    const updated = await prisma.clientCompany.update({ where: { id: existing.id }, data: { archivedAt: null, isActive: true } });
    await logAudit({ consultingFirmId, actorUserId: req.user?.userId, actorRole: req.user?.role, action: 'RESTORED', entityType: 'ClientCompany', entityId: existing.id });
    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// =============================================================
// Per-client branding for proposal PDFs
// =============================================================
// Federal proposals go out under the CLIENT's identity (UEI/CAGE/brand),
// not the consulting firm's. These endpoints let an ADMIN set the cover-
// page colors, logo, "PREPARED BY" line, and footer address that the
// proposal-generation pathway will apply when this client is selected.
// All fields nullable: null = fall back to the consulting firm's defaults.

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

const ClientBrandingSchema = z.object({
  displayName:    z.string().max(120).nullable().optional(),
  tagline:        z.string().max(200).nullable().optional(),
  logoUrl:        z.string().max(500).nullable().optional(),
  primaryColor:   z.string().regex(HEX_COLOR, 'Must be #RRGGBB').nullable().optional(),
  secondaryColor: z.string().regex(HEX_COLOR, 'Must be #RRGGBB').nullable().optional(),
  footerAddress:  z.string().max(200).nullable().optional(),
  preparedByLine: z.string().max(150).nullable().optional(),
});

/**
 * PUT /api/clients/:id/branding  (ADMIN only)
 * Update per-client branding. Field-level semantics:
 *   - absent in request body → field is unchanged
 *   - explicit null          → field is cleared (firm default applies)
 *   - string value           → field is set
 */
router.put('/:id/branding', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const existing = await prisma.clientCompany.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError('ClientCompany');

    const body = ClientBrandingSchema.parse(req.body);

    const data: Prisma.ClientCompanyUpdateInput = {
      ...(body.displayName    !== undefined && { brandingDisplayName:    body.displayName }),
      ...(body.tagline        !== undefined && { brandingTagline:        body.tagline }),
      ...(body.logoUrl        !== undefined && { brandingLogoUrl:        body.logoUrl }),
      ...(body.primaryColor   !== undefined && { brandingPrimaryColor:   body.primaryColor }),
      ...(body.secondaryColor !== undefined && { brandingSecondaryColor: body.secondaryColor }),
      ...(body.footerAddress  !== undefined && { brandingFooterAddress:  body.footerAddress }),
      ...(body.preparedByLine !== undefined && { brandingPreparedByLine: body.preparedByLine }),
    };

    const changed = Object.keys(data);
    if (changed.length === 0) {
      throw new ValidationError('No branding fields supplied');
    }

    const updated = await prisma.clientCompany.update({
      where: { id: req.params.id },
      data,
      select: {
        id: true,
        name: true,
        brandingLogoUrl:        true,
        brandingPrimaryColor:   true,
        brandingSecondaryColor: true,
        brandingDisplayName:    true,
        brandingTagline:        true,
        brandingFooterAddress:  true,
        brandingPreparedByLine: true,
      },
    });

    await prisma.complianceLog.create({
      data: {
        consultingFirmId,
        entityType: 'CLIENT_COMPANY',
        entityId: req.params.id,
        toStatus: 'BRANDING_UPDATED',
        reason: `Branding fields changed: ${changed.join(', ')}`,
        triggeredBy: req.user?.userId ?? null,
      },
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Logo upload — separate multer instance gated to image MIMEs only and
// capped at 2MB (smaller than the global 25MB doc cap; logos shouldn't be
// larger). Files land in uploads/branding/ and are served back to clients
// via the public /uploads/branding/* static handler in server.ts.
const logoUpload = createUpload({
  allowedMimeTypes: allowedImageMimeTypes,
  maxBytes: 2 * 1024 * 1024,
  subdir: 'branding',
  typeLabel: 'png, jpeg, svg, webp',
});

/**
 * POST /api/clients/:id/branding/upload-logo  (ADMIN only)
 * Multipart upload of a logo image. On success: updates
 * ClientCompany.brandingLogoUrl to the served path and returns the URL.
 */
router.post(
  '/:id/branding/upload-logo',
  requireRole('ADMIN'),
  logoUpload.single('file'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req);
      const file = req.file;
      if (!file) throw new ValidationError('No file uploaded');

      const existing = await prisma.clientCompany.findFirst({
        where: { id: req.params.id, consultingFirmId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundError('ClientCompany');

      // The static handler in server.ts maps /uploads/branding/* to the same
      // directory createUpload writes into. Storing only the filename keeps
      // the URL portable across droplet hostnames.
      const logoUrl = `/uploads/branding/${file.filename}`;

      await prisma.clientCompany.update({
        where: { id: req.params.id },
        data: { brandingLogoUrl: logoUrl },
      });

      await prisma.complianceLog.create({
        data: {
          consultingFirmId,
          entityType: 'CLIENT_COMPANY',
          entityId: req.params.id,
          toStatus: 'BRANDING_LOGO_UPLOADED',
          reason: `Logo uploaded: ${file.filename} (${file.size} bytes, ${file.mimetype})`,
          triggeredBy: req.user?.userId ?? null,
        },
      });

      res.json({
        success: true,
        data: { logoUrl, fileName: file.filename, size: file.size, mimeType: file.mimetype },
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * DELETE /api/clients/:id (soft delete, ADMIN only)
 */
router.delete('/:id', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const existing = await prisma.clientCompany.findFirst({
      where: { id: req.params.id, consultingFirmId },
    });
    if (!existing) throw new NotFoundError('ClientCompany');

    // Deactivating a client must end its people's portal access too. Previously
    // this flipped only the company row, leaving every contact's 24h token live
    // and their ClientPortalUser.isActive true — so a "deleted" client kept
    // full portal access and could log in again.
    //
    // Both writes go in ONE transaction: a partial failure that deactivated the
    // company but not its users (or the reverse) is exactly the inconsistent
    // state the per-request access check has to reason about.
    const portalUsers = await prisma.$transaction(async (tx) => {
      await tx.clientCompany.update({
        where: { id: req.params.id },
        data: { isActive: false },
      });
      const users = await tx.clientPortalUser.findMany({
        where: { clientCompanyId: req.params.id, isActive: true },
        select: { id: true },
      });
      if (users.length > 0) {
        await tx.clientPortalUser.updateMany({
          where: { clientCompanyId: req.params.id },
          data: { isActive: false },
        });
      }
      return users;
    });

    // Revocations run after commit — they are best-effort (Redis, fail-open) and
    // must never roll back a committed deactivation. The per-request account
    // check is the authoritative control regardless.
    if (portalUsers.length > 0) {
      await Promise.all(portalUsers.map((u) => revokeClientTokens(u.id)));
      logger.info('Client deactivated — portal access revoked', {
        clientCompanyId: req.params.id,
        portalUsersRevoked: portalUsers.length,
      });
    }

    res.json({ success: true, data: { message: 'Client deactivated' } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients/:id/stats
 */
router.get('/:id/stats', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const stats = await prisma.performanceStats.findFirst({
      where: { clientCompany: { id: req.params.id, consultingFirmId } },
      include: { clientCompany: { select: { id: true, name: true } } },
    });

    if (!stats) throw new NotFoundError('PerformanceStats');

    res.json({ success: true, data: stats });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients/:id/opportunities
 * Returns opportunities matched to client's NAICS codes, with decline status
 */
router.get('/:id/opportunities', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const client = await prisma.clientCompany.findFirst({
      where: { id: req.params.id, consultingFirmId },
      select: { naicsCodes: true },
    });
    if (!client) throw new NotFoundError('Client');

    const declines = await prisma.clientOpportunityDecline.findMany({
      where: { clientCompanyId: req.params.id },
      select: { opportunityId: true },
    });
    const declinedIds = new Set(declines.map((d: any) => d.opportunityId));

    const where: any = {
      consultingFirmId,
      status: 'ACTIVE',
      responseDeadline: { gte: new Date() },
    };
    if (client.naicsCodes.length > 0) {
      where.naicsCode = { in: client.naicsCodes };
    }

    const opps = await prisma.opportunity.findMany({
      where,
      orderBy: { probabilityScore: 'desc' },
      take: 50,
      select: {
        id: true, title: true, agency: true, naicsCode: true, setAsideType: true,
        noticeType: true, estimatedValue: true, probabilityScore: true,
        responseDeadline: true, recompeteFlag: true,
      },
    });

    const result = opps.map((o: any) => ({ ...o, isDeclined: declinedIds.has(o.id) }));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/clients/:id/decline-opportunity
 */
router.post('/:id/decline-opportunity', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const { opportunityId, reason } = req.body;
    if (!opportunityId) return res.status(400).json({ success: false, error: 'opportunityId required' });

    const client = await prisma.clientCompany.findFirst({ where: { id: req.params.id, consultingFirmId } });
    if (!client) throw new NotFoundError('Client');

    await prisma.clientOpportunityDecline.upsert({
      where: { clientCompanyId_opportunityId: { clientCompanyId: req.params.id, opportunityId } },
      create: { clientCompanyId: req.params.id, opportunityId, reason: reason || null },
      update: { reason: reason || null, declinedAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/clients/:id/decline-opportunity/:oppId
 */
router.delete('/:id/decline-opportunity/:oppId', requireRole('ADMIN'), async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const client = await prisma.clientCompany.findFirst({ where: { id: req.params.id, consultingFirmId } });
    if (!client) throw new NotFoundError('Client');

    await prisma.clientOpportunityDecline.deleteMany({
      where: { clientCompanyId: req.params.id, opportunityId: req.params.oppId },
    });
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients/naics/search?q=consulting
 * Search NAICS codes by code or description. Public within authenticated scope.
 */
router.get(
  '/naics/search',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const q = (req.query.q as string || '').trim();
      if (q.length < 2) {
        return res.json({ success: true, data: [] });
      }
      const codes = await prisma.naicsCode.findMany({
        where: {
          OR: [
            { code: { contains: q } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { code: true, description: true },
        orderBy: { code: 'asc' },
        take: 30,
      });
      res.json({ success: true, data: codes });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

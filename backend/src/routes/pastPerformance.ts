// =============================================================
// Past Performance Records Routes
// -------------------------------------------------------------
// CRUD for the structured FAR 15.305(a)(2) past-performance / CPARS
// records. Reads are firm-wide (any role); writes are ADMIN-only and
// tenant-scoped. Mirrors the conventions in routes/submissions.ts.
// =============================================================
import { Router, Response, NextFunction } from 'express';
import { z } from 'zod';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { requireActiveBase } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant';
import { AuthenticatedRequest } from '../types';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logAudit } from '../services/auditService';
import {
  CPARS_RATINGS,
  CONTRACT_TYPES,
  listPastPerformance,
  getPastPerformanceById,
  createPastPerformance,
  updatePastPerformance,
  deletePastPerformance,
} from '../services/pastPerformanceService';

const router = Router();
router.use(authenticateJWT, enforceTenantScope);
router.use(requireActiveBase);

const dateField = z
  .string()
  .datetime({ message: 'Expected an ISO 8601 datetime' })
  .transform((s) => new Date(s))
  .nullable()
  .optional();

const CreateSchema = z.object({
  clientCompanyId: z.string().uuid().nullable().optional(),
  contractNumber: z.string().min(1).max(120),
  customerName: z.string().min(1).max(300),
  customerAgency: z.string().max(300).nullable().optional(),
  customerPocName: z.string().max(200).nullable().optional(),
  customerPocEmail: z.string().email().max(200).nullable().optional(),
  customerPocPhone: z.string().max(50).nullable().optional(),
  contractType: z.enum(CONTRACT_TYPES).nullable().optional(),
  totalValue: z.number().nonnegative().nullable().optional(),
  periodOfPerformanceStart: dateField,
  periodOfPerformanceEnd: dateField,
  cparsRating: z.enum(CPARS_RATINGS).nullable().optional(),
  cparsLink: z.string().url().max(1000).nullable().optional(),
  scopeSummary: z.string().max(5000).optional(),
  relevanceTags: z.array(z.string().max(60)).max(50).optional(),
  isCurrent: z.boolean().optional(),
});

// All fields optional on update; contractNumber/customerName may not be blanked.
const UpdateSchema = CreateSchema.partial().extend({
  contractNumber: z.string().min(1).max(120).optional(),
  customerName: z.string().min(1).max(300).optional(),
});

/**
 * GET /api/past-performance
 * Firm-wide list. Optional filters: clientCompanyId, isCurrent.
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const { clientCompanyId, isCurrent } = req.query;

    const records = await listPastPerformance(consultingFirmId, {
      clientCompanyId: typeof clientCompanyId === 'string' ? clientCompanyId : undefined,
      isCurrent: isCurrent === undefined ? undefined : isCurrent === 'true',
    });

    res.json({ success: true, data: records });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/past-performance/:id
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const record = await getPastPerformanceById(consultingFirmId, req.params.id);
    if (!record) throw new NotFoundError('Past performance record');
    res.json({ success: true, data: record });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/past-performance  (ADMIN only)
 */
router.post(
  '/',
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req);
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors[0]?.message ?? 'Invalid past-performance payload');
      }

      const record = await createPastPerformance(consultingFirmId, parsed.data);

      void logAudit({
        consultingFirmId,
        actorUserId: req.user?.userId ?? null,
        action: 'CREATE',
        entityType: 'PastPerformanceRecord',
        entityId: record.id,
        rationale: `Created past-performance record "${record.contractNumber}" (${record.customerName})`,
        sourceIp: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.status(201).json({ success: true, data: record });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/past-performance/:id  (ADMIN only)
 */
router.patch(
  '/:id',
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req);
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.errors[0]?.message ?? 'Invalid past-performance payload');
      }

      const record = await updatePastPerformance(consultingFirmId, req.params.id, parsed.data);

      void logAudit({
        consultingFirmId,
        actorUserId: req.user?.userId ?? null,
        action: 'UPDATE',
        entityType: 'PastPerformanceRecord',
        entityId: record.id,
        rationale: `Updated past-performance record "${record.contractNumber}"`,
        sourceIp: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.json({ success: true, data: record });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/past-performance/:id  (ADMIN only)
 */
router.delete(
  '/:id',
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req);
      await deletePastPerformance(consultingFirmId, req.params.id);

      void logAudit({
        consultingFirmId,
        actorUserId: req.user?.userId ?? null,
        action: 'DELETE',
        entityType: 'PastPerformanceRecord',
        entityId: req.params.id,
        rationale: 'Deleted past-performance record',
        sourceIp: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      });

      res.json({ success: true, data: { id: req.params.id } });
    } catch (err) {
      next(err);
    }
  }
);

export default router;

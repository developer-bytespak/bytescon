// =============================================================
// Financial Penalties Routes
// =============================================================
import { Router, Response, NextFunction } from 'express';
import { prisma } from '../config/database';
import { authenticateJWT, requireRole } from '../middleware/auth';
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant';
import { AuthenticatedRequest } from '../types';
import { NotFoundError } from '../utils/errors';

const router = Router();
router.use(authenticateJWT, enforceTenantScope);
router.use(requireActiveBase, requireAddon('contract_analysis'));

/**
 * GET /api/penalties
 */
router.get('/', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const { clientCompanyId, isPaid, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string, 10) || 20));

    const where: any = { consultingFirmId };
    if (clientCompanyId) where.clientCompanyId = clientCompanyId;
    if (isPaid !== undefined) where.isPaid = isPaid === 'true';

    const [penalties, total] = await Promise.all([
      prisma.financialPenalty.findMany({
        where,
        include: {
          clientCompany: { select: { id: true, name: true } },
          submissionRecord: {
            include: {
              opportunity: { select: { id: true, title: true, agency: true } },
            },
          },
        },
        orderBy: { appliedAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.financialPenalty.count({ where }),
    ]);

    res.json({
      success: true,
      data: penalties,
      meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/penalties/summary
 */
router.get('/summary', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);

    const [total, paid, unpaid] = await Promise.all([
      prisma.financialPenalty.aggregate({
        where: { consultingFirmId },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.financialPenalty.aggregate({
        where: { consultingFirmId, isPaid: true },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.financialPenalty.aggregate({
        where: { consultingFirmId, isPaid: false },
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    res.json({
      success: true,
      data: {
        total: {
          count: total._count,
          amount: total._sum?.amount ?? 0,
        },
        paid: {
          count: paid._count,
          amount: paid._sum?.amount ?? 0,
        },
        outstanding: {
          count: unpaid._count,
          amount: unpaid._sum?.amount ?? 0,
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/penalties/:id
 */
router.get('/:id', async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const consultingFirmId = getTenantId(req);
    const penalty = await prisma.financialPenalty.findFirst({
      where: { id: req.params.id, consultingFirmId },
      include: {
        clientCompany: true,
        submissionRecord: { include: { opportunity: true } },
      },
    });

    if (!penalty) throw new NotFoundError('FinancialPenalty');
    res.json({ success: true, data: penalty });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/penalties/:id/pay
 */
router.put(
  '/:id/pay',
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const consultingFirmId = getTenantId(req);
      const penalty = await prisma.financialPenalty.findFirst({
        where: { id: req.params.id, consultingFirmId },
      });

      if (!penalty) throw new NotFoundError('FinancialPenalty');

      const updated = await prisma.financialPenalty.update({
        where: { id: req.params.id },
        data: { isPaid: true, paidAt: new Date() },
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
// =============================================================
// Health probes — admin-only diagnostics.
//
// /api/health/mailer
//   Send a test email to a sentinel address using the live mailer
//   path. Returns the DeliveryResult so an operator can see at a
//   glance whether the provider key is valid, the sender is
//   authenticated, and credits are available. Useful for catching
//   exhausted-quota and revoked-key states before users hit them.
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { authenticateJWT, requireRole } from '../middleware/auth'
import { enforceTenantScope } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { sendEmail } from '../services/mailer'

const router = Router()

const SENTINEL_ADDRESS = process.env.MAILER_PROBE_TO?.trim() || 'probe@bytescon.com'

router.post(
  '/mailer',
  authenticateJWT,
  enforceTenantScope,
  requireRole('ADMIN'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const result = await sendEmail({
        to: SENTINEL_ADDRESS,
        subject: 'Bytescon mailer probe',
        category: 'TRANSACTIONAL',
        textBody: `Mailer probe initiated at ${new Date().toISOString()} by admin ${req.user?.userId ?? 'unknown'}. If this lands, the mail path is healthy.`,
        consultingFirmId: req.user?.consultingFirmId,
        actorUserId: req.user?.userId,
      })
      res.json({ success: true, data: { sentTo: SENTINEL_ADDRESS, ...result } })
    } catch (err) {
      next(err)
    }
  }
)

export default router

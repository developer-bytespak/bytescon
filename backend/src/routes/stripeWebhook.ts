// =============================================================
// Stripe Webhook Handler — Raw body required for signature verification
// IMPORTANT: This router must be registered BEFORE express.json()
// =============================================================

import { Router, Request, Response } from 'express'
import express from 'express'
import { verifyWebhookSignature, handleWebhookEvent } from '../services/stripeService'
import { logger } from '../utils/logger'

const router = Router()

// Stripe webhooks must receive the RAW body to verify signature
router.post(
  '/stripe',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const signature = req.headers['stripe-signature']
    if (!signature || typeof signature !== 'string') {
      logger.warn('Stripe webhook missing signature header')
      return res.status(400).json({ success: false, error: 'Missing stripe-signature header', code: 'BAD_REQUEST' })
    }

    let event
    try {
      event = verifyWebhookSignature(req.body as Buffer, signature)
    } catch (err: any) {
      logger.warn('Stripe webhook signature verification failed', { error: err.message })
      return res.status(400).json({ success: false, error: 'Invalid signature', code: 'INVALID_SIGNATURE' })
    }

    try {
      const result = await handleWebhookEvent(event)
      if (!result.processed && result.reason === 'in_progress') {
        // A concurrent delivery of this event is mid-flight and holds the
        // idempotency claim. Non-2xx so Stripe redelivers later: if the
        // in-flight attempt dies, the retry reclaims and re-runs it.
        return res.status(409).json({ success: false, error: 'Event delivery already in progress', code: 'EVENT_IN_PROGRESS' })
      }
      return res.json({ success: true, data: { eventId: event.id, ...result } })
    } catch (err: any) {
      // Stripe will retry on non-2xx responses. Return 500 for transient errors.
      logger.error('Stripe webhook handler failed', { eventId: event.id, error: err.message })
      return res.status(500).json({ success: false, error: 'Webhook processing failed', code: 'WEBHOOK_ERROR' })
    }
  }
)

export default router

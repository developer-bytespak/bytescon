// =============================================================
// Stripe Webhook Secret Rotation Reminder Worker (PROMPT §8.1 #10)
//
// Stripe's webhook signing secret has no automatic expiration, but
// security best practice is to rotate it every 90 days. The platform
// has no way to introspect Stripe's view of the secret — we track
// rotation locally via STRIPE_WEBHOOK_SECRET_ROTATED_AT env var.
//
// This worker runs daily at 09:30 UTC (offset from deadline worker
// to avoid email-burst clustering) and emails the platform admin
// when the secret is approaching or past the rotation threshold.
//
// IMPORTANT: This worker does NOT touch the webhook handler itself
// (frozen surface per PROMPT §7). It only observes the rotated-at
// date and sends notifications.
// =============================================================

import { Queue, Worker } from 'bullmq'
import { logger } from '../utils/logger'
import { config } from '../config/config'
import { sendEmail } from '../services/mailer'

const QUEUE_NAME = 'stripe-webhook-rotation'
const WARN_AT_DAYS = 75    // first reminder at day 75
const URGENT_AT_DAYS = 90  // urgent reminder when overdue
const ROTATION_INTERVAL_DAYS = 90

function parseRedisUrl(url: string) {
  try {
    const u = new URL(url)
    return {
      host: u.hostname || 'localhost',
      port: parseInt(u.port || '6379', 10),
      password: u.password || undefined,
    }
  } catch {
    return { host: 'localhost', port: 6379 }
  }
}
const connection = parseRedisUrl(config.redis.url)

const queue = new Queue(QUEUE_NAME, { connection })

// Platform-operator email (not tenant-facing) — flows through the
// shared Resend mailer; brandedEmailTemplates is intentionally skipped
// because this is for ops, not customers.

function getAdminEmail(): string | null {
  return process.env.PLATFORM_ADMIN_EMAIL || process.env.EMAIL_FROM || null
}

// -------------------------------------------------------------
// Determine secret age. Returns null if not configured (worker
// stays silent — no env var = no reminder cycle started).
// -------------------------------------------------------------
function getSecretAgeDays(): number | null {
  const rotatedAt = process.env.STRIPE_WEBHOOK_SECRET_ROTATED_AT
  if (!rotatedAt) return null
  const t = Date.parse(rotatedAt)
  if (Number.isNaN(t)) {
    logger.warn('STRIPE_WEBHOOK_SECRET_ROTATED_AT is set but unparseable', { value: rotatedAt })
    return null
  }
  const ageMs = Date.now() - t
  return Math.floor(ageMs / 86400000)
}

// -------------------------------------------------------------
// Compose + send the reminder. Idempotency is best-effort — if the
// worker fires twice in the same day we'd send two emails. Acceptable
// for a low-frequency operational alert; not worth a Redis dedupe key.
// -------------------------------------------------------------
async function sendRotationReminder(ageDays: number, urgent: boolean) {
  const adminEmail = getAdminEmail()
  if (!adminEmail) {
    logger.warn('Stripe webhook rotation reminder skipped — no admin email configured', {
      ageDays,
    })
    return { sent: false, reason: 'no_admin_email' }
  }

  const subject = urgent
    ? `[URGENT] Stripe webhook secret is ${ageDays} days old — rotate now`
    : `Stripe webhook secret rotation due in ${ROTATION_INTERVAL_DAYS - ageDays} days`

  const lines = [
    `Bytescon Platform — Stripe Webhook Secret Rotation Reminder`,
    ``,
    `Current secret age: ${ageDays} days`,
    `Rotation interval:  ${ROTATION_INTERVAL_DAYS} days`,
    `Status:             ${urgent ? 'OVERDUE — rotate immediately' : `Due in ${ROTATION_INTERVAL_DAYS - ageDays} days`}`,
    ``,
    `To rotate:`,
    `  1. Stripe Dashboard → Developers → Webhooks → select endpoint`,
    `  2. Click "Roll secret" → confirm`,
    `  3. Copy the new whsec_... value`,
    `  4. SSH to droplet, edit /opt/govcon/app/.env.prod:`,
    `       STRIPE_WEBHOOK_SECRET=whsec_<new_value>`,
    `       STRIPE_WEBHOOK_SECRET_ROTATED_AT=${new Date().toISOString().slice(0, 10)}`,
    `  5. cd /opt/govcon/app && docker compose --env-file .env.prod -f docker-compose.prod.yml up -d backend`,
    `  6. Verify: trigger a test webhook from Stripe Dashboard, confirm 200 in bytescon_backend logs`,
    ``,
    `If this email recurs daily without action, billing will continue to`,
    `work but the security posture degrades. Webhook signature verification`,
    `keys older than 90 days are flagged in compliance audits.`,
  ]

  const text = lines.join('\n')
  const html = `<pre style="font-family: monospace; line-height: 1.5;">${text.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`

  const result = await sendEmail({
    to: adminEmail,
    subject,
    textBody: text,
    htmlBody: html,
    category: 'TRANSACTIONAL',
  })

  if (result.delivered) {
    logger.info('Stripe webhook rotation reminder sent', {
      to: adminEmail,
      ageDays,
      urgent,
      messageId: result.providerMessageId,
    })
    return { sent: true, messageId: result.providerMessageId }
  }
  if (result.devFallback) {
    logger.info('Stripe rotation reminder (dev mode, not sent)', { to: adminEmail, subject, ageDays })
    return { sent: true, mode: 'dev' }
  }
  logger.error('Stripe webhook rotation reminder failed to send', {
    to: adminEmail,
    ageDays,
    error: result.error,
  })
  return { sent: false, error: result.error }
}

// -------------------------------------------------------------
// Daily check: decide whether to send anything.
// -------------------------------------------------------------
async function checkRotationStatus() {
  const ageDays = getSecretAgeDays()

  if (ageDays === null) {
    // Not configured — stay silent. Operator hasn't opted in.
    logger.debug('Stripe webhook rotation check skipped — STRIPE_WEBHOOK_SECRET_ROTATED_AT not set')
    return { checked: true, sent: false, reason: 'not_configured' }
  }

  if (ageDays < WARN_AT_DAYS) {
    return { checked: true, sent: false, ageDays, reason: 'within_window' }
  }

  const urgent = ageDays >= URGENT_AT_DAYS
  const result = await sendRotationReminder(ageDays, urgent)
  return { checked: true, ageDays, urgent, ...result }
}

// -------------------------------------------------------------
// Worker boot
// -------------------------------------------------------------
export function startStripeWebhookRotationReminderWorker() {
  const worker = new Worker(QUEUE_NAME, async (job) => {
    if (job.name === 'check-rotation-status') {
      return checkRotationStatus()
    }
    throw new Error(`Unknown job: ${job.name}`)
  }, { connection })

  // Daily at 09:30 UTC (offset 30 min from the deadline worker so SMTP
  // bursts don't collide).
  queue.add(
    'check-rotation-status',
    {},
    {
      repeat: { pattern: '30 9 * * *' },
      removeOnComplete: 30,
      removeOnFail: 30,
    }
  ).then(() => {
    logger.info('Stripe webhook rotation reminder worker started (daily at 09:30 UTC)')
  }).catch(err => {
    logger.error('Failed to schedule Stripe rotation reminder', { error: err.message })
  })

  worker.on('completed', (job, result) => {
    logger.info('Stripe rotation reminder job complete', { jobId: job.id, result })
  })
  worker.on('failed', (job, err) => {
    logger.error('Stripe rotation reminder job failed', { jobId: job?.id, error: err.message })
  })

  return worker
}

// Manual trigger for ops
export async function triggerStripeRotationCheck() {
  return checkRotationStatus()
}

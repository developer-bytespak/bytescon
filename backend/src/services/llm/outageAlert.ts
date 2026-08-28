// =============================================================
// LLM outage alert
//
// Emails the platform admin when every provider attempt for a request
// has failed — i.e. a user just received 503 AI_UNAVAILABLE. The
// 2026-07-16 Anthropic credit exhaustion went unnoticed until a
// customer hit it; this closes that gap.
//
// Rate-limited via a Redis NX key to one email per 30 minutes so a
// sustained outage doesn't flood the inbox. Best-effort by design:
// alerting must never affect the request path, so every failure here
// is swallowed after a log line.
//
// When PR #93's platform-wide alerting service lands, this should be
// swapped onto it — the call site in llmRouter is the only consumer.
// =============================================================
import { redis } from '../../config/redis'
import { logger } from '../../utils/logger'
import { sendEmail } from '../mailer'

const ALERT_DEDUPE_KEY = 'llm:outage-alert:sent'
const ALERT_INTERVAL_SECONDS = 30 * 60

export async function notifyLlmOutage(detail: {
  provider: string
  task: string
  error: string
}): Promise<void> {
  try {
    const adminEmail = process.env.PLATFORM_ADMIN_EMAIL || process.env.EMAIL_FROM
    if (!adminEmail) return

    const claimed = await redis.set(
      ALERT_DEDUPE_KEY,
      new Date().toISOString(),
      'EX',
      ALERT_INTERVAL_SECONDS,
      'NX',
    )
    if (!claimed) return // an alert already went out in the last 30 minutes

    await sendEmail({
      to: adminEmail,
      subject: `[ALERT] AI generation failing on the platform (provider: ${detail.provider})`,
      textBody: [
        'Bytescon Platform — LLM provider outage',
        '',
        `Provider: ${detail.provider}`,
        `Task: ${detail.task}`,
        `Error: ${detail.error.slice(0, 500)}`,
        '',
        'Users are receiving "AI generation is temporarily unavailable" (503) for AI features until this is resolved.',
        'Common causes: Anthropic credit balance exhausted, invalid/rotated API key, provider outage.',
        'Check: console.anthropic.com → Plans & Billing, and /app/logs/error.log in bytescon_backend.',
        '',
        'Further alerts are suppressed for 30 minutes.',
      ].join('\n'),
      category: 'TRANSACTIONAL',
    })
    logger.info('LLM outage alert emailed to platform admin', { to: adminEmail, task: detail.task })
  } catch (err) {
    logger.warn('Failed to send LLM outage alert', { error: (err as Error).message })
  }
}

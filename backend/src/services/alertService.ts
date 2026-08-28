// =============================================================
// Ops alerting — the platform's "page the owner" primitive.
//
// Before this existed every failure path ended at logger.error →
// logs/error.log inside the container, which is how the nightly
// backup stayed dead for 34 nights. Anything that should wake a
// human calls sendOpsAlert(); delivery fans out to every channel
// that is configured:
//
//   email    PLATFORM_ADMIN_EMAIL (falls back to the first
//            PLATFORM_ADMIN_EMAILS entry, then EMAIL_FROM) via the
//            existing Resend mailer
//   webhook  ALERT_WEBHOOK_URL — JSON POST shaped to satisfy Slack
//            ({text}), Discord ({content}) and ntfy-style receivers
//   sms      ALERT_SMS_TO for severity 'critical' when Twilio is
//            configured
//
// Repeats of the same alert `key` are suppressed for
// ALERT_THROTTLE_HOURS (default 6) — Redis-backed when available so
// the window survives restarts, in-memory otherwise. Never throws:
// alerting must not take down the thing it is watching.
// =============================================================

import os from 'os'
import axios from 'axios'
import { sendEmail } from './mailer'
import { sendSms, isTwilioConfigured } from './smsService'
import { redis } from '../config/redis'
import { logger } from '../utils/logger'

export type AlertSeverity = 'critical' | 'warning' | 'info'

export interface OpsAlert {
  /** Throttle key — repeats within the window are suppressed. */
  key: string
  title: string
  detail?: string
  severity?: AlertSeverity
}

const WEBHOOK_TIMEOUT_MS = 5_000

function throttleMs(): number {
  const hours = Number(process.env.ALERT_THROTTLE_HOURS ?? 6)
  return (Number.isFinite(hours) && hours > 0 ? hours : 6) * 60 * 60 * 1000
}

const memoryThrottle = new Map<string, number>()

async function claimThrottleWindow(key: string, ttlMs: number): Promise<boolean> {
  try {
    if (redis.status === 'ready') {
      const ok = await redis.set(`ops-alert:${key}`, '1', 'PX', ttlMs, 'NX')
      return ok === 'OK'
    }
  } catch {
    // Redis down — fall through to the in-memory window
  }
  const now = Date.now()
  const last = memoryThrottle.get(key)
  if (last !== undefined && now - last < ttlMs) return false
  memoryThrottle.set(key, now)
  // keep the map from growing unbounded across long uptimes
  if (memoryThrottle.size > 1000) {
    for (const [k, t] of memoryThrottle) {
      if (now - t >= ttlMs) memoryThrottle.delete(k)
    }
  }
  return true
}

export function getAlertEmailRecipient(): string | null {
  return (
    process.env.PLATFORM_ADMIN_EMAIL?.trim() ||
    process.env.PLATFORM_ADMIN_EMAILS?.split(',')[0]?.trim() ||
    process.env.EMAIL_FROM?.trim() ||
    null
  )
}

/**
 * Fan an operational alert out to every configured channel. Returns which
 * channels actually delivered; { sent: false } when throttled or when no
 * channel is configured. NEVER throws.
 */
export async function sendOpsAlert(alert: OpsAlert): Promise<{ sent: boolean; channels: string[]; throttled?: boolean }> {
  try {
    const severity = alert.severity ?? 'warning'

    if (!(await claimThrottleWindow(alert.key, throttleMs()))) {
      return { sent: false, channels: [], throttled: true }
    }

    const subject = `[Bytescon ${severity.toUpperCase()}] ${alert.title}`
    const body = [
      alert.title,
      '',
      alert.detail ?? '(no detail)',
      '',
      `severity: ${severity}`,
      `key:      ${alert.key}`,
      `host:     ${os.hostname()}`,
      `time:     ${new Date().toISOString()}`,
    ].join('\n')

    const channels: string[] = []

    const to = getAlertEmailRecipient()
    if (to) {
      const result = await sendEmail({ to, subject, textBody: body, category: 'TRANSACTIONAL' }).catch(
        (err: Error) => {
          logger.error('Ops alert email failed', { key: alert.key, error: err.message })
          return null
        },
      )
      if (result?.delivered) channels.push('email')
    }

    const webhookUrl = process.env.ALERT_WEBHOOK_URL?.trim()
    if (webhookUrl) {
      const delivered = await axios
        .post(
          webhookUrl,
          // one payload that satisfies Slack ({text}), Discord ({content});
          // receivers ignore the fields they don't know
          { text: `${subject}\n${alert.detail ?? ''}`, content: `${subject}\n${alert.detail ?? ''}`, title: subject, message: body },
          { timeout: WEBHOOK_TIMEOUT_MS },
        )
        .then(() => true)
        .catch((err: Error) => {
          logger.error('Ops alert webhook failed', { key: alert.key, error: err.message })
          return false
        })
      if (delivered) channels.push('webhook')
    }

    const smsTo = process.env.ALERT_SMS_TO?.trim()
    if (severity === 'critical' && smsTo && isTwilioConfigured()) {
      const result = await sendSms({
        to: smsTo,
        body: `${subject} — ${(alert.detail ?? '').slice(0, 120)}`,
        reason: `ops-alert:${alert.key}`,
      }).catch((err: Error) => {
        logger.error('Ops alert SMS failed', { key: alert.key, error: err.message })
        return null
      })
      if (result?.success) channels.push('sms')
    }

    if (channels.length === 0) {
      // still loudly visible in logs, and the throttle window was consumed
      logger.error('Ops alert produced no delivery (configure PLATFORM_ADMIN_EMAIL / ALERT_WEBHOOK_URL / RESEND_API_KEY)', {
        key: alert.key,
        title: alert.title,
        severity,
      })
    } else {
      logger.warn('Ops alert sent', { key: alert.key, title: alert.title, severity, channels })
    }

    return { sent: channels.length > 0, channels }
  } catch (err: any) {
    logger.error('sendOpsAlert failed', { key: alert.key, error: err?.message })
    return { sent: false, channels: [] }
  }
}

// =============================================================
// Mailer — Resend in production, dev-log fallback otherwise.
//
// Behavior:
//   - If RESEND_API_KEY is set: sends via Resend HTTPS API.
//   - Else: logs the email payload to the backend logs and returns
//     `{ delivered: false, devFallback: true }`. Dev workflow that
//     reads the verification URL out of the response (mirroring the
//     forgot-password pattern) keeps working unchanged.
//
// Env vars (set in .env.prod):
//   RESEND_API_KEY    — full key, starts with "re_"
//   EMAIL_FROM        — domain-authenticated address (e.g. noreply@bytescon.com)
//   EMAIL_FROM_NAME   — optional display name (default "Bytescon")
//   EMAIL_REPLY_TO    — monitored replyable address (default support@<from-domain>)
//   EMAIL_UNSUBSCRIBE_MAILTO — List-Unsubscribe contact (default unsubscribe@<from-domain>)
//   PUBLIC_APP_URL    — base for verification / reset links
//
// Resend domain authentication: add the MX/TXT/DKIM records Resend
// issues for the EMAIL_FROM domain. Without domain auth Gmail will
// spam-folder the message even if the API accepts it. See
// https://resend.com/docs/dashboard/domains/introduction
// =============================================================
import { logger } from '../utils/logger'
import { logAudit } from './auditService'

export interface EmailMessage {
  to: string
  subject: string
  textBody: string
  htmlBody?: string
  category?: 'EMAIL_VERIFICATION' | 'PASSWORD_RESET' | 'TRANSACTIONAL' | 'BETA_QUESTIONNAIRE'
  // When provided and a permanent (4xx) failure occurs, an
  // EMAIL_DELIVERY_FAILED audit row is written under this firm.
  consultingFirmId?: string | null
  actorUserId?: string | null
}

export interface DeliveryResult {
  delivered: boolean
  devFallback?: boolean
  provider?: string
  providerMessageId?: string | null
  error?: string
}

const RESEND_API = 'https://api.resend.com/emails'

function getEnv() {
  const apiKey = process.env.RESEND_API_KEY?.trim() || null
  const from = process.env.EMAIL_FROM?.trim() || 'noreply@bytescon.com'
  const fromName = process.env.EMAIL_FROM_NAME?.trim() || 'Bytescon'
  const domain = from.split('@')[1] || 'bytescon.com'
  // A monitored, replyable address improves deliverability and trust vs a pure
  // no-reply sender. Override with EMAIL_REPLY_TO (point it at a real mailbox).
  const replyTo = process.env.EMAIL_REPLY_TO?.trim() || `support@${domain}`
  // mailto List-Unsubscribe. We deliberately omit List-Unsubscribe-Post
  // (one-click) since that requires a hosted https POST handler we don't have.
  const unsubscribeMailto = process.env.EMAIL_UNSUBSCRIBE_MAILTO?.trim() || `unsubscribe@${domain}`
  return { apiKey, from, fromName, replyTo, unsubscribeMailto }
}

/**
 * Send via Resend mail API. Retries once on transient (5xx, network)
 * failures. Returns delivered:false on permanent failure (4xx) so the
 * caller can decide whether to surface to the user.
 */
async function sendViaResend(
  msg: EmailMessage,
  apiKey: string,
  from: string,
  fromName: string,
  replyTo: string,
  unsubscribeMailto: string
): Promise<DeliveryResult> {
  const body = {
    from: `${fromName} <${from}>`,
    to: [msg.to],
    reply_to: replyTo,
    subject: msg.subject,
    text: msg.textBody,
    ...(msg.htmlBody ? { html: msg.htmlBody } : {}),
    headers: { 'List-Unsubscribe': `<mailto:${unsubscribeMailto}>` },
    ...(msg.category ? { tags: [{ name: 'category', value: msg.category }] } : {}),
  }

  const attempt = async (): Promise<{ ok: boolean; status: number; messageId: string | null; errorBody?: string }> => {
    const res = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (res.status >= 200 && res.status < 300) {
      const json = (await res.json().catch(() => ({}))) as { id?: string }
      return { ok: true, status: res.status, messageId: json.id ?? null }
    }
    const errorBody = await res.text().catch(() => '')
    return { ok: false, status: res.status, messageId: null, errorBody: errorBody.slice(0, 500) }
  }

  try {
    let result = await attempt()
    // Retry once on 5xx — transient provider blips happen
    if (!result.ok && result.status >= 500) {
      await new Promise((r) => setTimeout(r, 750))
      result = await attempt()
    }

    if (result.ok) {
      logger.info('Mailer (resend) — delivered', {
        to: msg.to,
        subject: msg.subject,
        category: msg.category,
        messageId: result.messageId,
      })
      return { delivered: true, provider: 'resend', providerMessageId: result.messageId }
    }

    logger.warn('Mailer (resend) — failed', {
      to: msg.to,
      subject: msg.subject,
      status: result.status,
      error: result.errorBody,
    })
    return {
      delivered: false,
      provider: 'resend',
      error: `resend status=${result.status}: ${result.errorBody ?? ''}`,
    }
  } catch (err) {
    logger.error('Mailer (resend) — exception', { error: (err as Error).message, to: msg.to })
    return { delivered: false, provider: 'resend', error: (err as Error).message }
  }
}

export async function sendEmail(msg: EmailMessage): Promise<DeliveryResult> {
  const { apiKey, from, fromName, replyTo, unsubscribeMailto } = getEnv()

  if (!apiKey) {
    logger.info('Mailer (dev) — would send email (RESEND_API_KEY not set)', {
      to: msg.to,
      subject: msg.subject,
      category: msg.category ?? 'TRANSACTIONAL',
      bodyPreview: msg.textBody.slice(0, 200),
    })
    return { delivered: false, devFallback: true }
  }

  const result = await sendViaResend(msg, apiKey, from, fromName, replyTo, unsubscribeMailto)

  // Surface non-dev permanent failures: write an audit row so operators
  // see "EMAIL_DELIVERY_FAILED" rows when a provider key is revoked,
  // quota is exhausted, or a recipient is hard-bounced.
  if (!result.delivered && msg.consultingFirmId) {
    void logAudit({
      consultingFirmId: msg.consultingFirmId,
      actorUserId: msg.actorUserId ?? null,
      action: 'EMAIL_DELIVERY_FAILED',
      entityType: 'EmailMessage',
      rationale: `${msg.category ?? 'TRANSACTIONAL'} to ${msg.to}: ${result.error ?? 'unknown'}`,
    })
  }

  return result
}

/**
 * Build the verification URL the user clicks. Frontend route consumes the
 * token and POSTs to /api/auth/verify-email.
 */
export function buildEmailVerificationUrl(token: string): string {
  const base = process.env.PUBLIC_APP_URL || 'http://localhost:5173'
  return `${base}/verify-email?token=${encodeURIComponent(token)}`
}

export function buildPasswordResetUrl(token: string): string {
  const base = process.env.PUBLIC_APP_URL || 'http://localhost:5173'
  return `${base}/reset-password?token=${encodeURIComponent(token)}`
}

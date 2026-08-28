// =============================================================
// SMS Service — Twilio integration for urgent alerts
// Compliance: phone numbers digested in logs (PII), all sends audited
// Tenancy: scoped by consultingFirmId from caller
// =============================================================

import twilio from 'twilio'
import crypto from 'crypto'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'

// -------------------------------------------------------------
// Local types — keeps us decoupled from Twilio internal types
// -------------------------------------------------------------

interface TwilioClient {
  messages: {
    create(opts: { to: string; from: string; body: string }): Promise<{ sid: string; status: string }>
  }
}

// -------------------------------------------------------------
// Lazy client init — env vars required only at first call
// -------------------------------------------------------------

let twilioClient: TwilioClient | null = null

export function getTwilio(): TwilioClient {
  if (twilioClient) return twilioClient

  const sid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!sid || !token) {
    throw new Error('TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN must be configured')
  }

  twilioClient = twilio(sid, token) as unknown as TwilioClient
  return twilioClient
}

export function isTwilioConfigured(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  )
}

// -------------------------------------------------------------
// Phone digest — last 4 digits only for logging (PII safety)
// -------------------------------------------------------------

function phoneDigest(phone: string): string {
  const cleaned = phone.replace(/\D/g, '')
  if (cleaned.length < 4) return '****'
  return `***-${cleaned.slice(-4)}`
}

// -------------------------------------------------------------
// E.164 validation — basic guard before hitting Twilio
// -------------------------------------------------------------

function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.replace(/\s|-|\(|\)/g, ''))
}

function normalizePhone(phone: string): string {
  return phone.replace(/\s|-|\(|\)/g, '')
}

// -------------------------------------------------------------
// Cap message length (Twilio splits at 160 chars per segment)
// -------------------------------------------------------------

const MAX_SMS_LENGTH = 320

function truncateMessage(body: string): string {
  if (body.length <= MAX_SMS_LENGTH) return body
  return body.slice(0, MAX_SMS_LENGTH - 3) + '...'
}

// -------------------------------------------------------------
// Send SMS (dev mode logs, prod mode sends via Twilio)
// -------------------------------------------------------------

export async function sendSms(opts: {
  to: string
  body: string
  consultingFirmId?: string
  reason?: string
}): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const normalized = normalizePhone(opts.to)
  const digest = phoneDigest(normalized)
  const body = truncateMessage(opts.body)

  if (!isValidE164(normalized)) {
    logger.warn('SMS rejected — invalid E.164 phone', { phone: digest })
    return { success: false, error: 'Invalid phone number format (must be E.164: +12025551234)' }
  }

  const fromNumber = process.env.TWILIO_FROM_NUMBER
  if (!isTwilioConfigured() || !fromNumber) {
    logger.info('SMS (dev mode, not sent)', {
      to: digest,
      bodyLength: body.length,
      reason: opts.reason,
      firmId: opts.consultingFirmId,
    })
    return { success: true, messageId: 'dev-mode-not-sent' }
  }

  try {
    const message = await getTwilio().messages.create({
      to: normalized,
      from: fromNumber,
      body,
    })

    logger.info('SMS sent', {
      to: digest,
      messageId: message.sid,
      status: message.status,
      reason: opts.reason,
      firmId: opts.consultingFirmId,
    })

    // Audit trail (compliance) — phone hashed, not raw
    if (opts.consultingFirmId) {
      const phoneHash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)
      await prisma.complianceLog.create({
        data: {
          consultingFirmId: opts.consultingFirmId,
          entityType: 'OTHER',
          entityId: message.sid,
          fromStatus: 'PENDING',
          toStatus: 'SENT',
          reason: `SMS sent (${opts.reason || 'unspecified'}) — phone hash ${phoneHash}`,
          triggeredBy: 'sms-service',
        },
      }).catch(err => {
        logger.warn('Failed to audit SMS', { messageId: message.sid, error: err.message })
      })
    }

    return { success: true, messageId: message.sid }
  } catch (err: any) {
    logger.error('SMS send failed', {
      to: digest,
      reason: opts.reason,
      error: err.message,
    })
    return { success: false, error: err.message }
  }
}

// -------------------------------------------------------------
// Pre-built SMS templates (kept under 160 chars for single-segment)
// -------------------------------------------------------------

export async function smsDeliverableReady(opts: {
  to: string
  consultingFirmId: string
  firmDisplayName: string
  deliverableTitle: string
}) {
  const title = opts.deliverableTitle.length > 50
    ? opts.deliverableTitle.slice(0, 47) + '...'
    : opts.deliverableTitle
  const body = `${opts.firmDisplayName}: New deliverable ready for your review — "${title}". Login to your portal to approve or request changes.`
  return sendSms({
    to: opts.to,
    body,
    consultingFirmId: opts.consultingFirmId,
    reason: 'deliverable_ready',
  })
}

export async function smsDeadlineUrgent(opts: {
  to: string
  consultingFirmId: string
  firmDisplayName: string
  documentTitle: string
  hoursUntilDue: number
}) {
  const title = opts.documentTitle.length > 40
    ? opts.documentTitle.slice(0, 37) + '...'
    : opts.documentTitle
  const body = `${opts.firmDisplayName} URGENT: "${title}" due in ${opts.hoursUntilDue}h. Complete in portal to avoid late penalty.`
  return sendSms({
    to: opts.to,
    body,
    consultingFirmId: opts.consultingFirmId,
    reason: 'deadline_urgent',
  })
}

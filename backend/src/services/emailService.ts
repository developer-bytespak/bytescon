// =============================================================
// Email Service — branded notifications for client-portal flows.
//
// All transport now flows through services/mailer.ts (Resend) —
// nodemailer/SMTP is gone. Public exports keep their existing shape
// so callers (routes/clientDeliverables.ts, workers/deadlineNotificationWorker.ts)
// don't need updating.
// =============================================================

import { logger } from '../utils/logger'
import { sendEmail as transportSend, DeliveryResult } from './mailer'
import {
  renderBrandedEmail,
  deliverableReadyEmail,
  deadlineReminderEmail,
  approvalConfirmationEmail,
  BrandedTemplateData,
} from './brandedEmailTemplates'

// -------------------------------------------------------------
// Internal — delegate to mailer.ts and translate shape for callers
// -------------------------------------------------------------
async function sendEmail(opts: {
  to: string
  subject: string
  html: string
  text: string
  firmId?: string
  // fromName is honored at the mailer level via EMAIL_FROM_NAME env;
  // the brandedEmailTemplates already render firm-specific branding
  // into the body, so per-call overrides are not needed.
  fromName?: string
}): Promise<{ success: boolean; messageId?: string | null; error?: string }> {
  const result: DeliveryResult = await transportSend({
    to: opts.to,
    subject: opts.subject,
    textBody: opts.text,
    htmlBody: opts.html,
    category: 'TRANSACTIONAL',
    consultingFirmId: opts.firmId ?? null,
  })

  if (result.delivered) {
    return { success: true, messageId: result.providerMessageId }
  }
  if (result.devFallback) {
    logger.info('Email (dev mode, not sent)', { to: opts.to, subject: opts.subject })
    return { success: true, messageId: 'dev-mode-not-sent' }
  }
  return { success: false, error: result.error }
}

// -------------------------------------------------------------
// Public API: branded notifications
// -------------------------------------------------------------

export async function notifyDeliverableReady(opts: {
  firmId: string
  recipientEmail: string
  recipientName: string
  deliverableTitle: string
  portalUrl: string
  fromName?: string
}) {
  const email = await deliverableReadyEmail({
    firmId: opts.firmId,
    clientName: opts.recipientName,
    deliverableTitle: opts.deliverableTitle,
    portalUrl: opts.portalUrl,
  })

  return sendEmail({
    to: opts.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    firmId: opts.firmId,
    fromName: opts.fromName,
  })
}

export async function notifyDeadlineApproaching(opts: {
  firmId: string
  recipientEmail: string
  recipientName: string
  documentTitle: string
  daysUntilDue: number
  portalUrl: string
  fromName?: string
}) {
  const email = await deadlineReminderEmail({
    firmId: opts.firmId,
    clientName: opts.recipientName,
    documentTitle: opts.documentTitle,
    daysUntilDue: opts.daysUntilDue,
    portalUrl: opts.portalUrl,
  })

  return sendEmail({
    to: opts.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    firmId: opts.firmId,
    fromName: opts.fromName,
  })
}

export async function notifyApprovalReceived(opts: {
  firmId: string
  recipientEmail: string
  recipientName: string
  deliverableTitle: string
  portalUrl: string
  fromName?: string
}) {
  const email = await approvalConfirmationEmail({
    firmId: opts.firmId,
    clientName: opts.recipientName,
    deliverableTitle: opts.deliverableTitle,
    portalUrl: opts.portalUrl,
  })

  return sendEmail({
    to: opts.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    firmId: opts.firmId,
    fromName: opts.fromName,
  })
}

export async function sendCustomBrandedEmail(opts: BrandedTemplateData & {
  recipientEmail: string
  fromName?: string
}) {
  const email = await renderBrandedEmail(opts)
  return sendEmail({
    to: opts.recipientEmail,
    subject: email.subject,
    html: email.html,
    text: email.text,
    firmId: opts.firmId,
    fromName: opts.fromName,
  })
}

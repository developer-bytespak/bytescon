// =============================================================
// Branded Email Templates - White-Label Email Generation
// =============================================================
// Generates HTML email templates with firm-specific branding.
// Phase 4B will hook this into actual email sending (SendGrid/SES).
// =============================================================

import { prisma } from '../config/database'

export interface BrandedTemplateData {
  firmId: string
  recipientName?: string
  ctaUrl?: string
  ctaText?: string
  bodyHtml: string
  subject: string
  preheader?: string
}

interface FirmBranding {
  displayName: string
  tagline: string
  logoUrl: string | null
  primaryColor: string
  secondaryColor: string
  isVeteranOwned: boolean
}

async function getFirmBranding(firmId: string): Promise<FirmBranding> {
  // Branding lookup must NEVER throw out of here — these templates are rendered
  // inside flows (e.g. registration / password-reset email sends) that treat
  // email delivery as best-effort. On any DB error fall back to defaults.
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: firmId },
    select: {
      name: true,
      isVeteranOwned: true,
      brandingDisplayName: true,
      brandingTagline: true,
      brandingLogoUrl: true,
      brandingPrimaryColor: true,
      brandingSecondaryColor: true,
    },
  }).catch(() => null)

  return {
    displayName: firm?.brandingDisplayName || firm?.name || 'Bytescon',
    tagline: firm?.brandingTagline || 'Federal contracting intelligence.',
    logoUrl: firm?.brandingLogoUrl || null,
    primaryColor: firm?.brandingPrimaryColor || '#fbbf24',
    secondaryColor: firm?.brandingSecondaryColor || '#f59e0b',
    isVeteranOwned: firm?.isVeteranOwned ?? false,
  }
}

export async function renderBrandedEmail(data: BrandedTemplateData): Promise<{
  subject: string
  html: string
  text: string
}> {
  const brand = await getFirmBranding(data.firmId)

  // Sender context + optional postal address improve trust signals and CAN-SPAM
  // posture. Set EMAIL_COMPANY_ADDRESS to a real mailing address in prod.
  const appDomain = process.env.EMAIL_APP_DOMAIN?.trim() || 'bytescon.com'
  const companyAddress = process.env.EMAIL_COMPANY_ADDRESS?.trim() || ''

  const logoSection = brand.logoUrl
    ? `<img src="${brand.logoUrl}" alt="${brand.displayName}" style="max-height: 48px; max-width: 200px;" />`
    : `<div style="font-size: 24px; font-weight: 900; background: linear-gradient(90deg, ${brand.primaryColor}, ${brand.secondaryColor}); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; color: transparent;">${brand.displayName}</div>`

  const ctaButton = data.ctaUrl
    ? `<table cellpadding="0" cellspacing="0" border="0" style="margin: 24px 0;">
        <tr>
          <td style="border-radius: 6px; background: linear-gradient(90deg, ${brand.primaryColor}, ${brand.secondaryColor});">
            <a href="${data.ctaUrl}" style="display: inline-block; padding: 12px 24px; color: #0b0f1a; font-weight: 600; text-decoration: none; font-family: -apple-system, BlinkMacSystemFont, sans-serif;">
              ${data.ctaText || 'Open Portal'}
            </a>
          </td>
        </tr>
      </table>`
    : ''

  const veteranBadge = brand.isVeteranOwned
    ? `<p style="color: #f59e0b; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; margin-top: 16px;">★ Veteran Owned · Patriot Operated</p>`
    : ''

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.subject}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #040d1a; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  ${data.preheader ? `<div style="display: none; max-height: 0; overflow: hidden;">${data.preheader}</div>` : ''}

  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color: #040d1a;">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width: 560px; background-color: #071120; border: 1px solid ${brand.secondaryColor}33; border-radius: 12px; overflow: hidden;">

          <!-- Header -->
          <tr>
            <td style="padding: 24px; border-bottom: 1px solid ${brand.secondaryColor}22;">
              ${logoSection}
              <p style="color: #64748b; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; margin: 8px 0 0 0;">${brand.tagline}</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 32px 24px; color: #cbd5e1; font-size: 15px; line-height: 1.6;">
              ${data.recipientName ? `<p style="color: #e2e8f0; margin-top: 0;">Hi ${data.recipientName},</p>` : ''}
              ${data.bodyHtml}
              ${ctaButton}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding: 20px 24px; background-color: #050e1e; border-top: 1px solid ${brand.secondaryColor}22; text-align: center;">
              <p style="color: #475569; font-size: 11px; margin: 0;">
                Powered by <strong style="color: ${brand.secondaryColor};">${brand.displayName}</strong>
              </p>
              <p style="color: #3a4759; font-size: 10px; margin: 8px 0 0 0;">
                This message was sent by ${brand.displayName} via ${appDomain}.
              </p>
              ${companyAddress ? `<p style="color: #3a4759; font-size: 10px; margin: 4px 0 0 0;">${companyAddress}</p>` : ''}
              ${veteranBadge}
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`

  // Plain text fallback
  const text = `${brand.displayName}
${brand.tagline}
${'='.repeat(50)}

${data.recipientName ? `Hi ${data.recipientName},\n\n` : ''}${data.bodyHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}

${data.ctaUrl ? `\n${data.ctaText || 'Open Portal'}: ${data.ctaUrl}\n` : ''}

—
Powered by ${brand.displayName}${brand.isVeteranOwned ? '\n★ Veteran Owned · Patriot Operated' : ''}
This message was sent by ${brand.displayName} via ${appDomain}.${companyAddress ? `\n${companyAddress}` : ''}
`

  return {
    subject: data.subject,
    html,
    text,
  }
}

// =============================================================
// Pre-built template helpers
// =============================================================

export async function deliverableReadyEmail(opts: {
  firmId: string
  clientName: string
  deliverableTitle: string
  portalUrl: string
}) {
  return renderBrandedEmail({
    firmId: opts.firmId,
    recipientName: opts.clientName,
    subject: `New deliverable ready for review: ${opts.deliverableTitle}`,
    preheader: 'Your consultant has prepared a document for your review.',
    bodyHtml: `
      <p>Your consultant has prepared a new deliverable for your review:</p>
      <p style="background: #050e1e; border-left: 3px solid #fbbf24; padding: 12px 16px; margin: 16px 0;">
        <strong style="color: #fbbf24;">${opts.deliverableTitle}</strong>
      </p>
      <p>Click below to open the portal, review the document, and approve or request changes.</p>
    `,
    ctaUrl: opts.portalUrl,
    ctaText: 'Review Deliverable',
  })
}

export async function deadlineReminderEmail(opts: {
  firmId: string
  clientName: string
  documentTitle: string
  daysUntilDue: number
  portalUrl: string
}) {
  const urgency = opts.daysUntilDue <= 3 ? 'URGENT' : opts.daysUntilDue <= 7 ? 'Soon' : 'Reminder'
  return renderBrandedEmail({
    firmId: opts.firmId,
    recipientName: opts.clientName,
    subject: `${urgency}: ${opts.documentTitle} due in ${opts.daysUntilDue} day${opts.daysUntilDue === 1 ? '' : 's'}`,
    preheader: `Document deadline approaching — ${opts.daysUntilDue} day${opts.daysUntilDue === 1 ? '' : 's'} remaining`,
    bodyHtml: `
      <p>This is a reminder that the following document deadline is approaching:</p>
      <p style="background: #050e1e; border-left: 3px solid ${opts.daysUntilDue <= 3 ? '#dc2626' : '#fbbf24'}; padding: 12px 16px; margin: 16px 0;">
        <strong style="color: ${opts.daysUntilDue <= 3 ? '#dc2626' : '#fbbf24'};">${opts.documentTitle}</strong><br>
        <span style="color: #94a3b8;">Due in ${opts.daysUntilDue} day${opts.daysUntilDue === 1 ? '' : 's'}</span>
      </p>
      <p>Please complete and submit before the deadline to avoid late penalties.</p>
    `,
    ctaUrl: opts.portalUrl,
    ctaText: 'Open Portal',
  })
}

export async function approvalConfirmationEmail(opts: {
  firmId: string
  clientName: string
  deliverableTitle: string
  portalUrl: string
}) {
  return renderBrandedEmail({
    firmId: opts.firmId,
    recipientName: opts.clientName,
    subject: `Approved: ${opts.deliverableTitle}`,
    preheader: 'Your approval has been received.',
    bodyHtml: `
      <p>Thank you — your approval for the following deliverable has been recorded:</p>
      <p style="background: #050e1e; border-left: 3px solid #22c55e; padding: 12px 16px; margin: 16px 0;">
        <strong style="color: #22c55e;">✓ ${opts.deliverableTitle}</strong>
      </p>
      <p>Your consultant has been notified and will proceed with next steps.</p>
    `,
    ctaUrl: opts.portalUrl,
    ctaText: 'View in Portal',
  })
}

// =============================================================
// GB-103 Client Match Notification Email Renderer
//
// Renders the "new opportunities match your profile" email — one
// item (IMMEDIATE) or many (DIGEST) — as { subject, html, text }.
//
// Pure function: branding + matches are passed in (no DB access), so
// the CAN-SPAM content assertions can run without a database.
//
// CAN-SPAM elements (required on every send, asserted by tests):
//   - Clear sender identity (firm display name in header + footer).
//   - The registered company postal address, verbatim.
//   - A functioning unsubscribe / preference link.
// =============================================================

import { config } from '../config/config'

// Federal-portal palette — mirrors watchlistDigestEmail.ts. Hard-coded
// so the email stays inert (no CSS-variable resolution in mail clients).
const NAVY = '#0A1F44'
const NAVY_DEEP = '#061230'
const GOLD = '#C9A227'
const PARCHMENT = '#F5EFE0'
const BONE = '#F7F4ED'
const SLATE = '#475569'
const GRAPHITE = '#0F172A'

// GB-103 resolved input: the CAN-SPAM footer postal address. Sourced from
// config.notifications.canSpamAddress (set via CAN_SPAM_POSTAL_ADDRESS env var).
export const CAN_SPAM_POSTAL_ADDRESS = config.notifications.canSpamAddress

export interface MatchEmailItem {
  opportunityId: string
  title: string
  agency: string
  /** Match score 0-100. */
  matchScore: number
  /** Pre-formatted estimated value, e.g. "$1.2M" or "TBD". */
  estimatedValueDisplay: string
  daysToDeadline: number
  matchReasons: string[]
  url?: string | null
}

export interface RenderMatchEmailInput {
  firmDisplayName: string
  firmTagline?: string | null
  isVeteranOwned?: boolean
  /** Firm brand accent; defaults to gold. */
  accentColor?: string | null
  clientId: string
  clientName: string
  /** One item = immediate; many = digest. */
  matches: MatchEmailItem[]
  appUrl?: string
}

export interface RenderedMatchEmail {
  subject: string
  html: string
  text: string
  /** The preference/unsubscribe link embedded in the footer. */
  unsubscribeUrl: string
}

export function buildUnsubscribeUrl(appUrl: string, clientId: string): string {
  return `${appUrl}/settings/notifications?client=${encodeURIComponent(clientId)}`
}

export function renderClientMatchEmail(input: RenderMatchEmailInput): RenderedMatchEmail {
  const appUrl = input.appUrl || process.env.APP_URL || 'https://bytescon.com'
  const accent = input.accentColor || GOLD
  const displayName = input.firmDisplayName || 'Bytescon'
  const tagline = input.firmTagline || 'Federal Contracting Intelligence'
  const isVet = input.isVeteranOwned ?? false
  const unsubscribeUrl = buildUnsubscribeUrl(appUrl, input.clientId)
  const count = input.matches.length
  const isDigest = count > 1

  const subject = isDigest
    ? `${count} new federal opportunities match ${input.clientName}`
    : count === 1
      ? `New federal match: ${input.matches[0].title} (${input.matches[0].matchScore}% fit)`
      : `Federal opportunity update for ${input.clientName}`

  const intro = isDigest
    ? `<strong>${count}</strong> newly ingested federal opportunities match ${escape(input.clientName)}'s profile above your notification threshold. Detail on each below.`
    : `A newly ingested federal opportunity matches ${escape(input.clientName)}'s profile above your notification threshold.`

  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escape(subject)}</title>
</head>
<body style="margin:0;padding:0;background:${BONE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${GRAPHITE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BONE};">
  <tr>
    <td align="center" style="padding:32px 12px;">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid rgba(10,31,68,0.10);border-radius:8px;overflow:hidden;">

        <!-- Navy header -->
        <tr>
          <td style="background:${NAVY};padding:28px 36px 22px 36px;">
            <p style="margin:0;font-size:10px;letter-spacing:3px;color:#a8b6d4;text-transform:uppercase;">New Opportunity Match</p>
            <h1 style="margin:6px 0 4px 0;font-size:22px;line-height:28px;color:#ffffff;font-weight:700;">${escape(displayName)}</h1>
            <p style="margin:0;font-size:12px;color:#cdd6e8;">${escape(tagline)}</p>
            ${isVet ? `<p style="margin:8px 0 0 0;font-size:9px;letter-spacing:2px;color:${GOLD};text-transform:uppercase;">★ Veteran Owned</p>` : ''}
          </td>
        </tr>

        <tr><td style="background:${accent};height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>

        <!-- Intro -->
        <tr>
          <td style="background:${PARCHMENT};padding:18px 36px;">
            <p style="margin:0;font-size:13px;line-height:20px;color:${GRAPHITE};">${intro}</p>
          </td>
        </tr>

        ${input.matches.map((m) => matchRowHtml(m, accent, appUrl)).join('')}

        <!-- Footer CTA -->
        <tr>
          <td style="padding:26px 36px;background:#ffffff;border-top:1px solid rgba(10,31,68,0.08);" align="center">
            <a href="${appUrl}/opportunities" style="display:inline-block;padding:11px 26px;background:${NAVY};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;border-radius:4px;">Review in Bytescon →</a>
          </td>
        </tr>

        <!-- CAN-SPAM footer -->
        <tr>
          <td style="background:${NAVY_DEEP};padding:20px 36px;">
            <p style="margin:0;font-size:11px;line-height:16px;color:#cdd6e8;font-weight:600;">${escape(displayName)}</p>
            <p style="margin:4px 0 0 0;font-size:10px;line-height:16px;color:#a8b6d4;">${escape(CAN_SPAM_POSTAL_ADDRESS)}</p>
            <p style="margin:10px 0 0 0;font-size:10px;line-height:16px;color:#7281a6;">
              You are receiving this because notifications are enabled for ${escape(input.clientName)}.
              <a href="${unsubscribeUrl}" style="color:${accent};text-decoration:underline;">Unsubscribe or manage notification preferences</a>.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const text = renderText({
    displayName,
    clientName: input.clientName,
    matches: input.matches,
    appUrl,
    unsubscribeUrl,
  })

  return { subject, html, text, unsubscribeUrl }
}

function matchRowHtml(m: MatchEmailItem, accent: string, appUrl: string): string {
  const titleHtml = m.url
    ? `<a href="${m.url}" style="color:${NAVY};text-decoration:none;">${escape(m.title)}</a>`
    : escape(m.title)
  const reasons = m.matchReasons.length
    ? `<p style="margin:8px 0 0 0;font-size:11px;line-height:17px;color:${SLATE};font-style:italic;">${escape(m.matchReasons.join(' · '))}</p>`
    : ''
  return `
    <tr>
      <td style="padding:20px 36px;background:#ffffff;border-top:1px solid rgba(10,31,68,0.08);">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td>
              <span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;letter-spacing:1px;font-weight:700;background:${NAVY};color:#fff;">${m.matchScore}% FIT</span>
            </td>
          </tr>
          <tr>
            <td style="padding-top:8px;">
              <p style="margin:0;font-size:16px;line-height:22px;font-weight:700;color:${GRAPHITE};">${titleHtml}</p>
            </td>
          </tr>
          <tr>
            <td style="padding-top:6px;">
              <p style="margin:0;font-size:12px;color:${SLATE};">${escape(m.agency)} · Est. ${escape(m.estimatedValueDisplay)} · ${m.daysToDeadline} day${m.daysToDeadline === 1 ? '' : 's'} to deadline</p>
              ${reasons}
            </td>
          </tr>
          <tr>
            <td style="padding-top:10px;">
              <a href="${m.url || `${appUrl}/opportunities`}" style="font-size:12px;color:${accent};text-decoration:underline;">View opportunity →</a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`
}

function renderText(opts: {
  displayName: string
  clientName: string
  matches: MatchEmailItem[]
  appUrl: string
  unsubscribeUrl: string
}): string {
  const lines: string[] = []
  lines.push(`${opts.displayName} — New Opportunity Match`)
  lines.push('')
  lines.push(
    opts.matches.length > 1
      ? `${opts.matches.length} new federal opportunities match ${opts.clientName}:`
      : `A new federal opportunity matches ${opts.clientName}:`,
  )
  lines.push('')
  for (const m of opts.matches) {
    lines.push(`[${m.matchScore}% FIT] ${m.title}`)
    lines.push(`  ${m.agency} · Est. ${m.estimatedValueDisplay} · ${m.daysToDeadline} days to deadline`)
    if (m.matchReasons.length) lines.push(`  ${m.matchReasons.join(' · ')}`)
    if (m.url) lines.push(`  ${m.url}`)
    lines.push('')
  }
  lines.push(`Review: ${opts.appUrl}/opportunities`)
  lines.push('')
  lines.push('—')
  lines.push(opts.displayName)
  lines.push(CAN_SPAM_POSTAL_ADDRESS)
  lines.push(`Unsubscribe or manage preferences: ${opts.unsubscribeUrl}`)
  return lines.join('\n')
}

function escape(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

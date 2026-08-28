// =============================================================
// Watchlist Digest Email Renderer
// Federal-portal aesthetic per PROMPT.md §2.2: navy chrome, gold
// rule lines, parchment cards, monospace stats. Each digest is a
// single self-contained HTML email (table-based for client compat).
// =============================================================

import { prisma } from '../config/database'

// Palette — mirrors PROMPT.md tokens, hard-coded to keep this file
// inert (no runtime CSS variable resolution in email clients).
const NAVY = '#0A1F44'
const NAVY_DEEP = '#061230'
const GOLD = '#C9A227'
const PARCHMENT = '#F5EFE0'
const BONE = '#F7F4ED'
const SLATE = '#475569'
const GRAPHITE = '#0F172A'
const GREEN = '#15803D'
const RED = '#9E1B32'

export interface DigestRow {
  kind: 'NAICS' | 'AGENCY'
  label: string
  /** Pretty heading. e.g. "NAICS 541611 — Management Consulting Services" */
  title: string
  /** 2-line summary stat */
  stat1Label: string
  stat1Value: string
  stat2Label: string
  stat2Value: string
  /** Optional callout (e.g. "Top winner: ACME Corp · 12% share") */
  callout?: string
  /** Optional trend hint */
  trend?: 'UP' | 'DOWN' | 'FLAT'
}

interface RenderInput {
  firmId: string
  rows: DigestRow[]
  /** ISO weekstart shown in header */
  weekStart: Date
  appUrl?: string
}

/**
 * Render the digest as { subject, html, text }. Pulls firm branding
 * (display name, primary/secondary color, veteran flag) for the
 * header band.
 */
export async function renderWatchlistDigestEmail(input: RenderInput): Promise<{
  subject: string
  html: string
  text: string
}> {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: input.firmId },
    select: {
      name: true,
      isVeteranOwned: true,
      brandingDisplayName: true,
      brandingTagline: true,
      brandingPrimaryColor: true,
      brandingSecondaryColor: true,
    },
  })

  const displayName = firm?.brandingDisplayName || firm?.name || 'Bytescon'
  const tagline = firm?.brandingTagline || 'Federal Contracting Intelligence'
  const accent = firm?.brandingPrimaryColor || GOLD
  const accent2 = firm?.brandingSecondaryColor || NAVY
  const isVet = firm?.isVeteranOwned ?? false
  const appUrl = input.appUrl || 'https://bytescon.com'

  const weekLabel = input.weekStart.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  })

  const subject = `Weekly Market Watch · ${input.rows.length} update${input.rows.length === 1 ? '' : 's'} · ${weekLabel}`

  // ── Inline-style HTML, table-based for email client compat ──
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escape(subject)}</title>
<!--[if mso]><style type="text/css">body, table, td { font-family: Georgia, serif !important; }</style><![endif]-->
</head>
<body style="margin:0;padding:0;background:${BONE};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${GRAPHITE};-webkit-font-smoothing:antialiased;">
<!-- Outer wrapper -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BONE};">
  <tr>
    <td align="center" style="padding:32px 12px;">

      <!-- Card -->
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;background:#ffffff;border:1px solid rgba(10,31,68,0.10);border-radius:8px;overflow:hidden;box-shadow:0 8px 24px rgba(10,31,68,0.06);">

        <!-- Navy header band -->
        <tr>
          <td style="background:${NAVY};padding:28px 36px 22px 36px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:top;">
                  <p style="margin:0;font-size:10px;letter-spacing:3px;color:#a8b6d4;text-transform:uppercase;">Weekly Market Watch</p>
                  <h1 style="margin:6px 0 4px 0;font-size:22px;line-height:28px;color:#ffffff;font-weight:700;letter-spacing:-0.01em;">${escape(displayName)}</h1>
                  <p style="margin:0;font-size:12px;color:#cdd6e8;">${escape(tagline)}</p>
                </td>
                <td align="right" style="vertical-align:top;">
                  <p style="margin:0;font-size:10px;letter-spacing:2px;color:#a8b6d4;text-transform:uppercase;">Week of</p>
                  <p style="margin:4px 0 0 0;font-size:13px;color:#ffffff;font-weight:600;">${escape(weekLabel)}</p>
                  ${isVet ? `<p style="margin:8px 0 0 0;font-size:9px;letter-spacing:2px;color:${GOLD};text-transform:uppercase;">★ Veteran Owned</p>` : ''}
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Gold rule -->
        <tr><td style="background:${accent};height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>

        <!-- Parchment intro band -->
        <tr>
          <td style="background:${PARCHMENT};padding:18px 36px;">
            <p style="margin:0;font-size:13px;line-height:20px;color:${GRAPHITE};">
              ${input.rows.length === 0
                ? `No new activity in your watchlist this week. Add NAICS codes or agencies in <a href="${appUrl}/analytics" style="color:${NAVY};text-decoration:underline;">Deep Market Intelligence</a> to track competitive movement.`
                : `<strong>${input.rows.length}</strong> watched ${input.rows.length === 1 ? 'item has' : 'items have'} fresh activity from federal award data. Detail on each below.`}
            </p>
          </td>
        </tr>

        ${input.rows.length === 0 ? '' : input.rows.map(rowHtml(accent, accent2)).join('')}

        <!-- Footer CTA -->
        <tr>
          <td style="padding:28px 36px;background:#ffffff;border-top:1px solid rgba(10,31,68,0.08);">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center">
                  <a href="${appUrl}/analytics" style="display:inline-block;padding:11px 26px;background:${NAVY};color:#ffffff;text-decoration:none;font-size:13px;font-weight:600;letter-spacing:0.3px;border-radius:4px;">
                    Open Deep Market Intelligence →
                  </a>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:${NAVY_DEEP};padding:20px 36px;">
            <p style="margin:0;font-size:10px;line-height:16px;color:#a8b6d4;letter-spacing:0.5px;">
              ${escape(displayName)} · Powered by Bytescon Bytescon Engine
            </p>
            <p style="margin:6px 0 0 0;font-size:10px;line-height:16px;color:#7281a6;">
              You received this digest because items in your firm's watchlist have new federal award activity. Manage your watchlist in <a href="${appUrl}/analytics" style="color:${accent};text-decoration:underline;">Analytics → Deep Market Intelligence</a>.
            </p>
          </td>
        </tr>

      </table>
    </td>
  </tr>
</table>
</body>
</html>`

  const text = renderText({ displayName, weekLabel, rows: input.rows, appUrl })
  return { subject, html, text }
}

// ──────────────────────────────────────────────────────────────
// Row template — one block per watched NAICS / agency
// ──────────────────────────────────────────────────────────────
function rowHtml(accent: string, _accent2: string) {
  return (row: DigestRow) => {
    const trendChip = row.trend
      ? `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;letter-spacing:1px;font-weight:700;${
          row.trend === 'UP'
            ? `background:${GREEN};color:#fff;`
            : row.trend === 'DOWN'
              ? `background:${RED};color:#fff;`
              : `background:#94a3b8;color:#fff;`
        }">${row.trend === 'UP' ? '↑ TRENDING' : row.trend === 'DOWN' ? '↓ COOLING' : '→ STEADY'}</span>`
      : ''

    const kindChip = `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;letter-spacing:1px;font-weight:700;background:${NAVY};color:#fff;">${row.kind}</span>`

    return `
      <tr>
        <td style="padding:20px 36px;background:#ffffff;border-top:1px solid rgba(10,31,68,0.08);">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr>
              <td style="padding-bottom:6px;">
                ${kindChip}&nbsp;${trendChip}
              </td>
            </tr>
            <tr>
              <td style="padding-bottom:14px;">
                <p style="margin:0;font-size:16px;line-height:22px;font-weight:700;color:${GRAPHITE};">${escape(row.title)}</p>
              </td>
            </tr>
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PARCHMENT};border-left:3px solid ${accent};border-radius:3px;">
                  <tr>
                    <td style="padding:14px 16px;width:50%;">
                      <p style="margin:0;font-size:9px;letter-spacing:2px;color:${SLATE};text-transform:uppercase;">${escape(row.stat1Label)}</p>
                      <p style="margin:4px 0 0 0;font-size:20px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-weight:700;color:${NAVY};">${escape(row.stat1Value)}</p>
                    </td>
                    <td style="padding:14px 16px;width:50%;border-left:1px solid rgba(10,31,68,0.10);">
                      <p style="margin:0;font-size:9px;letter-spacing:2px;color:${SLATE};text-transform:uppercase;">${escape(row.stat2Label)}</p>
                      <p style="margin:4px 0 0 0;font-size:20px;font-family:'JetBrains Mono',Menlo,Consolas,monospace;font-weight:700;color:${NAVY};">${escape(row.stat2Value)}</p>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            ${row.callout ? `
            <tr>
              <td style="padding-top:10px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:${SLATE};font-style:italic;">${escape(row.callout)}</p>
              </td>
            </tr>` : ''}
          </table>
        </td>
      </tr>
    `
  }
}

function renderText(opts: { displayName: string; weekLabel: string; rows: DigestRow[]; appUrl: string }): string {
  const lines: string[] = []
  lines.push(`${opts.displayName} — Weekly Market Watch`)
  lines.push(`Week of ${opts.weekLabel}`)
  lines.push('')
  if (opts.rows.length === 0) {
    lines.push('No new activity in your watchlist this week.')
  } else {
    lines.push(`${opts.rows.length} watched item${opts.rows.length === 1 ? '' : 's'} with fresh activity:`)
    lines.push('')
    for (const r of opts.rows) {
      lines.push(`[${r.kind}] ${r.title}`)
      lines.push(`  ${r.stat1Label}: ${r.stat1Value}`)
      lines.push(`  ${r.stat2Label}: ${r.stat2Value}`)
      if (r.callout) lines.push(`  ${r.callout}`)
      if (r.trend) lines.push(`  Trend: ${r.trend}`)
      lines.push('')
    }
  }
  lines.push(`Open: ${opts.appUrl}/analytics`)
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

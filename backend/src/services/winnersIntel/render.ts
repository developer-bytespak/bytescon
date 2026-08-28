// =============================================================
// Winners Intel — render
//
// Turns a PrimeWinnerSlice into the markdown body the resolver loads
// at proposal-generation time. Output is the literal string that gets
// concatenated into the LLM's system prompt — every byte counts toward
// the 12K-token cap (spec §7.3).
//
// Number rounding: never write fake precision into the LLM prompt.
// Dollars round to nearest dollar (or K/M/B for readability),
// percentages to one decimal. The LLM cannot meaningfully use
// $1,234,567.89 vs $1.2M — the latter is shorter AND more honest
// about USAspending's data quality.
// =============================================================

import { PrimeWinnerSlice } from './distill'

/**
 * Some USAspending fields on /spending_by_award come back null for every row
 * (extent_competed, number_of_offers_received). Showing "<0.1%" across the
 * board is misleading; we hide the whole competition section when there's no
 * real signal. The set-aside section already self-suppresses via
 * renderSetAsideTable.
 */
function hasCompetitionSignal(slice: PrimeWinnerSlice): boolean {
  const c = slice.competitionProfile
  return (
    c.fullAndOpenPct >= 0.5 ||
    c.soleSourcePct >= 0.5 ||
    c.oneBidPct >= 0.5 ||
    c.avgOffersReceived !== null
  )
}

/**
 * UEI is null on spending_by_award (filter-only field). Detect the all-null
 * case so we can render the recipient table without a misleading "UEI" column
 * full of em-dashes. Future Phase 2B.5 per-award enrichment will populate UEIs;
 * the column will reappear automatically.
 */
function hasAnyUei(slice: PrimeWinnerSlice): boolean {
  return slice.topRecipients.some((r) => r.uei !== null && r.uei !== '')
}

export function renderGlobalSlice(slice: PrimeWinnerSlice): string {
  const lines: string[] = []
  lines.push('---')
  lines.push('slice: global')
  lines.push(`window: ${slice.windowStart} → ${slice.windowEnd}`)
  lines.push(`generated: ${slice.generatedAt}`)
  lines.push(`refresh: ${slice.refreshBatchId}`)
  lines.push('---')
  lines.push('')
  lines.push('# Federal Prime Award Patterns — Global Summary')
  lines.push('')
  lines.push(
    'A 24-month rolling window of federal prime contract awards on USAspending. ' +
    'Use as baseline only — agency-specific and NAICS-specific slices override these defaults.',
  )
  lines.push('')
  lines.push(
    '> **Sampling note:** USAspending only sorts spending_by_award results by ' +
    'Award Amount. This slice alternates the sort direction across the 24-month ' +
    'window to cover both the highest-dollar awards (megavehicles, IDV ceilings) ' +
    'and the lowest-dollar awards (simplified-acquisition orders, micro-purchases). ' +
    'Median and percentile values therefore reflect both tails rather than a true ' +
    'random sample.',
  )
  lines.push('')
  lines.push(`- **Total prime obligation in window:** ${formatBigDollar(slice.totalObligation)}`)
  lines.push(`- **Award count:** ${formatCount(slice.awardCount)}`)
  lines.push(`- **Median single-award value:** ${formatDollar(slice.contractValueDistribution.p50)}`)
  lines.push(`- **Distribution:** p10 ${formatDollar(slice.contractValueDistribution.p10)} · p25 ${formatDollar(slice.contractValueDistribution.p25)} · p75 ${formatDollar(slice.contractValueDistribution.p75)} · p90 ${formatDollar(slice.contractValueDistribution.p90)} · p99 ${formatDollar(slice.contractValueDistribution.p99)}`)
  lines.push('')
  lines.push('### Set-aside utilization (% of total obligation)')
  lines.push(...renderSetAsideTable(slice.setAsideUtilization))
  lines.push('')

  if (hasCompetitionSignal(slice)) {
    lines.push('### Competition profile')
    lines.push(`- Sole-source rate: ${formatPct(slice.competitionProfile.soleSourcePct)}`)
    lines.push(`- Full-and-open rate: ${formatPct(slice.competitionProfile.fullAndOpenPct)}`)
    lines.push(`- One-bid wins (reduced competition): ${formatPct(slice.competitionProfile.oneBidPct)}`)
    if (slice.competitionProfile.avgOffersReceived !== null) {
      lines.push(`- Average offers received on competed awards: ${slice.competitionProfile.avgOffersReceived.toFixed(1)}`)
    }
  }
  return lines.join('\n') + '\n'
}

export function renderAgencySlice(slice: PrimeWinnerSlice): string {
  if (slice.sliceKind !== 'agency') throw new Error(`renderAgencySlice called on ${slice.sliceKind} slice`)

  const lines: string[] = []
  lines.push('---')
  lines.push('slice: agency')
  if (slice.agencyToptierCode) lines.push(`agencyToptierCode: ${slice.agencyToptierCode}`)
  if (slice.agencyToptierName) lines.push(`agencyToptierName: ${escapeYaml(slice.agencyToptierName)}`)
  lines.push(`window: ${slice.windowStart} → ${slice.windowEnd}`)
  lines.push(`generated: ${slice.generatedAt}`)
  lines.push(`refresh: ${slice.refreshBatchId}`)
  lines.push('---')
  lines.push('')
  lines.push(`# ${slice.agencyToptierName ?? slice.agencyToptierCode ?? 'Agency'} — Winning Patterns`)
  lines.push('')

  lines.push('## Volume & dollar')
  lines.push(`- Awards in window: ${formatCount(slice.awardCount)}`)
  lines.push(`- Total obligation: ${formatBigDollar(slice.totalObligation)}`)
  lines.push(`- Median award: ${formatDollar(slice.contractValueDistribution.p50)} · p25 ${formatDollar(slice.contractValueDistribution.p25)} · p75 ${formatDollar(slice.contractValueDistribution.p75)} · p90 ${formatDollar(slice.contractValueDistribution.p90)}`)
  lines.push('')

  lines.push('## Set-aside utilization (% of obligation)')
  lines.push(...renderSetAsideTable(slice.setAsideUtilization))
  lines.push('')

  if (hasCompetitionSignal(slice)) {
    lines.push('## Competition')
    lines.push(`- Sole-source: ${formatPct(slice.competitionProfile.soleSourcePct)}`)
    lines.push(`- Full-and-open: ${formatPct(slice.competitionProfile.fullAndOpenPct)}`)
    if (slice.competitionProfile.avgOffersReceived !== null) {
      lines.push(`- Avg offers received: ${slice.competitionProfile.avgOffersReceived.toFixed(1)}`)
    }
    lines.push(`- One-bid wins: ${formatPct(slice.competitionProfile.oneBidPct)} (signals reduced competition lanes)`)
    lines.push('')
  }

  if (slice.pricingPatterns.avgPopMonths !== null || slice.pricingPatterns.avgBaseToTotalRatio !== null) {
    lines.push('## Period of performance & pricing')
    if (slice.pricingPatterns.avgPopMonths !== null) {
      lines.push(`- Average POP length: ${slice.pricingPatterns.avgPopMonths.toFixed(1)} months`)
    }
    if (slice.pricingPatterns.avgBaseToTotalRatio !== null) {
      lines.push(`- Average base-to-total option ratio: ${slice.pricingPatterns.avgBaseToTotalRatio.toFixed(2)}`)
    }
    lines.push('')
  }

  if (slice.topAwardingOffices.length > 0) {
    lines.push('## Top awarding offices')
    lines.push('| Office code | Awards | $ Total |')
    lines.push('|---|---:|---:|')
    for (const o of slice.topAwardingOffices) {
      lines.push(`| ${o.code} | ${formatCount(o.awardCount)} | ${formatBigDollar(o.totalObligation)} |`)
    }
    lines.push('')
  }

  if (slice.topRecipients.length > 0) {
    lines.push('## Top recipients (by obligation)')
    if (hasAnyUei(slice)) {
      lines.push('| Recipient | UEI | Awards | $ Total |')
      lines.push('|---|---|---:|---:|')
      for (const r of slice.topRecipients) {
        lines.push(`| ${escapeMd(truncate(r.name, 60))} | ${r.uei ?? '—'} | ${formatCount(r.awardCount)} | ${formatBigDollar(r.totalObligation)} |`)
      }
    } else {
      lines.push('| Recipient | Awards | $ Total |')
      lines.push('|---|---:|---:|')
      for (const r of slice.topRecipients) {
        lines.push(`| ${escapeMd(truncate(r.name, 60))} | ${formatCount(r.awardCount)} | ${formatBigDollar(r.totalObligation)} |`)
      }
    }
    lines.push('')
  }

  if (slice.geographyPattern.topPlaceOfPerformanceStates.length > 0) {
    lines.push('## Geographic concentration')
    const parts = slice.geographyPattern.topPlaceOfPerformanceStates.map((s) => `${s.state} (${formatPct(s.pct)})`)
    lines.push(`- Top PoP states: ${parts.join(', ')}`)
    lines.push('')
  }

  lines.push('## Notes for proposal authors')
  lines.push('- Page-count and graphic-count expectations are NOT in USAspending. Do not infer them from this slice.')
  lines.push('- Set-aside percentages are dollar-weighted; small awards under simplified-acquisition thresholds are heavily small-business but may be a small share of total dollars.')
  lines.push('- AI-extracted requirements still require human confirmation per platform compliance policy.')
  return lines.join('\n') + '\n'
}

export function renderNaicsSlice(slice: PrimeWinnerSlice): string {
  if (slice.sliceKind !== 'naics') throw new Error(`renderNaicsSlice called on ${slice.sliceKind} slice`)

  const lines: string[] = []
  lines.push('---')
  lines.push('slice: naics')
  if (slice.naics) lines.push(`naics: ${slice.naics}`)
  lines.push(`window: ${slice.windowStart} → ${slice.windowEnd}`)
  lines.push(`generated: ${slice.generatedAt}`)
  lines.push(`refresh: ${slice.refreshBatchId}`)
  lines.push('---')
  lines.push('')
  lines.push(`# NAICS ${slice.naics} — Winning Patterns`)
  lines.push('')

  lines.push('## Volume & dollar')
  lines.push(`- Awards in window: ${formatCount(slice.awardCount)}`)
  lines.push(`- Total obligation: ${formatBigDollar(slice.totalObligation)}`)
  lines.push(`- Median award: ${formatDollar(slice.contractValueDistribution.p50)} · p25 ${formatDollar(slice.contractValueDistribution.p25)} · p75 ${formatDollar(slice.contractValueDistribution.p75)} · p90 ${formatDollar(slice.contractValueDistribution.p90)}`)
  lines.push('')

  lines.push('## Set-aside utilization (% of obligation)')
  lines.push(...renderSetAsideTable(slice.setAsideUtilization))
  lines.push('')

  if (hasCompetitionSignal(slice)) {
    lines.push('## Competition')
    lines.push(`- Sole-source: ${formatPct(slice.competitionProfile.soleSourcePct)}`)
    lines.push(`- Full-and-open: ${formatPct(slice.competitionProfile.fullAndOpenPct)}`)
    if (slice.competitionProfile.avgOffersReceived !== null) {
      lines.push(`- Avg offers received: ${slice.competitionProfile.avgOffersReceived.toFixed(1)}`)
    }
    lines.push('')
  }

  if (slice.topRecipients.length > 0) {
    lines.push('## Top recipients in this NAICS')
    if (hasAnyUei(slice)) {
      lines.push('| Recipient | UEI | Awards | $ Total |')
      lines.push('|---|---|---:|---:|')
      for (const r of slice.topRecipients) {
        lines.push(`| ${escapeMd(truncate(r.name, 60))} | ${r.uei ?? '—'} | ${formatCount(r.awardCount)} | ${formatBigDollar(r.totalObligation)} |`)
      }
    } else {
      lines.push('| Recipient | Awards | $ Total |')
      lines.push('|---|---:|---:|')
      for (const r of slice.topRecipients) {
        lines.push(`| ${escapeMd(truncate(r.name, 60))} | ${formatCount(r.awardCount)} | ${formatBigDollar(r.totalObligation)} |`)
      }
    }
    lines.push('')
  }

  return lines.join('\n') + '\n'
}

// ---------- formatting helpers ----------

function renderSetAsideTable(util: Record<string, number>): string[] {
  const sorted = Object.entries(util).sort((a, b) => b[1] - a[1])
  if (sorted.length === 0) return ['_(no set-aside data in window)_']

  // Detect the no-real-data case: USAspending's spending_by_award endpoint
  // does not return Type of Set Aside, so all rows have null setAsideType
  // which the aggregator buckets under "OPEN". Reporting "100% OPEN" would
  // be a confident lie. Be explicit about the limitation instead.
  const onlyKey = sorted.length === 1 ? sorted[0][0] : null
  if (onlyKey === 'OPEN' && sorted[0][1] >= 99.5) {
    return [
      '_Set-aside breakdown is **not available** in this slice. The USAspending_',
      '_`spending_by_award` endpoint returns set-aside as filter-only metadata,_',
      '_not as a response field. A per-award detail enrichment pass is planned_',
      '_(see Winners Intel Phase 2B.5)._',
    ]
  }

  const lines: string[] = []
  lines.push('| Set-aside | % of obligation |')
  lines.push('|---|---:|')
  for (const [setAside, pct] of sorted) {
    if (pct < 0.1) continue  // skip noise <0.1%
    lines.push(`| ${escapeMd(setAside)} | ${formatPct(pct)} |`)
  }
  return lines
}

function formatDollar(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 10_000) return `$${(n / 1000).toFixed(0)}K`
  if (n >= 1000) return `$${(n / 1000).toFixed(1)}K`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function formatBigDollar(n: number): string {
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`
  return `$${Math.round(n).toLocaleString('en-US')}`
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

function formatPct(n: number): string {
  if (n < 0.05) return '<0.1%'
  if (n < 1) return `${n.toFixed(1)}%`
  if (n >= 100) return '100%'
  return `${n.toFixed(1)}%`
}

function escapeMd(s: string): string {
  // Pipes inside table cells break the table — escape them.
  return s.replace(/\|/g, '\\|')
}

function escapeYaml(s: string): string {
  // YAML strings with colons or quotes need quoting; keep it simple.
  if (/[:"\n]/.test(s)) return JSON.stringify(s)
  return s
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

// Exposed for tests
export const _internals = {
  formatDollar,
  formatPct,
  formatCount,
  escapeMd,
  truncate,
}

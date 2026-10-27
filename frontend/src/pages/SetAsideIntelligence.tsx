import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { setAsideApi } from '../services/api'
import { AddonGate } from '../components/AddonGate'
import { PageHeader, SectionHeader, Skeleton, SkeletonRows } from '../components/ui'
import {
  Award, ShieldCheck, AlertTriangle, ExternalLink, Target,
} from 'lucide-react'

const TYPE_LABELS: Record<string, string> = {
  SDVOSB: 'SDVOSB',
  VOSB: 'Veteran-Owned',
  WOSB: 'WOSB',
  EDWOSB: 'EDWOSB',
  SBA_8A: '8(a)',
  HUBZONE: 'HUBZone',
  TOTAL_SMALL_BUSINESS: 'Total Small Business',
  SMALL_BUSINESS: 'Small Business',
  NONE: 'Full & Open',
}

function pct(n: number | null | undefined) {
  if (n == null) return '—'
  return `${Math.round(n * 100)}%`
}

function CertChip({ label, active }: { label: string; active: boolean }) {
  return (
    <span
      className={`chip ${active ? 'chip-success' : 'chip-neutral opacity-60'}`}
    >
      {label}
    </span>
  )
}

function EligibilityBadge({ anyEligible, verdicts }: { anyEligible: boolean; verdicts: Array<{ verdict: string }> }) {
  if (anyEligible) {
    return <span className="chip chip-success"><span className="chip-dot" aria-hidden="true" />Eligible</span>
  }
  if (verdicts.some((v) => v.verdict === 'UNKNOWN' || v.verdict === 'OPEN')) {
    return <span className="chip chip-gold"><span className="chip-dot" aria-hidden="true" />Check</span>
  }
  return <span className="chip chip-danger"><span className="chip-dot" aria-hidden="true" />Not eligible</span>
}

function SetAsideBody() {
  const [typeFilter, setTypeFilter] = useState<string | undefined>(undefined)

  const { data: overviewData, isLoading: overviewLoading } = useQuery({
    queryKey: ['setaside-overview'],
    queryFn: () => setAsideApi.overview(),
    staleTime: 60_000,
  })
  const { data: scannerData, isLoading: scannerLoading } = useQuery({
    queryKey: ['setaside-scanner', typeFilter ?? 'all'],
    queryFn: () => setAsideApi.scanner(typeFilter ? { type: typeFilter } : undefined),
    staleTime: 60_000,
  })
  const { data: ratesData, isLoading: ratesLoading } = useQuery({
    queryKey: ['setaside-agency-rates'],
    queryFn: () => setAsideApi.agencyRates(),
    // Each agency costs 3 USAspending queries server-side (24h cached there).
    staleTime: 30 * 60_000,
  })

  const overview = overviewData?.data
  const landscape = (overview?.landscape ?? []) as any[]
  const certProfile = (overview?.certProfile ?? []) as any[]
  const knownTypes = (overview?.knownTypes ?? []) as string[]
  const scanner = (scannerData?.data ?? []) as any[]
  const rates = (ratesData?.data ?? []) as any[]
  const maxCount = Math.max(1, ...landscape.map((l) => l.count))

  return (
    <div className="space-y-6">
      {/* Header */}
      <PageHeader
        title="Set-Aside Intelligence"
        subtitle="Target the set-asides your certifications unlock — scanner, eligibility, and agency award rates"
        icon={<Award className="w-5 h-5" />}
      />

      {/* Certifications */}
      <div className="card">
        <SectionHeader title="Your Certifications" icon={<ShieldCheck className="w-4 h-4" />} tone="gold" />
        {overviewLoading ? (
          <Skeleton className="h-10" />
        ) : certProfile.length === 0 ? (
          <p className="text-sm text-slate-500">
            No client companies yet — add one under <Link to="/clients" className="text-blue-400 hover:text-blue-300">Clients</Link> and
            set its certifications to power eligibility matching.
          </p>
        ) : (
          <div className="stagger space-y-3">
            {certProfile.map((c) => (
              <div key={c.clientCompanyId} className="flex flex-wrap items-center gap-3">
                <span className="text-sm font-medium text-slate-200">{c.name}</span>
                <div className="flex gap-1.5 flex-wrap">
                  <CertChip label="SDVOSB" active={c.certifications.sdvosb} />
                  <CertChip label="WOSB" active={c.certifications.wosb} />
                  <CertChip label="HUBZone" active={c.certifications.hubzone} />
                  <CertChip label="Small Business" active={c.certifications.smallBusiness} />
                </div>
                {(c.expiringSoon ?? []).map((e: any) => (
                  <span key={e.cert} className="flex items-center gap-1 text-[11px] text-yellow-400">
                    <AlertTriangle className="w-3 h-3" />
                    {e.cert} cert expires {new Date(e.expiresAt).toLocaleDateString()}
                  </span>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Landscape */}
      <div className="card">
        <SectionHeader title="Set-Aside Landscape" subtitle="Active opportunities on your board, by set-aside type" icon={<Target className="w-4 h-4" />} tone="gold" />
        {overviewLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-8" />)}</div>
        ) : landscape.length === 0 ? (
          <p className="text-sm text-slate-500">No active opportunities yet — run a SAM.gov sync from Opportunities.</p>
        ) : (
          <div className="stagger space-y-2.5 overflow-x-auto">
            {landscape.map((row) => (
              <div key={row.setAsideType} className="flex items-center gap-3 min-w-[36rem]">
                <span className="w-40 text-xs text-slate-300 font-medium truncate">
                  {TYPE_LABELS[row.setAsideType] ?? row.setAsideType}
                </span>
                <div className="flex-1 progress-track" style={{ height: 8 }}>
                  <div
                    className="h-full rounded-full bg-amber-400/70 bar-grow"
                    style={{ width: `${Math.max(3, Math.round((row.count / maxCount) * 100))}%` }}
                  />
                </div>
                <span className="w-10 text-right text-xs text-slate-400 tabular-nums">{row.count}</span>
                <span className="w-20 text-right text-[11px] text-slate-500 tabular-nums">
                  avg {Math.round((row.avgProbability ?? 0) * 100)}% win
                </span>
                <span className="w-48 text-[11px] text-emerald-400 truncate">
                  {row.eligibleClients?.length ? `✓ ${row.eligibleClients.join(', ')}` : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Scanner */}
      <div className="card">
        <div className="flex items-start justify-between flex-wrap gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Scanner</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>Set-aside opportunities ranked by win probability</p>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setTypeFilter(undefined)}
              className={`chip transition-colors ${
                !typeFilter ? 'chip-gold' : 'hover:text-slate-200'
              }`}
            >
              All
            </button>
            {knownTypes.map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`chip transition-colors ${
                  typeFilter === t ? 'chip-gold' : 'hover:text-slate-200'
                }`}
              >
                {TYPE_LABELS[t] ?? t}
              </button>
            ))}
          </div>
        </div>

        {scannerLoading ? (
          <div>
            <span className="sr-only">Scanning…</span>
            <SkeletonRows rows={5} cols={6} />
          </div>
        ) : scanner.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No open set-aside opportunities match this filter.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {['Opportunity', 'Agency', 'Set-Aside', 'Deadline', 'Win %', 'Eligibility'].map((h) => (
                    <th key={h} className={h === 'Win %' ? 'text-right' : undefined}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scanner.map((opp) => (
                  <tr key={opp.id}>
                    <td className="max-w-md">
                      <Link to={`/opportunities/${opp.id}`} className="text-slate-200 hover:text-amber-400 font-medium line-clamp-1">
                        {opp.title}
                      </Link>
                    </td>
                    <td className="text-slate-400 text-xs whitespace-nowrap max-w-[180px] truncate">{opp.agency}</td>
                    <td className="text-xs text-slate-300 whitespace-nowrap">{TYPE_LABELS[opp.setAsideType] ?? opp.setAsideType}</td>
                    <td className="text-xs text-slate-400 whitespace-nowrap tabular-nums">
                      {opp.responseDeadline ? new Date(opp.responseDeadline).toLocaleDateString() : '—'}
                    </td>
                    <td className="text-xs font-semibold text-amber-400 text-right tabular-nums">
                      {Math.round((opp.probabilityScore ?? 0) * 100)}%
                    </td>
                    <td>
                      <EligibilityBadge anyEligible={opp.anyEligible} verdicts={opp.eligibility ?? []} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Agency rates */}
      <div className="card">
        <h2 className="text-sm font-semibold mb-1" style={{ color: 'var(--text)' }}>Agency Set-Aside Award Rates</h2>
        <p className="text-xs mb-4" style={{ color: 'var(--text-faint)' }}>
          Share of each agency's contracts (3-year USAspending window) awarded to small businesses and SDVOSBs — your busiest agencies first
        </p>
        {ratesLoading ? (
          <div>
            <span className="sr-only">Pulling USAspending data…</span>
            <SkeletonRows rows={4} cols={3} />
          </div>
        ) : rates.length === 0 ? (
          <p className="text-sm text-slate-500 py-2">No agencies on your board yet — sync opportunities first.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  {['Agency', 'Small Business', 'SDVOSB'].map((h) => (
                    <th key={h} className={h === 'Agency' ? undefined : 'text-right'}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.agency}>
                    <td className="text-slate-300 text-xs max-w-[280px] truncate">{r.agency}</td>
                    <td className="text-xs font-semibold text-emerald-400 text-right tabular-nums">{pct(r.smallBizRate)}</td>
                    <td className="text-xs font-semibold text-amber-400 text-right tabular-nums">{pct(r.sdvosbRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[10px] text-slate-600 mt-3 flex items-center gap-1">
          <ExternalLink className="w-3 h-3" /> Source: USAspending award counts, cached 24h
        </p>
      </div>
    </div>
  )
}

export default function SetAsideIntelligencePage() {
  return (
    <AddonGate addon="setaside_intel">
      <SetAsideBody />
    </AddonGate>
  )
}

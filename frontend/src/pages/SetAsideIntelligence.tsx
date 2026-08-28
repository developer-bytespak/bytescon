import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { setAsideApi } from '../services/api'
import { AddonGate } from '../components/AddonGate'
import {
  Award, ShieldCheck, AlertTriangle, RefreshCw, ExternalLink, Target,
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
      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
        active
          ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
          : 'bg-white/[0.03] text-slate-600 border-white/10'
      }`}
    >
      {label}
    </span>
  )
}

function EligibilityBadge({ anyEligible, verdicts }: { anyEligible: boolean; verdicts: Array<{ verdict: string }> }) {
  if (anyEligible) {
    return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">Eligible</span>
  }
  if (verdicts.some((v) => v.verdict === 'UNKNOWN' || v.verdict === 'OPEN')) {
    return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-yellow-500/15 text-yellow-400 border border-yellow-500/30">Check</span>
  }
  return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-500/15 text-red-400 border border-red-500/30">Not eligible</span>
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
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
          <Award className="w-6 h-6 text-amber-400" />
          Set-Aside Intelligence
        </h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Target the set-asides your certifications unlock — scanner, eligibility, and agency award rates
        </p>
      </div>

      {/* Certifications */}
      <div className="rounded-xl p-6"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <h2 className="text-base font-bold text-slate-200 flex items-center gap-2 mb-4">
          <ShieldCheck className="w-4 h-4 text-amber-400" /> Your Certifications
        </h2>
        {overviewLoading ? (
          <div className="h-10 rounded bg-white/5 animate-pulse" />
        ) : certProfile.length === 0 ? (
          <p className="text-sm text-slate-500">
            No client companies yet — add one under <Link to="/clients" className="text-amber-400 hover:text-amber-300">Clients</Link> and
            set its certifications to power eligibility matching.
          </p>
        ) : (
          <div className="space-y-3">
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
      <div className="rounded-xl p-6"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <h2 className="text-base font-bold text-slate-200 flex items-center gap-2 mb-1">
          <Target className="w-4 h-4 text-amber-400" /> Set-Aside Landscape
        </h2>
        <p className="text-xs text-slate-500 mb-4">Active opportunities on your board, by set-aside type</p>
        {overviewLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-8 rounded bg-white/5 animate-pulse" />)}</div>
        ) : landscape.length === 0 ? (
          <p className="text-sm text-slate-500">No active opportunities yet — run a SAM.gov sync from Opportunities.</p>
        ) : (
          <div className="space-y-2.5">
            {landscape.map((row) => (
              <div key={row.setAsideType} className="flex items-center gap-3">
                <span className="w-40 text-xs text-slate-300 font-medium truncate">
                  {TYPE_LABELS[row.setAsideType] ?? row.setAsideType}
                </span>
                <div className="flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-amber-400/70"
                    style={{ width: `${Math.max(3, Math.round((row.count / maxCount) * 100))}%` }}
                  />
                </div>
                <span className="w-10 text-right text-xs text-slate-400">{row.count}</span>
                <span className="w-20 text-right text-[11px] text-slate-500">
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
      <div className="rounded-xl p-6"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
          <div>
            <h2 className="text-base font-bold text-slate-200">Scanner</h2>
            <p className="text-xs text-slate-500">Set-aside opportunities ranked by win probability</p>
          </div>
          <div className="flex gap-1.5 flex-wrap">
            <button
              onClick={() => setTypeFilter(undefined)}
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all ${
                !typeFilter ? 'bg-amber-500 text-black border-amber-500' : 'text-slate-400 border-white/10 hover:text-slate-200'
              }`}
            >
              All
            </button>
            {knownTypes.map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 rounded-full text-[11px] font-semibold border transition-all ${
                  typeFilter === t ? 'bg-amber-500 text-black border-amber-500' : 'text-slate-400 border-white/10 hover:text-slate-200'
                }`}
              >
                {TYPE_LABELS[t] ?? t}
              </button>
            ))}
          </div>
        </div>

        {scannerLoading ? (
          <div className="flex items-center gap-2 py-6 text-slate-600 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" /> Scanning…
          </div>
        ) : scanner.length === 0 ? (
          <p className="text-sm text-slate-500 py-4">No open set-aside opportunities match this filter.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Opportunity', 'Agency', 'Set-Aside', 'Deadline', 'Win %', 'Eligibility'].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scanner.map((opp) => (
                  <tr key={opp.id} className="hover:bg-white/[0.02] transition-colors" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td className="px-3 py-2.5 max-w-md">
                      <Link to={`/opportunities/${opp.id}`} className="text-slate-200 hover:text-amber-400 font-medium line-clamp-1">
                        {opp.title}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs whitespace-nowrap max-w-[180px] truncate">{opp.agency}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-300 whitespace-nowrap">{TYPE_LABELS[opp.setAsideType] ?? opp.setAsideType}</td>
                    <td className="px-3 py-2.5 text-xs text-slate-400 whitespace-nowrap">
                      {opp.responseDeadline ? new Date(opp.responseDeadline).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-amber-400">
                      {Math.round((opp.probabilityScore ?? 0) * 100)}%
                    </td>
                    <td className="px-3 py-2.5">
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
      <div className="rounded-xl p-6"
        style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)' }}>
        <h2 className="text-base font-bold text-slate-200 mb-1">Agency Set-Aside Award Rates</h2>
        <p className="text-xs text-slate-500 mb-4">
          Share of each agency's contracts (3-year USAspending window) awarded to small businesses and SDVOSBs — your busiest agencies first
        </p>
        {ratesLoading ? (
          <div className="flex items-center gap-2 py-4 text-slate-600 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" /> Pulling USAspending data…
          </div>
        ) : rates.length === 0 ? (
          <p className="text-sm text-slate-500 py-2">No agencies on your board yet — sync opportunities first.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
                  {['Agency', 'Small Business', 'SDVOSB'].map((h) => (
                    <th key={h} className="text-left px-3 py-2 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr key={r.agency} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td className="px-3 py-2.5 text-slate-300 text-xs max-w-[280px] truncate">{r.agency}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-emerald-400">{pct(r.smallBizRate)}</td>
                    <td className="px-3 py-2.5 text-xs font-semibold text-amber-400">{pct(r.sdvosbRate)}</td>
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

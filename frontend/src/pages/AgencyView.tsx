import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Building2, ChevronRight, Copy, ExternalLink, GitBranch, Loader, Mail, RefreshCw, Send, Target, Trash2, X } from 'lucide-react'
import { agencyApi, clientsApi } from '../services/api'
import { PageHeader } from '../components/ui'
import { RecipientSidePanel } from '../components/RecipientSidePanel'

type SortKey = 'totalDollars' | 'awardCount' | 'subSpendRatio' | 'naicsCoverage'

interface AgencyListItem {
  agencyToptierCode: string
  agencyToptierName: string | null
  totalAwardDollars: number
  awardCount: number
  openOppCount: number
  openSubCount: number
}

interface PrimeRow {
  recipientUei: string
  recipientName: string | null
  totalDollars: number
  awardCount: number
  totalSubAmount: number
  smallBizSubAmount: number
  subSpendRatio: number
  smallBizSubSpendRate: number
  naicsCoverage: number
  topNaics: string[]
}

interface PrimesEnvelope {
  primes: PrimeRow[]
  threshold: number
  diagnostics: {
    primesWithUei: number
    topPrimeDollars: number
    awardsWithNullUei: number
  }
}

// Step-down thresholds for the "lower threshold" button. Each lowers by ~3x
// so the operator can quickly find a level that surfaces something.
const THRESHOLD_STEPS = [100_000_000, 25_000_000, 5_000_000, 1_000_000, 0]

interface SubOppRow {
  id: string
  title: string | null
  primeContractor: string | null
  agency: string | null
  naicsCode: string | null
  estimatedValue: number | string | null
  responseDeadline: string | null
  contactEmail: string | null
  sourceUrl: string | null
  scrapedAt: string | null
}

interface RecentSubawardRow {
  id: string
  subRecipientUei: string | null
  subRecipientName: string | null
  subRecipientSize: string | null
  subAmount: number
  subActionDate: string | null
  subNaics: string | null
  primeUei: string | null
  primeRecipientName: string | null
}

interface SubsEnvelope {
  agencyName: string | null
  recentSubawards: RecentSubawardRow[]
  openPostings: SubOppRow[]
  totals: {
    recentSubawards: number
    openPostings: number
  }
}

interface PrimeDetail {
  uei: string
  recipientName: string | null
  totalDollars: number
  awardCount: number
  totalSubAmount: number
  subSpendRatio: number
  smallBizSubSpendRate: number
  topNaics: { naics: string; awardCount: number; dollars: number }[]
  subPartners: {
    uei: string | null
    name: string | null
    size: string | null
    subAwardCount: number
    totalSubAmount: number
  }[]
}

interface ClientLite {
  id: string
  name: string
}

interface TeamingRelationship {
  id: string
  consultingFirmId: string
  clientCompanyId: string
  primeUei: string
  primeName: string | null
  agencyCode: string
  agencyName: string | null
  status: 'IDENTIFIED' | 'CONTACTED' | 'CONVERSATION' | 'MOU' | 'TEAMED' | 'DECLINED'
  fitScoreAtSave: number | null
  notes: string | null
  lastOutreachAt: string | null
  createdAt: string
  updatedAt: string
  clientCompany?: { id: string; name: string }
}

const STATUS_ORDER: TeamingRelationship['status'][] = [
  'IDENTIFIED', 'CONTACTED', 'CONVERSATION', 'MOU', 'TEAMED', 'DECLINED',
]
const STATUS_COLOR: Record<TeamingRelationship['status'], string> = {
  IDENTIFIED:   'bg-gray-800 text-gray-300 border-gray-700',
  CONTACTED:    'bg-sky-950/60 text-sky-300 border-sky-800',
  CONVERSATION: 'bg-amber-950/60 text-amber-300 border-amber-800',
  MOU:          'bg-purple-950/60 text-purple-300 border-purple-800',
  TEAMED:       'bg-emerald-950/60 text-emerald-300 border-emerald-800',
  DECLINED:     'bg-rose-950/40 text-rose-400 border-rose-900',
}

interface OutreachDraft {
  subject: string
  body: string
  suggestedContactRole: string
  tokensConsumed: number
  fitScore: number
  fitConfidence: number
}

interface TeamingFitResult {
  score: number
  confidence: number
  breakdown: Record<string, {
    raw: number
    weight: number
    weighted: number
    confidence: number
    reasoning: string
  }>
  reasons: string[]
}

const COMPONENT_LABEL: Record<string, string> = {
  naicsOverlap: 'NAICS Overlap',
  setAsideFit: 'Set-Aside Fit',
  geographic: 'Geographic',
  primeTeamingActivity: 'Teaming Activity',
  capabilityGapFill: 'Capability Gap Fill',
}

const COMPONENT_COLOR: Record<string, string> = {
  naicsOverlap: 'bg-amber-500',
  setAsideFit: 'bg-emerald-500',
  geographic: 'bg-sky-500',
  primeTeamingActivity: 'bg-purple-500',
  capabilityGapFill: 'bg-rose-500',
}

function formatBigDollar(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toLocaleString()}`
}

function formatPct(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '—'
  return `${(ratio * 100).toFixed(1)}%`
}

// GB-105 Agency View v2 — gated behind VITE_AGENCY_VIEW_V2_ENABLED.
// Prod default OFF; enabled last in the staged rollout (Section F).
const AGENCY_VIEW_V2_ENABLED =
  (import.meta as any).env?.VITE_AGENCY_VIEW_V2_ENABLED === 'true'

interface ClassificationStat {
  code: string
  count: number
  dollars: number
  dollarShare: number
}
interface AgencyProfileData {
  agencyCode: string
  agencyName: string | null
  window: { windowYears: number; fyStart: number | null; fyEnd: number | null }
  spendActivity: {
    totalDollars: number
    totalAwards: number
    byFiscalYear: { fiscalYear: number; dollars: number; awards: number }[]
  }
  topClassifications: { topNaics: ClassificationStat[]; topPsc: ClassificationStat[] }
  setAsideUtilization: { setAsideType: string; count: number; dollars: number; dollarShare: number }[]
  recurringPatterns: { naics: string; yearsActive: number; awards: number; dollars: number; hasRecompete: boolean }[]
}

// Drill-down target: the existing opportunities list reads agency/naicsCode
// from the URL (useSearchParams) and shows each opportunity's match score in
// context. PSC and set-aside rows drill by agency only — live opportunities
// carry no PSC field and use a different set-aside taxonomy than the historical
// award data, so a precise filter there would dead-end.
function oppDrillHref(agencyName: string | null, naicsCode?: string): string {
  const p = new URLSearchParams()
  if (agencyName) p.set('agency', agencyName)
  if (naicsCode) p.set('naicsCode', naicsCode)
  const qs = p.toString()
  return qs ? `/opportunities?${qs}` : '/opportunities'
}

function ClassPanel({ title, rows, hrefFor, emptyLabel }: {
  title: string
  rows: ClassificationStat[]
  hrefFor: (code: string) => string
  emptyLabel: string
}) {
  return (
    <div className="bg-gray-950/40 border border-gray-800 rounded-lg p-3">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-gray-600">{emptyLabel}</p>
      ) : (
        <div className="space-y-1">
          {rows.map((row) => (
            <Link
              key={row.code}
              to={hrefFor(row.code)}
              className="flex items-center gap-2 text-xs px-2 py-1 rounded hover:bg-gray-800/70 transition-colors"
            >
              <span className="font-mono text-gray-300 w-16 shrink-0">{row.code}</span>
              <div className="flex-1 bg-gray-800 rounded h-2 overflow-hidden">
                <div className="bg-amber-500/60 h-full" style={{ width: `${Math.min(100, row.dollarShare * 100)}%` }} />
              </div>
              <span className="w-12 shrink-0 text-right text-gray-500">{formatPct(row.dollarShare)}</span>
              <span className="w-14 shrink-0 text-right text-gray-400">{formatBigDollar(row.dollars)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function AgencyProfileSection({ agencyCode, agencyName }: { agencyCode: string; agencyName: string | null }) {
  const [windowYears, setWindowYears] = useState(3)
  const profileQ = useQuery({
    queryKey: ['agency', 'profile', agencyCode, windowYears],
    queryFn: () =>
      agencyApi.profile(agencyCode, windowYears) as Promise<{ success: boolean; data: AgencyProfileData }>,
    enabled: !!agencyCode,
  })
  const profile = profileQ.data?.data
  const fyMax = useMemo(
    () => Math.max(1, ...((profile?.spendActivity.byFiscalYear ?? []).map((x) => x.dollars))),
    [profile],
  )

  return (
    <div className="mb-4 bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
          <Target className="w-4 h-4 text-amber-400" />
          Agency Profile
          {profile?.window.fyStart && (
            <span className="text-[11px] font-normal text-gray-500">
              FY{profile.window.fyStart}–FY{profile.window.fyEnd}
            </span>
          )}
        </h2>
        <select
          value={windowYears}
          onChange={(e) => setWindowYears(Number(e.target.value))}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300 outline-none"
        >
          <option value={1}>1 FY</option>
          <option value={3}>3 FY</option>
          <option value={5}>5 FY</option>
        </select>
      </div>

      {profileQ.isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
          <Loader className="w-4 h-4 animate-spin" /> Loading profile…
        </div>
      )}
      {profileQ.isError && <div className="text-sm text-red-400 py-4">Failed to load agency profile.</div>}

      {profile && !profileQ.isLoading && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard label="Obligated $" value={formatBigDollar(profile.spendActivity.totalDollars)} />
            <KpiCard label="Awards" value={profile.spendActivity.totalAwards.toLocaleString()} />
            <KpiCard
              label="Set-Aside Types"
              value={profile.setAsideUtilization.filter((s) => s.setAsideType !== 'NONE').length.toString()}
            />
            <KpiCard label="Recurring NAICS" value={profile.recurringPatterns.length.toString()} />
          </div>

          {profile.spendActivity.byFiscalYear.length > 0 && (
            <div className="flex items-end gap-2 h-20">
              {profile.spendActivity.byFiscalYear.map((fy) => {
                const h = Math.max(4, Math.round((fy.dollars / fyMax) * 64))
                return (
                  <div key={fy.fiscalYear} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full bg-amber-500/70 rounded-t"
                      style={{ height: `${h}px` }}
                      title={formatBigDollar(fy.dollars)}
                    />
                    <span className="text-[10px] text-gray-500">FY{String(fy.fiscalYear).slice(-2)}</span>
                  </div>
                )
              })}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ClassPanel
              title="Top NAICS"
              rows={profile.topClassifications.topNaics}
              hrefFor={(code) => oppDrillHref(agencyName, code)}
              emptyLabel="No NAICS data in window."
            />
            <ClassPanel
              title="Top PSC"
              rows={profile.topClassifications.topPsc}
              hrefFor={() => oppDrillHref(agencyName)}
              emptyLabel="No PSC data in window."
            />
          </div>

          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">Set-Aside Utilization</h3>
            {profile.setAsideUtilization.length === 0 ? (
              <p className="text-xs text-gray-600">No award data in window.</p>
            ) : (
              <div className="space-y-1.5">
                {profile.setAsideUtilization.map((s) => (
                  <div key={s.setAsideType} className="flex items-center gap-2 text-xs">
                    <span className="w-24 shrink-0 font-mono text-gray-400">{s.setAsideType}</span>
                    <div className="flex-1 bg-gray-800 rounded h-3 overflow-hidden">
                      <div className="bg-emerald-500/70 h-full" style={{ width: `${Math.min(100, s.dollarShare * 100)}%` }} />
                    </div>
                    <span className="w-16 shrink-0 text-right text-gray-300">{formatPct(s.dollarShare)}</span>
                    <span className="w-16 shrink-0 text-right text-gray-500">{formatBigDollar(s.dollars)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <GitBranch className="w-3.5 h-3.5" /> Recurring / Forecastable NAICS
            </h3>
            {profile.recurringPatterns.length === 0 ? (
              <p className="text-xs text-gray-600">No NAICS recurred across multiple fiscal years in this window.</p>
            ) : (
              <div className="space-y-1">
                {profile.recurringPatterns.map((r) => (
                  <Link
                    key={r.naics}
                    to={oppDrillHref(agencyName, r.naics)}
                    className="flex items-center gap-2 text-xs px-2 py-1.5 rounded hover:bg-gray-800/70 transition-colors"
                  >
                    <span className="font-mono text-gray-300">{r.naics}</span>
                    <span className="text-gray-500">{r.yearsActive} FYs · {r.awards} awards</span>
                    {r.hasRecompete && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded border border-sky-800 bg-sky-950/60 text-sky-300">recompete</span>
                    )}
                    <span className="ml-auto text-gray-400">{formatBigDollar(r.dollars)}</span>
                    <ChevronRight className="w-3.5 h-3.5 text-gray-600" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AgencyView() {
  const [selectedAgencyCode, setSelectedAgencyCode] = useState<string | null>(null)
  const [selectedPrimeUei, setSelectedPrimeUei] = useState<string | null>(null)
  // Side-panel preview for sub-recipients clicked in the Recent Subawards
  // table — previously this was a full-page Link to /recipient/:uei which
  // forced an unwanted navigation. The deep-link to the full page is
  // retained inside the panel for the cases when an operator wants it.
  const [selectedSubRecipientUei, setSelectedSubRecipientUei] = useState<string | null>(null)
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null)
  const [primeSort, setPrimeSort] = useState<SortKey>('totalDollars')
  const [outreachOpen, setOutreachOpen] = useState(false)
  const [outreachDraft, setOutreachDraft] = useState<OutreachDraft | null>(null)
  const [outreachError, setOutreachError] = useState<string | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const [primeThreshold, setPrimeThreshold] = useState<number>(100_000_000)
  const queryClient = useQueryClient()

  // Reset threshold to default when the user switches agencies (we
  // explicitly DON'T want a Peace-Corps-tuned $1M threshold sticking
  // when they jump to DoD next).
  useEffect(() => {
    setPrimeThreshold(100_000_000)
  }, [selectedAgencyCode])

  const clientsQ = useQuery({
    queryKey: ['agency', 'clients'],
    queryFn: () => clientsApi.list() as Promise<{ success: boolean; data: ClientLite[] | { items: ClientLite[] } }>,
  })
  const clients: ClientLite[] = useMemo(() => {
    const raw = clientsQ.data?.data
    if (Array.isArray(raw)) return raw
    if (raw && Array.isArray((raw as any).items)) return (raw as any).items
    return []
  }, [clientsQ.data])

  const agenciesQ = useQuery({
    queryKey: ['agency', 'list'],
    queryFn: () => agencyApi.list() as Promise<{ success: boolean; data: AgencyListItem[] }>,
  })

  const agencies: AgencyListItem[] = agenciesQ.data?.data ?? []

  // Auto-select the most relevant agency once data lands.
  useEffect(() => {
    if (!selectedAgencyCode && agencies.length > 0) {
      setSelectedAgencyCode(agencies[0].agencyToptierCode)
    }
  }, [agencies, selectedAgencyCode])

  const selectedAgency = useMemo(
    () => agencies.find((a) => a.agencyToptierCode === selectedAgencyCode) ?? null,
    [agencies, selectedAgencyCode],
  )

  const primesQ = useQuery({
    queryKey: ['agency', 'primes', selectedAgencyCode, primeSort, primeThreshold],
    queryFn: () =>
      agencyApi.primes(selectedAgencyCode!, primeSort, primeThreshold) as Promise<{
        success: boolean
        data: PrimesEnvelope
      }>,
    enabled: !!selectedAgencyCode,
  })

  const subsQ = useQuery({
    queryKey: ['agency', 'subs', selectedAgencyCode],
    queryFn: () =>
      agencyApi.subs(selectedAgencyCode!) as Promise<{
        success: boolean
        data: SubsEnvelope
      }>,
    enabled: !!selectedAgencyCode,
  })

  const primeDetailQ = useQuery({
    queryKey: ['agency', 'prime-detail', selectedAgencyCode, selectedPrimeUei],
    queryFn: () =>
      agencyApi.primeDetail(selectedAgencyCode!, selectedPrimeUei!) as Promise<{
        success: boolean
        data: PrimeDetail
      }>,
    enabled: !!selectedAgencyCode && !!selectedPrimeUei,
  })

  const fitQ = useQuery({
    queryKey: ['agency', 'fit', selectedAgencyCode, selectedPrimeUei, selectedClientId],
    queryFn: () =>
      agencyApi.fit(selectedAgencyCode!, selectedPrimeUei!, selectedClientId!) as Promise<{
        success: boolean
        data: TeamingFitResult
      }>,
    enabled: !!selectedAgencyCode && !!selectedPrimeUei && !!selectedClientId,
  })

  const relationshipsQ = useQuery({
    queryKey: ['agency', 'relationships'],
    queryFn: () =>
      agencyApi.listRelationships() as Promise<{ success: boolean; data: TeamingRelationship[] }>,
  })
  const relationships = relationshipsQ.data?.data ?? []
  const invalidateRelationships = () =>
    queryClient.invalidateQueries({ queryKey: ['agency', 'relationships'] })

  const saveRelationshipMutation = useMutation({
    mutationFn: (fitScore: number | null) =>
      agencyApi.saveRelationship({
        clientId: selectedClientId!,
        primeUei: selectedPrimeUei!,
        agencyCode: selectedAgencyCode!,
        fitScoreAtSave: fitScore,
      }),
    onSuccess: () => invalidateRelationships(),
  })

  const updateRelationshipMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: TeamingRelationship['status'] }) =>
      agencyApi.updateRelationship(id, { status }),
    onSuccess: () => invalidateRelationships(),
  })

  const deleteRelationshipMutation = useMutation({
    mutationFn: (id: string) => agencyApi.deleteRelationship(id),
    onSuccess: () => invalidateRelationships(),
  })

  const draftMutation = useMutation({
    mutationFn: () =>
      agencyApi.draftOutreach(selectedClientId!, selectedPrimeUei!, selectedAgencyCode!) as Promise<{
        success: boolean
        data: OutreachDraft
        error?: string
        code?: string
      }>,
    onSuccess: (resp) => {
      if (resp.success && resp.data) {
        setOutreachDraft(resp.data)
        setOutreachError(null)
        setOutreachOpen(true)
        // The backend auto-bumps lastOutreachAt + status for any saved row,
        // so refresh the list so the operator sees the change.
        invalidateRelationships()
      }
    },
    onError: (err: any) => {
      const code = err?.response?.data?.code
      const message = err?.response?.data?.error
      if (code === 'INSUFFICIENT_TOKENS') {
        const bal = err?.response?.data?.data?.balance ?? 0
        setOutreachError(`Out of proposal tokens (balance ${bal}). Top up in Billing to draft outreach.`)
      } else {
        setOutreachError(message || 'Draft failed. No token was charged.')
      }
      setOutreachOpen(true)
      setOutreachDraft(null)
    },
  })

  const primesEnv: PrimesEnvelope | null = primesQ.data?.data ?? null
  const primes: PrimeRow[] = primesEnv?.primes ?? []
  const primesDiag = primesEnv?.diagnostics ?? null
  const subsEnv: SubsEnvelope | null = subsQ.data?.data ?? null
  const recentSubawards: RecentSubawardRow[] = subsEnv?.recentSubawards ?? []
  const openPostings: SubOppRow[] = subsEnv?.openPostings ?? []

  // Find the next-lower threshold step (the user is currently at primeThreshold).
  const nextLowerThreshold = THRESHOLD_STEPS.find((t) => t < primeThreshold) ?? null

  return (
    <div>
      <PageHeader
        title="Agency View"
        subtitle="Top primes (>$100M) and open sub opportunities, by federal agency"
      >
        <button
          onClick={() => setShowSaved(true)}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-gray-300 hover:bg-gray-700 transition-colors"
          title="View saved teaming relationships"
        >
          <Bookmark className="w-3.5 h-3.5" />
          Saved
          {relationships.length > 0 && (
            <span className="ml-1 text-[10px] font-mono text-amber-400">{relationships.length}</span>
          )}
        </button>
      </PageHeader>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {agenciesQ.isLoading && (
          <span className="text-xs text-gray-500 flex items-center gap-1.5">
            <Loader className="w-3 h-3 animate-spin" /> Loading agencies…
          </span>
        )}
        {agenciesQ.isError && (
          <span className="text-xs text-red-400">Failed to load agencies.</span>
        )}
        {agencies.slice(0, 16).map((a) => {
          const active = a.agencyToptierCode === selectedAgencyCode
          const signal = a.openOppCount + a.openSubCount
          return (
            <button
              key={a.agencyToptierCode}
              onClick={() => {
                setSelectedAgencyCode(a.agencyToptierCode)
                setSelectedPrimeUei(null)
              }}
              className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                active
                  ? 'bg-amber-900/40 border-amber-700 text-amber-200'
                  : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
              }`}
              title={`${a.awardCount.toLocaleString()} awards · ${formatBigDollar(a.totalAwardDollars)}`}
            >
              {a.agencyToptierName || a.agencyToptierCode}
              {signal > 0 && (
                <span className="ml-1.5 text-[10px] text-amber-300 font-mono">·{signal}</span>
              )}
            </button>
          )
        })}
      </div>

      {selectedAgency && (
        <div className="mb-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          <KpiCard label="Total Award $" value={formatBigDollar(selectedAgency.totalAwardDollars)} />
          <KpiCard label="Awards (24mo)" value={selectedAgency.awardCount.toLocaleString()} />
          <KpiCard label="Your Open Opps" value={selectedAgency.openOppCount.toString()} />
          <KpiCard label="Your Open Subs" value={selectedAgency.openSubCount.toString()} />
        </div>
      )}

      {AGENCY_VIEW_V2_ENABLED && selectedAgency && (
        <AgencyProfileSection
          agencyCode={selectedAgency.agencyToptierCode}
          agencyName={selectedAgency.agencyToptierName}
        />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* PRIMES PANEL */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <Building2 className="w-4 h-4 text-amber-400" />
              Top Primes (≥{formatBigDollar(primeThreshold)})
            </h2>
            <select
              value={primeSort}
              onChange={(e) => setPrimeSort(e.target.value as SortKey)}
              className="text-xs bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300"
            >
              <option value="totalDollars">Sort: Total $</option>
              <option value="awardCount">Sort: Award Count</option>
              <option value="subSpendRatio">Sort: Sub-Spend Ratio</option>
              <option value="naicsCoverage">Sort: NAICS Coverage</option>
            </select>
          </div>

          {primesQ.isLoading ? (
            <CenteredSpinner />
          ) : primes.length === 0 ? (
            <ThresholdEmptyState
              diagnostics={primesDiag}
              currentThreshold={primeThreshold}
              nextLowerThreshold={nextLowerThreshold}
              onLower={() => nextLowerThreshold !== null && setPrimeThreshold(nextLowerThreshold)}
            />
          ) : (
            <div className="overflow-x-auto -mx-4">
              <table className="w-full text-xs">
                <thead className="text-[10px] uppercase text-gray-500 tracking-wide">
                  <tr>
                    <th className="px-4 py-2 text-left">Prime</th>
                    <th className="px-4 py-2 text-right">Total $</th>
                    <th className="px-4 py-2 text-right">Awds</th>
                    <th className="px-4 py-2 text-right">Sub %</th>
                    <th className="px-4 py-2 text-right">SB Sub %</th>
                    <th className="px-4 py-2 text-right">NAICS</th>
                  </tr>
                </thead>
                <tbody>
                  {primes.map((p) => {
                    const active = p.recipientUei === selectedPrimeUei
                    return (
                      <tr
                        key={p.recipientUei}
                        onClick={() => setSelectedPrimeUei(p.recipientUei)}
                        className={`border-t border-gray-800 cursor-pointer transition-colors ${
                          active ? 'bg-amber-900/10' : 'hover:bg-gray-800/50'
                        }`}
                      >
                        <td className="px-4 py-2 text-gray-200 truncate max-w-[14rem]">
                          {p.recipientName || p.recipientUei}
                          <div className="text-[10px] text-gray-500 font-mono">{p.recipientUei}</div>
                        </td>
                        <td className="px-4 py-2 text-right text-gray-300">{formatBigDollar(p.totalDollars)}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{p.awardCount}</td>
                        <td className="px-4 py-2 text-right text-gray-300">{formatPct(p.subSpendRatio)}</td>
                        <td className="px-4 py-2 text-right text-gray-300">{formatPct(p.smallBizSubSpendRate)}</td>
                        <td className="px-4 py-2 text-right text-gray-400">{p.naicsCoverage}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* SUBS PANEL */}
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
              <GitBranch className="w-4 h-4 text-amber-400" />
              Recent Sub-Award Activity (&lt;$100M)
            </h2>
            {subsQ.isFetching && <RefreshCw className="w-3.5 h-3.5 animate-spin text-gray-500" />}
          </div>

          {subsQ.isLoading ? (
            <CenteredSpinner />
          ) : recentSubawards.length === 0 && openPostings.length === 0 ? (
            <EmptyMsg msg="No sub-award activity at this agency in the staged data window." />
          ) : (
            <div className="space-y-4">
              {recentSubawards.length > 0 && (
                <div className="overflow-y-auto max-h-[24rem] -mx-4">
                  <table className="w-full text-xs">
                    <thead className="text-[10px] uppercase text-gray-500 tracking-wide sticky top-0 bg-gray-900">
                      <tr>
                        <th className="px-4 py-2 text-left">Sub-Recipient</th>
                        <th className="px-4 py-2 text-left">Prime</th>
                        <th className="px-4 py-2 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentSubawards.map((s) => {
                        const recipientLabel = s.subRecipientName || s.subRecipientUei || '(unknown)'
                        return (
                          <tr key={s.id} className="border-t border-gray-800 hover:bg-gray-800/40">
                            <td className="px-4 py-2 text-gray-200 truncate max-w-[14rem]">
                              <div className="flex items-center gap-1.5">
                                {s.subRecipientUei ? (
                                  <button
                                    type="button"
                                    onClick={() => setSelectedSubRecipientUei(s.subRecipientUei!)}
                                    className="truncate text-left hover:text-amber-300 transition-colors cursor-pointer"
                                    title="Open recipient profile preview"
                                  >
                                    {recipientLabel}
                                  </button>
                                ) : (
                                  <span className="truncate">{recipientLabel}</span>
                                )}
                                {s.subRecipientSize === 'small' && (
                                  <span className="text-[9px] px-1 py-0.5 rounded bg-emerald-950/60 border border-emerald-800 text-emerald-300 font-mono">
                                    SB
                                  </span>
                                )}
                              </div>
                              {s.subNaics && (
                                <div className="text-[10px] font-mono text-gray-500">NAICS {s.subNaics}</div>
                              )}
                            </td>
                            <td className="px-4 py-2 text-gray-400 truncate max-w-[10rem] text-xs">
                              {s.primeUei ? (
                                <button
                                  type="button"
                                  onClick={() => setSelectedPrimeUei(s.primeUei!)}
                                  className="truncate text-left hover:text-amber-300 transition-colors cursor-pointer"
                                  title="Open prime drill-down"
                                >
                                  {s.primeRecipientName || '—'}
                                </button>
                              ) : (
                                <span>{s.primeRecipientName || '—'}</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-right text-gray-300">
                              {formatBigDollar(s.subAmount)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {openPostings.length > 0 && (
                <div className="pt-3 border-t border-gray-800">
                  <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-2 px-4">
                    Open SubNet postings · {openPostings.length}
                  </p>
                  <div className="overflow-y-auto max-h-[14rem] -mx-4">
                    <table className="w-full text-xs">
                      <tbody>
                        {openPostings.map((s) => (
                          <tr key={s.id} className="border-t border-gray-800 hover:bg-gray-800/40">
                            <td className="px-4 py-2 text-gray-200 truncate max-w-[16rem]">
                              {s.title || '(untitled)'}
                              {s.naicsCode && (
                                <span className="ml-2 text-[10px] font-mono text-gray-500">NAICS {s.naicsCode}</span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-gray-400 truncate max-w-[10rem] text-xs">
                              {s.primeContractor || '—'}
                            </td>
                            <td className="px-4 py-2 text-right text-gray-300">
                              {s.estimatedValue != null ? `$${Number(s.estimatedValue).toLocaleString()}` : 'TBD'}
                            </td>
                            <td className="px-4 py-2 text-right">
                              {s.sourceUrl && (
                                <a
                                  href={s.sourceUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-amber-400 hover:text-amber-300"
                                  title="Open source"
                                >
                                  <ExternalLink className="w-3.5 h-3.5 inline" />
                                </a>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* PRIME DRILL-DOWN SIDE PANEL */}
      {selectedPrimeUei && (
        <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-gray-950 border-l border-gray-800 shadow-2xl z-50 overflow-y-auto">
          <div className="p-5 border-b border-gray-800 flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Prime Drill-Down</p>
              <h3 className="text-base font-semibold text-gray-100">
                {primeDetailQ.data?.data?.recipientName || selectedPrimeUei}
              </h3>
              <p className="text-[10px] font-mono text-gray-500">{selectedPrimeUei}</p>
            </div>
            <button
              onClick={() => setSelectedPrimeUei(null)}
              className="text-gray-500 hover:text-gray-200"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {primeDetailQ.isLoading ? (
            <CenteredSpinner />
          ) : primeDetailQ.data?.data ? (
            <>
              <TeamingFitPanel
                clients={clients}
                selectedClientId={selectedClientId}
                onSelectClient={setSelectedClientId}
                fit={fitQ.data?.data ?? null}
                loading={fitQ.isLoading}
                onDraftOutreach={() => draftMutation.mutate()}
                drafting={draftMutation.isPending}
                onSave={(fitScore) => saveRelationshipMutation.mutate(fitScore)}
                saving={saveRelationshipMutation.isPending}
                alreadySaved={relationships.some(
                  (r) =>
                    r.clientCompanyId === selectedClientId &&
                    r.primeUei === selectedPrimeUei &&
                    r.agencyCode === selectedAgencyCode,
                )}
              />
              <PrimeDrillContent detail={primeDetailQ.data.data} />
            </>
          ) : (
            <EmptyMsg msg="No detail available." />
          )}
        </div>
      )}

      {/* SUB-RECIPIENT SIDE PANEL — opened from Recent Subawards rows. */}
      {selectedSubRecipientUei && (
        <RecipientSidePanel
          uei={selectedSubRecipientUei}
          onClose={() => setSelectedSubRecipientUei(null)}
        />
      )}

      {outreachOpen && (
        <OutreachModal
          draft={outreachDraft}
          error={outreachError}
          onClose={() => {
            setOutreachOpen(false)
            setOutreachError(null)
          }}
        />
      )}

      {showSaved && (
        <SavedRelationshipsPanel
          relationships={relationships}
          loading={relationshipsQ.isLoading}
          onClose={() => setShowSaved(false)}
          onStatusChange={(id, status) => updateRelationshipMutation.mutate({ id, status })}
          onDelete={(id) => deleteRelationshipMutation.mutate(id)}
          onOpen={(r) => {
            setSelectedAgencyCode(r.agencyCode)
            setSelectedPrimeUei(r.primeUei)
            setSelectedClientId(r.clientCompanyId)
            setShowSaved(false)
          }}
        />
      )}
    </div>
  )
}

// ----------- subcomponents -----------

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-3">
      <p className="text-[10px] uppercase tracking-widest text-gray-500">{label}</p>
      <p className="text-xl font-bold text-gray-100 mt-1">{value}</p>
    </div>
  )
}

function CenteredSpinner() {
  return (
    <div className="flex items-center justify-center py-8 text-gray-500">
      <Loader className="w-5 h-5 animate-spin" />
    </div>
  )
}

function EmptyMsg({ msg }: { msg: string }) {
  return <div className="py-8 text-center text-sm text-gray-500">{msg}</div>
}

function ThresholdEmptyState({
  diagnostics,
  currentThreshold,
  nextLowerThreshold,
  onLower,
}: {
  diagnostics: PrimesEnvelope['diagnostics'] | null
  currentThreshold: number
  nextLowerThreshold: number | null
  onLower: () => void
}) {
  if (!diagnostics) {
    return <EmptyMsg msg={`No primes ≥ ${formatBigDollar(currentThreshold)} at this agency.`} />
  }
  const { primesWithUei, topPrimeDollars, awardsWithNullUei } = diagnostics

  const reasons: string[] = []
  if (primesWithUei === 0 && awardsWithNullUei > 0) {
    reasons.push(`${awardsWithNullUei} award(s) at this agency lack recipient UEI data (not yet enriched).`)
  } else if (topPrimeDollars < currentThreshold) {
    reasons.push(`Top prime at this agency is ${formatBigDollar(topPrimeDollars)} — below the ${formatBigDollar(currentThreshold)} threshold.`)
  }

  return (
    <div className="py-6 text-center text-sm text-gray-500 space-y-3">
      <p>No primes ≥ {formatBigDollar(currentThreshold)} at this agency.</p>
      {reasons.map((r, i) => (
        <p key={i} className="text-xs text-gray-600">{r}</p>
      ))}
      {nextLowerThreshold !== null && primesWithUei > 0 && (
        <button
          onClick={onLower}
          className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-900/30 border border-amber-800 text-amber-300 hover:bg-amber-900/50 transition-colors"
        >
          Lower threshold to {formatBigDollar(nextLowerThreshold) || '$0'}
        </button>
      )}
    </div>
  )
}

function TeamingFitPanel({
  clients,
  selectedClientId,
  onSelectClient,
  fit,
  loading,
  onDraftOutreach,
  drafting,
  onSave,
  saving,
  alreadySaved,
}: {
  clients: ClientLite[]
  selectedClientId: string | null
  onSelectClient: (id: string) => void
  fit: TeamingFitResult | null
  loading: boolean
  onDraftOutreach: () => void
  drafting: boolean
  onSave: (fitScore: number | null) => void
  saving: boolean
  alreadySaved: boolean
}) {
  if (clients.length === 0) {
    return (
      <div className="p-5 border-b border-gray-800">
        <p className="text-xs text-gray-500">
          Add a client under <span className="text-gray-300">Clients</span> to see a teaming-fit score.
        </p>
      </div>
    )
  }

  return (
    <div className="p-5 border-b border-gray-800 space-y-3">
      <div className="flex items-center gap-2">
        <Target className="w-4 h-4 text-amber-400" />
        <span className="text-xs uppercase tracking-widest text-gray-500">Teaming Fit</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {clients.map((c) => {
          const active = c.id === selectedClientId
          return (
            <button
              key={c.id}
              onClick={() => onSelectClient(c.id)}
              className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                active
                  ? 'bg-amber-900/40 border-amber-700 text-amber-200'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:text-gray-200'
              }`}
            >
              {c.name}
            </button>
          )
        })}
      </div>

      {!selectedClientId ? (
        <p className="text-[11px] text-gray-600 italic">Pick a client to score this prime.</p>
      ) : loading || !fit ? (
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <Loader className="w-3 h-3 animate-spin" /> Scoring…
        </div>
      ) : (
        <>
          <FitScoreContent fit={fit} />
          <div className="grid grid-cols-2 gap-2 mt-2">
            <button
              onClick={() => onSave(fit.score)}
              disabled={saving || alreadySaved}
              className={`flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border transition-colors disabled:cursor-default ${
                alreadySaved
                  ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                  : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700 disabled:opacity-50'
              }`}
              title={alreadySaved ? 'Already saved' : 'Save to your teaming list'}
            >
              <Bookmark className="w-3 h-3" />
              {saving ? 'Saving…' : alreadySaved ? 'Saved' : 'Save'}
            </button>
            <button
              onClick={onDraftOutreach}
              disabled={drafting}
              className="flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 text-gray-900 hover:from-amber-400 hover:to-amber-500 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {drafting ? (
                <>
                  <Loader className="w-3 h-3 animate-spin" />
                  Drafting…
                </>
              ) : (
                <>
                  <Send className="w-3 h-3" />
                  Draft (1 tk)
                </>
              )}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function SavedRelationshipsPanel({
  relationships,
  loading,
  onClose,
  onStatusChange,
  onDelete,
  onOpen,
}: {
  relationships: TeamingRelationship[]
  loading: boolean
  onClose: () => void
  onStatusChange: (id: string, status: TeamingRelationship['status']) => void
  onDelete: (id: string) => void
  onOpen: (r: TeamingRelationship) => void
}) {
  // Group by status, in the canonical funnel order.
  const grouped = STATUS_ORDER.map((s) => ({
    status: s,
    items: relationships.filter((r) => r.status === s),
  })).filter((g) => g.items.length > 0)

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-gray-950 border-l border-gray-800 shadow-2xl z-[55] overflow-y-auto">
      <div className="p-5 border-b border-gray-800 flex items-center justify-between sticky top-0 bg-gray-950 z-10">
        <div className="flex items-center gap-2">
          <Bookmark className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-gray-100">Saved Teaming Relationships</h3>
          <span className="text-[10px] font-mono text-gray-500 ml-1">{relationships.length}</span>
        </div>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-200">
          <X className="w-5 h-5" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-8 text-gray-500">
          <Loader className="w-5 h-5 animate-spin" />
        </div>
      ) : relationships.length === 0 ? (
        <div className="p-8 text-center text-sm text-gray-500">
          No saved relationships yet. Score a prime in the drill-down and click <span className="text-gray-300">Save</span>.
        </div>
      ) : (
        <div className="p-4 space-y-5">
          {grouped.map((g) => (
            <section key={g.status}>
              <h4 className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">
                {g.status} <span className="text-gray-600">· {g.items.length}</span>
              </h4>
              <div className="space-y-2">
                {g.items.map((r) => (
                  <RelationshipCard
                    key={r.id}
                    r={r}
                    onStatusChange={onStatusChange}
                    onDelete={onDelete}
                    onOpen={onOpen}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function RelationshipCard({
  r,
  onStatusChange,
  onDelete,
  onOpen,
}: {
  r: TeamingRelationship
  onStatusChange: (id: string, status: TeamingRelationship['status']) => void
  onDelete: (id: string) => void
  onOpen: (r: TeamingRelationship) => void
}) {
  return (
    <div
      className={`border rounded-lg p-3 text-xs ${STATUS_COLOR[r.status]} hover:brightness-110 cursor-pointer transition-all`}
      onClick={() => onOpen(r)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-gray-100 truncate">
            {r.primeName || r.primeUei}
          </p>
          <p className="text-[10px] text-gray-400 truncate">
            {r.clientCompany?.name || r.clientCompanyId} → {r.agencyName || r.agencyCode}
          </p>
          {r.fitScoreAtSave !== null && (
            <p className="text-[10px] text-gray-500 mt-0.5 font-mono">
              fit {r.fitScoreAtSave.toFixed(0)}/100
              {r.lastOutreachAt && (
                <span className="ml-2">· last outreach {new Date(r.lastOutreachAt).toLocaleDateString()}</span>
              )}
            </p>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation()
            if (window.confirm('Delete this saved relationship? This cannot be undone.')) {
              onDelete(r.id)
            }
          }}
          className="text-gray-500 hover:text-rose-400 p-1"
          title="Delete"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1">
        {STATUS_ORDER.map((s) => {
          const active = s === r.status
          return (
            <button
              key={s}
              onClick={(e) => {
                e.stopPropagation()
                if (!active) onStatusChange(r.id, s)
              }}
              className={`text-[9px] px-1.5 py-0.5 rounded border transition-colors ${
                active
                  ? STATUS_COLOR[s]
                  : 'bg-gray-900/60 border-gray-800 text-gray-500 hover:text-gray-300'
              }`}
            >
              {s}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function OutreachModal({
  draft,
  error,
  onClose,
}: {
  draft: OutreachDraft | null
  error: string | null
  onClose: () => void
}) {
  const mailtoHref = draft
    ? `mailto:?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`
    : '#'

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text)
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-gray-950 border border-gray-800 rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-gray-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-amber-400" />
            <h3 className="text-sm font-semibold text-gray-100">Teaming Intro Draft</h3>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-200">
            <X className="w-5 h-5" />
          </button>
        </div>

        {error ? (
          <div className="p-5">
            <p className="text-sm text-rose-300">{error}</p>
          </div>
        ) : draft ? (
          <div className="p-5 space-y-4">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">
                Suggested contact role
              </p>
              <p className="text-sm text-amber-300">{draft.suggestedContactRole}</p>
            </div>

            <div>
              <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1">Subject</p>
              <div className="flex items-center gap-2">
                <p className="text-sm text-gray-100 flex-1 break-words">{draft.subject}</p>
                <button
                  onClick={() => copy(draft.subject)}
                  className="text-gray-500 hover:text-gray-200"
                  title="Copy subject"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <p className="text-[10px] uppercase tracking-widest text-gray-500">Body</p>
                <button
                  onClick={() => copy(draft.body)}
                  className="text-[11px] text-gray-400 hover:text-gray-200 flex items-center gap-1"
                >
                  <Copy className="w-3 h-3" />
                  Copy
                </button>
              </div>
              <pre className="text-xs text-gray-200 whitespace-pre-wrap bg-gray-900 border border-gray-800 rounded-lg p-3 leading-relaxed max-h-72 overflow-y-auto font-sans">
                {draft.body}
              </pre>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <a
                href={mailtoHref}
                className="flex-1 flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2 rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 text-gray-900 hover:from-amber-400 hover:to-amber-500 transition-colors"
              >
                <Mail className="w-3.5 h-3.5" />
                Open in mail client
              </a>
              <span className="text-[10px] text-gray-500">
                1 token used · fit {draft.fitScore.toFixed(0)}/100
              </span>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FitScoreContent({ fit }: { fit: TeamingFitResult }) {
  const confidenceLabel =
    fit.confidence >= 0.7 ? 'high confidence' : fit.confidence >= 0.4 ? 'medium' : 'low — limited data'
  const confColor =
    fit.confidence >= 0.7 ? 'text-emerald-400' : fit.confidence >= 0.4 ? 'text-amber-400' : 'text-rose-400'

  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3">
        <div className="text-3xl font-bold text-gray-100">{fit.score.toFixed(1)}</div>
        <div className="text-xs text-gray-500">/ 100</div>
        <div className={`text-[11px] ml-auto ${confColor}`}>{confidenceLabel}</div>
      </div>

      {/* Stacked horizontal bar */}
      <div className="h-2 w-full bg-gray-800 rounded overflow-hidden flex">
        {Object.entries(fit.breakdown).map(([key, c]) => (
          <div
            key={key}
            className={COMPONENT_COLOR[key] ?? 'bg-gray-600'}
            style={{ width: `${c.weighted}%` }}
            title={`${COMPONENT_LABEL[key] ?? key}: ${c.weighted.toFixed(1)} of ${c.weight}`}
          />
        ))}
      </div>

      {/* Component legend */}
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        {Object.entries(fit.breakdown).map(([key, c]) => (
          <div key={key} className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-gray-400">
              <span className={`inline-block w-2 h-2 rounded-sm ${COMPONENT_COLOR[key] ?? 'bg-gray-600'}`} />
              {COMPONENT_LABEL[key] ?? key}
            </span>
            <span className="text-gray-300 font-mono">
              {c.weighted.toFixed(1)} / {c.weight}
            </span>
          </div>
        ))}
      </div>

      {fit.reasons.length > 0 && (
        <div className="pt-2 border-t border-gray-800">
          <p className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Why this prime?</p>
          <ul className="space-y-1">
            {fit.reasons.map((r, i) => (
              <li key={i} className="text-xs text-gray-300 leading-snug">
                {i + 1}. {r}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function PrimeDrillContent({ detail }: { detail: PrimeDetail }) {
  return (
    <div className="p-5 space-y-5 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <KpiCard label="Total Awarded" value={formatBigDollar(detail.totalDollars)} />
        <KpiCard label="Awards" value={detail.awardCount.toLocaleString()} />
        <KpiCard label="Sub-Spend" value={formatPct(detail.subSpendRatio)} />
        <KpiCard label="To Small Biz" value={formatPct(detail.smallBizSubSpendRate)} />
      </div>

      <section>
        <h4 className="text-xs uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3" />
          Top NAICS at this agency
        </h4>
        {detail.topNaics.length === 0 ? (
          <p className="text-xs text-gray-500">No NAICS data captured.</p>
        ) : (
          <ul className="space-y-1">
            {detail.topNaics.map((n) => (
              <li key={n.naics} className="flex items-center justify-between text-xs">
                <span className="font-mono text-gray-300">{n.naics}</span>
                <span className="text-gray-500">
                  {n.awardCount} awd · {formatBigDollar(n.dollars)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h4 className="text-xs uppercase tracking-wide text-gray-400 mb-2 flex items-center gap-1.5">
          <ChevronRight className="w-3 h-3" />
          Sub partners (top 20 by sub-spend)
        </h4>
        {detail.subPartners.length === 0 ? (
          <p className="text-xs text-gray-500">
            No subaward history captured for this prime at this agency.
          </p>
        ) : (
          <div className="space-y-1.5">
            {detail.subPartners.map((p, i) => (
              <div
                key={p.uei || `unknown-${i}`}
                className="flex items-center justify-between text-xs border-b border-gray-800 pb-1"
              >
                <div className="truncate max-w-[14rem]">
                  <div className="text-gray-200 truncate">{p.name || p.uei || '(unknown)'}</div>
                  <div className="text-[10px] text-gray-500 font-mono">{p.uei || '—'}</div>
                </div>
                <div className="text-right">
                  <div className="text-gray-300">{formatBigDollar(p.totalSubAmount)}</div>
                  <div className="text-[10px] text-gray-500">
                    {p.subAwardCount} sub · {p.size || 'size?'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <p className="text-[10px] text-gray-600 italic pt-2 border-t border-gray-800">
        Teaming fit scoring + LLM intro-draft assistance ship in the next Agency phase.
      </p>
    </div>
  )
}

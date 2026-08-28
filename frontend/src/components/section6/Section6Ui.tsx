// =============================================================
// §6 — Shared presentation primitives for the four pillars.
//
// These carry the honesty rules into the UI: a forecast is always badged as a
// forecast, an unavailable interval renders its exact backend label, absent
// data is shown as absent (never as zero), and every stated rate is shown with
// its denominator and basis wording exactly as the backend supplied it.
// =============================================================
import { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, HelpCircle, Info, XCircle } from 'lucide-react'
import type { ConfidenceState, EligibilityState, ExpiryState } from '../../services/section6Api'

// ---- Generic badge -------------------------------------------------

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand'

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: 'bg-gray-800 border-gray-700 text-gray-300',
  info: 'bg-blue-950/40 border-blue-800 text-blue-300',
  success: 'bg-green-950/40 border-green-800 text-green-300',
  warning: 'bg-yellow-950/40 border-yellow-800 text-yellow-300',
  danger: 'bg-red-950/40 border-red-800 text-red-300',
  brand: 'bg-amber-950/40 border-amber-800 text-amber-300',
}

export function Badge({ tone = 'neutral', children, title }: { tone?: BadgeTone; children: ReactNode; title?: string }) {
  return (
    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${TONE_CLASSES[tone]}`} title={title}>
      {children}
    </span>
  )
}

// ---- Record-kind badge ---------------------------------------------

/**
 * A forecast is never allowed to look like a released solicitation, so this
 * badge is rendered on every forecast row and detail view.
 */
export function RecordKindBadge({ kind }: { kind: 'FORECAST' | 'SOLICITATION' | 'PRE_SOLICITATION' }) {
  if (kind === 'FORECAST') {
    return <Badge tone="warning" title="An agency planning estimate published before any solicitation exists. Dates frequently change.">FORECAST</Badge>
  }
  if (kind === 'PRE_SOLICITATION') {
    return <Badge tone="info" title="A pre-solicitation notice, not a released solicitation.">PRE-SOLICITATION</Badge>
  }
  return <Badge tone="neutral">SOLICITATION</Badge>
}

// ---- Source + freshness --------------------------------------------

export function SourceBadge({ source }: { source: string }) {
  const label = source.replace(/_/g, ' ')
  const tone: BadgeTone = source === 'MANUAL' ? 'neutral' : source === 'DEMO' ? 'warning' : 'info'
  return <Badge tone={tone}>{label}</Badge>
}

export function FreshnessBadge({ freshness, dataQuality }: {
  freshness: { isStale: boolean; ageHours: number | null; label: string }
  dataQuality?: string
}) {
  const tone: BadgeTone = dataQuality === 'ERROR' ? 'danger' : freshness.isStale ? 'warning' : 'success'
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone={tone} title={freshness.label}>{freshness.label}</Badge>
      {dataQuality && dataQuality !== 'OK' && (
        <Badge tone={dataQuality === 'ERROR' ? 'danger' : 'warning'} title="Data-quality state reported by the last sync.">
          {dataQuality}
        </Badge>
      )}
    </span>
  )
}

// ---- Eligibility ----------------------------------------------------

const ELIGIBILITY_META: Record<EligibilityState, { label: string; tone: BadgeTone }> = {
  ELIGIBLE: { label: 'Eligible', tone: 'success' },
  POSSIBLY_ELIGIBLE: { label: 'Possibly eligible', tone: 'warning' },
  NOT_ELIGIBLE: { label: 'Not eligible', tone: 'danger' },
  EXPIRING_BEFORE_DEADLINE: { label: 'Expires before deadline', tone: 'warning' },
  INSUFFICIENT_DATA: { label: 'Insufficient data', tone: 'neutral' },
}

export function EligibilityBadge({ state, reason }: { state: EligibilityState; reason?: string }) {
  const meta = ELIGIBILITY_META[state] ?? ELIGIBILITY_META.INSUFFICIENT_DATA
  return <Badge tone={meta.tone} title={reason}>{meta.label}</Badge>
}

// ---- Expiry ---------------------------------------------------------

const EXPIRY_TONE: Record<ExpiryState, BadgeTone> = {
  VALID: 'success',
  EXPIRES_BEFORE_SUBMISSION: 'danger',
  EXPIRES_BEFORE_AWARD: 'danger',
  EXPIRES_DURING_BASE_PERIOD: 'warning',
  EXPIRES_DURING_OPTION_PERIOD: 'warning',
  EXPIRED: 'danger',
  NO_EXPIRY: 'neutral',
  INSUFFICIENT_DATA: 'neutral',
}

export function ExpiryBadge({ state, label, message }: { state: ExpiryState; label: string; message?: string }) {
  return <Badge tone={EXPIRY_TONE[state] ?? 'neutral'} title={message}>{label}</Badge>
}

// ---- Confidence interval --------------------------------------------

const CONFIDENCE_TONE: Record<ConfidenceState, BadgeTone> = {
  HIGH: 'success',
  MEDIUM: 'info',
  LOW: 'warning',
  INSUFFICIENT_DATA: 'neutral',
}

/**
 * Renders a probability interval, or the backend's exact unavailable label when
 * the data cannot support one. Statistical certainty is never fabricated here.
 */
export function ConfidenceInterval({ interval }: {
  interval: {
    lower: number | null
    point: number
    upper: number | null
    available: boolean
    confidence: ConfidenceState
    reason: string
    unavailableLabel: string | null
  }
}) {
  if (!interval.available) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
        <div className="flex items-center gap-2 mb-1">
          <HelpCircle className="w-4 h-4 text-gray-500" />
          <span className="text-xs font-mono text-gray-400">{interval.unavailableLabel}</span>
        </div>
        <p className="text-[11px] text-gray-500">{interval.reason}</p>
      </div>
    )
  }
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-gray-400">Likely range</span>
        <Badge tone={CONFIDENCE_TONE[interval.confidence]}>{interval.confidence} confidence</Badge>
      </div>
      <div className="text-lg font-bold text-gray-100 font-mono">
        {Math.round((interval.lower ?? 0) * 100)}% – {Math.round((interval.upper ?? 0) * 100)}%
      </div>
      <p className="text-[11px] text-gray-500 mt-1">{interval.reason}</p>
    </div>
  )
}

// ---- Dimension score (absent-aware) ----------------------------------

/**
 * Renders a match dimension. A null score means the dimension could not be
 * assessed — it is shown as "not assessable", never as 0%.
 */
export function DimensionRow({ label, score, weight, evidence, absentReason }: {
  label: string
  score: number | null
  weight?: number
  evidence?: string
  absentReason?: string
}) {
  const isAbsent = score === null
  return (
    <div className="py-2 border-b border-gray-800 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-gray-300">{label}</span>
        <div className="flex items-center gap-2">
          {weight !== undefined && <span className="text-[9px] text-gray-600 font-mono">w {(weight * 100).toFixed(0)}%</span>}
          {isAbsent ? (
            <Badge tone="neutral" title={absentReason}>Not assessable</Badge>
          ) : (
            <span className="text-xs font-mono text-gray-100">{Math.round(score * 100)}%</span>
          )}
        </div>
      </div>
      {!isAbsent && (
        <div className="mt-1 h-1 bg-gray-800 rounded-full overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.round(score * 100)}%`, background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }} />
        </div>
      )}
      {(evidence || absentReason) && <p className="text-[11px] text-gray-500 mt-1">{absentReason ?? evidence}</p>}
    </div>
  )
}

// ---- Rate with denominator -------------------------------------------

/**
 * A rate is only ever rendered with the exact basis wording the backend chose
 * and the sample size it was computed from. When no rate can be stated, the
 * counts are shown instead.
 */
export function RateWithBasis({ rate, basisLabel, sampleSize, explanation }: {
  rate: number | null
  basisLabel: string
  sampleSize: number
  explanation?: string
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2">
        {rate === null ? (
          <span className="text-sm text-gray-500">No rate — sample too small</span>
        ) : (
          <span className="text-lg font-bold text-gray-100 font-mono">{(rate * 100).toFixed(0)}%</span>
        )}
        <span className="text-[10px] text-gray-500 uppercase tracking-widest">{basisLabel}</span>
      </div>
      <p className="text-[11px] text-gray-500">n = {sampleSize}{explanation ? ` · ${explanation}` : ''}</p>
    </div>
  )
}

// ---- State panels -----------------------------------------------------

export function LoadingPanel({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-gray-500">
      <div className="w-4 h-4 border-2 border-gray-700 border-t-amber-500 rounded-full animate-spin" />
      <span className="text-sm">{label}</span>
    </div>
  )
}

export function EmptyPanel({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="text-center py-10">
      <Info className="w-8 h-8 text-gray-700 mx-auto mb-2" />
      <p className="text-sm text-gray-400">{message}</p>
      {hint && <p className="text-xs text-gray-600 mt-1">{hint}</p>}
    </div>
  )
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="bg-red-950/30 border border-red-800 rounded-xl p-4">
      <div className="flex items-start gap-2">
        <XCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
        <div className="flex-1">
          <p className="text-sm text-red-300">{message}</p>
          {onRetry && (
            <button onClick={onRetry} className="mt-2 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

/** Renders a source failure honestly, without implying the data is current. */
export function SourceErrorPanel({ sourceName, message, lastSuccessfulSync }: {
  sourceName: string
  message: string
  lastSuccessfulSync: string | null
}) {
  return (
    <div className="bg-orange-950/30 border border-orange-800 rounded-xl p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-orange-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-xs text-orange-300 font-medium">{sourceName} is not syncing</p>
          <p className="text-[11px] text-orange-200/80 mt-0.5">{message}</p>
          <p className="text-[11px] text-orange-200/60 mt-1">
            {lastSuccessfulSync
              ? `Showing data from the last successful sync on ${new Date(lastSuccessfulSync).toLocaleString()}. It may be out of date.`
              : 'This source has never synced successfully, so no data from it is shown.'}
          </p>
        </div>
      </div>
    </div>
  )
}

/** Shown when a computation ran but had too little data to be relied on. */
export function PartialDataNotice({ limitations }: { limitations: string[] }) {
  if (limitations.length === 0) return null
  return (
    <div className="bg-yellow-950/25 border border-yellow-800/60 rounded-xl p-3">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-xs text-yellow-300 font-medium">Based on incomplete data</p>
          <ul className="mt-1 space-y-0.5">
            {limitations.map((l) => (
              <li key={l} className="text-[11px] text-yellow-200/80">• {l}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  )
}

export function Disclaimer({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] text-gray-500 leading-relaxed flex items-start gap-1.5">
      <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </p>
  )
}

export function VerifiedMark({ verified, label }: { verified: boolean; label?: string }) {
  return verified ? (
    <span className="inline-flex items-center gap-1 text-[10px] text-green-400">
      <CheckCircle2 className="w-3 h-3" /> {label ?? 'Verified'}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[10px] text-gray-500">
      <HelpCircle className="w-3 h-3" /> {label ?? 'Unverified'}
    </span>
  )
}

// ---- Tabs -------------------------------------------------------------

export function TabBar({ tabs, active, onChange }: {
  tabs: Array<{ key: string; label: string; count?: number }>
  active: string
  onChange: (key: string) => void
}) {
  return (
    <div className="flex gap-1 border-b border-gray-800 overflow-x-auto" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          role="tab"
          aria-selected={active === tab.key}
          onClick={() => onChange(tab.key)}
          className={`px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 transition-colors ${
            active === tab.key ? 'border-amber-500 text-amber-300' : 'border-transparent text-gray-500 hover:text-gray-300'
          }`}
        >
          {tab.label}
          {tab.count !== undefined && <span className="ml-1.5 text-[10px] text-gray-600 font-mono">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(0, 10)
}

export function formatMoney(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'string' ? Number(value) : value
  if (!Number.isFinite(n)) return '—'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${n.toFixed(0)}`
}

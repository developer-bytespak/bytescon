// =============================================================
// §6.1H — Opportunity Discovery.
//
// Six tabs: the §7.2 Opportunity Agent panel, then the §6.1 backend's ingestion
// sources, agency forecasts, re-compete signals, pre-solicitation notices, and
// the capability library. The agent panel renders the backend's brief — it is
// not a second discovery application.
//
// Every panel implements the required states: loading, empty, partial data,
// external-source failure, error, permission and submitting. Coverage notes,
// disclaimers and freshness come from the backend verbatim — this page never
// upgrades a claim the backend did not make.
// =============================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle, Calendar, Database, FileSearch, Layers, RefreshCw, Shield, Target,
} from 'lucide-react'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import {
  Badge, Disclaimer, EligibilityBadge, EmptyPanel, ErrorPanel, FreshnessBadge,
  LoadingPanel, RecordKindBadge, SourceErrorPanel, TabBar, VerifiedMark,
  formatDate, formatMoney,
} from '../components/section6/Section6Ui'
import {
  discoveryApi,
  type AdapterInfo, type FirmCapability, type Forecast,
  type PreSolicitationNotice, type RecompeteSignal, type SourceConfig,
} from '../services/section6Api'
import { OpportunityAgentPanel } from '../components/section7/OpportunityAgentPanel'
import { useTabParam } from '../hooks/useTabParam'

type TabKey = 'sources' | 'forecasts' | 'recompetes' | 'notices' | 'capabilities' | 'agent'

export default function Discovery() {
  // Sources stays the landing tab: §7.2 adds a panel to this page, it does not
  // change where an existing user lands on it.
  const [tab, setTab] = useTabParam(['sources', 'forecasts', 'recompetes', 'notices', 'capabilities', 'agent'] as const, 'sources')
  const [counts, setCounts] = useState<Partial<Record<TabKey, number>>>({})

  const tabs = [
    { key: 'sources', label: 'Sources', count: counts.sources },
    { key: 'forecasts', label: 'Forecasts', count: counts.forecasts },
    { key: 'recompetes', label: 'Re-competes', count: counts.recompetes },
    { key: 'notices', label: 'Pre-solicitation', count: counts.notices },
    { key: 'capabilities', label: 'Capabilities', count: counts.capabilities },
    { key: 'agent', label: 'Agent', count: counts.agent },
  ]

  const report = useCallback((key: TabKey, n: number) => {
    setCounts((prev) => (prev[key] === n ? prev : { ...prev, [key]: n }))
  }, [])

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <PageHeader
        title="Opportunity Discovery"
        subtitle="Multi-source intelligence: ingestion sources, agency forecasts, re-compete signals, pre-solicitation notices and your capability library."
      />
      <TabBar tabs={tabs} active={tab} onChange={(k) => setTab(k as TabKey)} />
      <div className="mt-6">
        {tab === 'sources' && <SourcesTab onCount={(n) => report('sources', n)} />}
        {tab === 'forecasts' && <ForecastsTab onCount={(n) => report('forecasts', n)} />}
        {tab === 'recompetes' && <RecompetesTab onCount={(n) => report('recompetes', n)} />}
        {tab === 'notices' && <NoticesTab onCount={(n) => report('notices', n)} />}
        {tab === 'capabilities' && <CapabilitiesTab onCount={(n) => report('capabilities', n)} />}
        {tab === 'agent' && <OpportunityAgentPanel onCount={(n) => report('agent', n)} />}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// §6.1A — Sources
// -------------------------------------------------------------

/**
 * Adapters whose configure() requires a feed URL. SAM.gov takes a key instead,
 * and USAspending/Grants.gov carry their own endpoint, so none of them appear.
 */
const FEED_URL_ADAPTERS: Record<string, { needsFormat: boolean }> = {
  agency_forecast: { needsFormat: false },
  state_local: { needsFormat: true },
  subcontracting_board: { needsFormat: true },
}

function SourcesTab({ onCount }: { onCount: (n: number) => void }) {
  const { toast } = useToast()
  // Held in a ref so a new inline callback from the parent cannot re-trigger
  // the load effect (which would loop: load → setState → re-render → load).
  const report = useRef(onCount)
  report.current = onCount
  const [adapters, setAdapters] = useState<AdapterInfo[]>([])
  const [sources, setSources] = useState<SourceConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)
  const [adding, setAdding] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [feedUrl, setFeedUrl] = useState('')
  const [feedFormat, setFeedFormat] = useState('JSON')
  const [savingConfig, setSavingConfig] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [a, s] = await Promise.all([discoveryApi.listAdapters(), discoveryApi.listSources()])
      setAdapters(a)
      setSources(s)
      report.current(s.length)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load ingestion sources.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const addSource = async (adapterKey: string) => {
    setAdding(adapterKey)
    try {
      await discoveryApi.createSource({ adapterKey })
      toast('Source added. Configure it, then enable it.', 'success')
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      toast(e?.response?.status === 403 ? 'Only a firm admin can add an ingestion source.' : e?.response?.data?.error || 'Could not add the source.', 'error')
    } finally {
      setAdding(null)
    }
  }

  const runSync = async (source: SourceConfig) => {
    setSyncing(source.id)
    try {
      const result = await discoveryApi.syncSource(source.id)
      toast(result.status === 'SKIPPED'
          ? `${source.displayName} is not configured, so nothing was synced.`
          : `${source.displayName}: ${result.recordsCreated} new, ${result.recordsUpdated} updated.`, result.status === 'FAILED' ? 'error' : 'success')
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      toast(e?.response?.status === 403 ? 'Only a firm admin can run a sync.' : e?.response?.data?.error || 'Sync failed.', 'error')
    } finally {
      setSyncing(null)
    }
  }

  const openConfig = (source: SourceConfig) => {
    setEditingId(source.id)
    setFeedUrl(String(source.configJson?.feedUrl ?? source.baseUrl ?? ''))
    setFeedFormat(String(source.configJson?.format ?? 'JSON'))
  }

  const saveConfig = async (source: SourceConfig) => {
    const url = feedUrl.trim()
    if (!url) return
    setSavingConfig(true)
    try {
      // configJson is replaced wholesale by the API, so merge rather than overwrite
      // — a source may already carry jurisdiction, columnMap or paging settings.
      const config: Record<string, unknown> = { ...source.configJson, feedUrl: url }
      if (FEED_URL_ADAPTERS[source.adapterKey]?.needsFormat) config.format = feedFormat
      await discoveryApi.updateSource(source.id, { config })
      setEditingId(null)
      toast('Feed URL saved. Run Sync now to fetch from it.', 'success')
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { error?: string } } }
      toast(e?.response?.status === 403 ? 'Only a firm admin can configure a source.' : e?.response?.data?.error || 'Could not save the feed URL.', 'error')
    } finally {
      setSavingConfig(false)
    }
  }

  const toggle = async (source: SourceConfig) => {
    try {
      await discoveryApi.updateSource(source.id, { isEnabled: !source.isEnabled })
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number } }
      toast(e?.response?.status === 403 ? 'Only a firm admin can change a source.' : 'Could not update the source.', 'error')
    }
  }

  if (loading) return <LoadingPanel label="Loading ingestion sources…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />

  const configured = new Set(sources.map((s) => s.adapterKey))
  const available = adapters.filter((a) => !configured.has(a.key))

  return (
    <div className="space-y-6">
      {sources.length === 0 ? (
        <EmptyPanel
          message="No ingestion sources are configured yet."
          hint="Add one below. Every source is optional — the platform runs without any of them."
        />
      ) : (
        <div className="space-y-3">
          {sources.map((source) => (
            <div key={source.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div className="flex-1 min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Database className="w-4 h-4 text-gray-500" />
                    <span className="text-sm font-medium text-gray-100">{source.displayName}</span>
                    <Badge tone="neutral">{source.category.replace(/_/g, ' ')}</Badge>
                    {source.isEnabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="neutral">Disabled</Badge>}
                    <Badge
                      tone={source.verification === 'LIVE_VERIFIED' ? 'success' : source.verification === 'CONTRACT_ONLY' ? 'info' : 'neutral'}
                      title={
                        source.verification === 'LIVE_VERIFIED'
                          ? 'A real sync against the live provider has succeeded.'
                          : 'No live provider run has happened yet. This is not presented as a live connection.'
                      }
                    >
                      {source.verification.replace(/_/g, ' ')}
                    </Badge>
                  </div>
                  {source.coverageNote && <p className="text-[11px] text-gray-500 mt-1.5">{source.coverageNote}</p>}
                  <div className="mt-2">
                    <FreshnessBadge freshness={source.freshness} dataQuality={source.dataQuality} />
                  </div>
                  {source.authEnvKey && (
                    <p className="text-[11px] text-gray-600 mt-1 font-mono">
                      Optional credential env var: {source.authEnvKey}
                    </p>
                  )}
                  {Boolean(FEED_URL_ADAPTERS[source.adapterKey] && source.configJson?.feedUrl) && (
                    <p className="text-[11px] text-gray-600 mt-1 font-mono break-all">
                      Feed: {String(source.configJson.feedUrl)}
                    </p>
                  )}
                  {/* A source can be enabled and still unusable. Say WHY, using the
                      adapter's own reason, rather than leaving the badge unexplained.
                      Suppressed when the source is genuinely failing — the error
                      panel below already carries that message. */}
                  {source.verification === 'NOT_CONFIGURED' && source.lastFailureMessage && source.consecutiveFailures === 0 && (
                    <p className="text-[11px] text-amber-400/80 mt-1.5">{source.lastFailureMessage}</p>
                  )}
                </div>
                <div className="flex gap-2 items-start">
                  {FEED_URL_ADAPTERS[source.adapterKey] && (
                    <button
                      onClick={() => (editingId === source.id ? setEditingId(null) : openConfig(source))}
                      className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
                    >
                      {editingId === source.id ? 'Cancel' : source.configJson?.feedUrl ? 'Edit feed URL' : 'Set feed URL'}
                    </button>
                  )}
                  <button
                    onClick={() => toggle(source)}
                    className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors"
                  >
                    {source.isEnabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => runSync(source)}
                    disabled={syncing === source.id}
                    className="text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-50 inline-flex items-center gap-1.5"
                    style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}
                  >
                    <RefreshCw className={`w-3 h-3 ${syncing === source.id ? 'animate-spin' : ''}`} />
                    {syncing === source.id ? 'Syncing…' : 'Sync now'}
                  </button>
                </div>
              </div>

              {editingId === source.id && (
                <div className="mt-3 pt-3 border-t border-gray-800 space-y-2">
                  <label className="block text-[11px] text-gray-400" htmlFor={`feed-${source.id}`}>
                    Official feed URL — must return JSON or CSV{FEED_URL_ADAPTERS[source.adapterKey]?.needsFormat ? ' (or RSS)' : ''}. A portal
                    page, PDF or spreadsheet cannot be read.
                  </label>
                  <div className="flex gap-2 flex-wrap">
                    <input
                      id={`feed-${source.id}`}
                      value={feedUrl}
                      onChange={(e) => setFeedUrl(e.target.value)}
                      placeholder="https://agency.gov/forecast.json"
                      className="flex-1 min-w-[260px] bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
                    />
                    {FEED_URL_ADAPTERS[source.adapterKey]?.needsFormat && (
                      <select
                        aria-label="Feed format"
                        value={feedFormat}
                        onChange={(e) => setFeedFormat(e.target.value)}
                        className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
                      >
                        <option value="JSON">JSON</option>
                        <option value="RSS">RSS</option>
                      </select>
                    )}
                    <button
                      onClick={() => saveConfig(source)}
                      disabled={savingConfig || !feedUrl.trim()}
                      className="text-xs px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50"
                      style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}
                    >
                      {savingConfig ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              )}

              {source.lastFailureMessage && source.consecutiveFailures > 0 && (
                <div className="mt-3">
                  <SourceErrorPanel
                    sourceName={source.displayName}
                    message={source.lastFailureMessage}
                    lastSuccessfulSync={source.lastSuccessfulSync}
                  />
                </div>
              )}

              {source.lastRun && (
                <div className="mt-3 pt-3 border-t border-gray-800 flex gap-4 flex-wrap text-[11px] text-gray-500">
                  <span>Last run: <span className="font-mono text-gray-400">{source.lastRun.status}</span></span>
                  <span>Fetched {source.lastRun.recordsFetched}</span>
                  <span>Created {source.lastRun.recordsCreated}</span>
                  <span>Updated {source.lastRun.recordsUpdated}</span>
                  {source.lastRun.errorCount > 0 && <span className="text-red-400">Errors {source.lastRun.errorCount}</span>}
                  {source.lastRun.rateLimited && <span className="text-yellow-400">Rate limited</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {available.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Available sources</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {available.map((adapter) => (
              <div key={adapter.key} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-sm font-medium text-gray-100">{adapter.displayName}</span>
                  <Badge tone="neutral">{adapter.category.replace(/_/g, ' ')}</Badge>
                </div>
                <p className="text-[11px] text-gray-500 mb-3">{adapter.coverageNote}</p>
                <button
                  onClick={() => addSource(adapter.key)}
                  disabled={adding === adapter.key}
                  className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50"
                >
                  {adding === adapter.key ? 'Adding…' : 'Add source'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// §6.1B — Forecasts
// -------------------------------------------------------------

function ForecastsTab({ onCount }: { onCount: (n: number) => void }) {
  const report = useRef(onCount)
  report.current = onCount
  const { toast } = useToast()
  const [forecasts, setForecasts] = useState<Forecast[]>([])
  const [disclaimer, setDisclaimer] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [agency, setAgency] = useState('')
  const [naics, setNaics] = useState('')
  const [linking, setLinking] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await discoveryApi.listForecasts({
        ...(agency ? { agency } : {}),
        ...(naics ? { naicsCode: naics } : {}),
        pageSize: 50,
      })
      setForecasts(result.items)
      setDisclaimer(result.disclaimer)
      report.current(result.total)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load forecasts.')
    } finally {
      setLoading(false)
    }
  }, [agency, naics])

  useEffect(() => { void load() }, [load])

  const runLinking = async () => {
    setLinking(true)
    try {
      const result = await discoveryApi.linkForecasts()
      toast(`${result.autoLinked} auto-linked, ${result.flaggedForReview} need review.`, 'success')
      await load()
    } catch {
      toast('Only a firm admin can run forecast linking.', 'error')
    } finally {
      setLinking(false)
    }
  }

  const decide = async (forecast: Forecast, decision: 'CONFIRM' | 'REJECT') => {
    try {
      await discoveryApi.decideForecastLink(forecast.id, { decision })
      toast(decision === 'CONFIRM' ? 'Link confirmed.' : 'Link rejected.', 'success')
      await load()
    } catch {
      toast('Only a firm admin can decide a forecast link.', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap items-end">
        <div>
          <label htmlFor="forecast-agency" className="block text-[11px] text-gray-500 mb-1">Agency</label>
          <input id="forecast-agency" value={agency} onChange={(e) => setAgency(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" placeholder="Any agency" />
        </div>
        <div>
          <label htmlFor="forecast-naics" className="block text-[11px] text-gray-500 mb-1">NAICS</label>
          <input id="forecast-naics" value={naics} onChange={(e) => setNaics(e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" placeholder="e.g. 5415" />
        </div>
        <button onClick={runLinking} disabled={linking}
          className="text-xs px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50">
          {linking ? 'Linking…' : 'Find matching solicitations'}
        </button>
      </div>

      {disclaimer && <Disclaimer>{disclaimer}</Disclaimer>}

      {loading ? <LoadingPanel label="Loading forecasts…" />
        : error ? <ErrorPanel message={error} onRetry={load} />
        : forecasts.length === 0 ? (
          <EmptyPanel
            message="No agency forecasts have been ingested."
            hint="Configure an Agency Procurement Forecast source with an official agency feed URL to start collecting them."
          />
        ) : (
          <div className="space-y-3">
            {forecasts.map((forecast) => (
              <div key={forecast.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-[260px]">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <RecordKindBadge kind="FORECAST" />
                      {forecast.setAsideExpectation && <Badge tone="info">{forecast.setAsideExpectation}</Badge>}
                      {forecast.dataQuality !== 'OK' && <Badge tone="warning">{forecast.dataQuality}</Badge>}
                    </div>
                    <h3 className="text-sm font-medium text-gray-100">{forecast.title}</h3>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {forecast.agency}{forecast.subAgency ? ` · ${forecast.subAgency}` : ''}
                    </p>
                    <div className="flex gap-4 flex-wrap mt-2 text-[11px] text-gray-500">
                      <span>Anticipated solicitation: <span className="font-mono text-gray-400">{formatDate(forecast.anticipatedSolicitationDate)}</span></span>
                      <span>Anticipated award: <span className="font-mono text-gray-400">{formatDate(forecast.anticipatedAwardDate)}</span></span>
                      {forecast.naicsCode && <span>NAICS {forecast.naicsCode}</span>}
                      <span>Value {formatMoney(forecast.estimatedValue)}</span>
                      <span>Completeness {(forecast.completeness * 100).toFixed(0)}%</span>
                    </div>
                    {forecast.incumbentName && (
                      <p className="text-[11px] text-gray-500 mt-1">
                        Incumbent (as published by the source): <span className="text-gray-300">{forecast.incumbentName}</span>
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    {forecast.linkState === 'AUTO_LINKED' && forecast.linkedOpportunity && (
                      <Link to={`/opportunities/${forecast.linkedOpportunity.id}`} className="text-xs text-amber-400 hover:text-amber-300">
                        Linked solicitation →
                      </Link>
                    )}
                    {forecast.linkState === 'HUMAN_CONFIRMED' && <Badge tone="success">Link confirmed</Badge>}
                    {forecast.linkState === 'HUMAN_REJECTED' && <Badge tone="neutral">Link rejected</Badge>}
                    {forecast.linkState === 'UNLINKED' && <Badge tone="neutral">No solicitation yet</Badge>}
                  </div>
                </div>

                {forecast.linkState === 'REVIEW_REQUIRED' && (
                  <div className="mt-3 bg-yellow-950/25 border border-yellow-800/60 rounded-lg p-3">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-yellow-400 mt-0.5 flex-shrink-0" />
                      <div className="flex-1">
                        <p className="text-xs text-yellow-300 font-medium">A possible matching solicitation needs your review</p>
                        <p className="text-[11px] text-yellow-200/80 mt-0.5">{forecast.linkEvidence}</p>
                        {forecast.linkedOpportunity && (
                          <Link to={`/opportunities/${forecast.linkedOpportunity.id}`} className="text-[11px] text-amber-400 hover:text-amber-300 mt-1 inline-block">
                            {forecast.linkedOpportunity.title} →
                          </Link>
                        )}
                        <div className="flex gap-2 mt-2">
                          <button onClick={() => decide(forecast, 'CONFIRM')}
                            className="text-xs px-3 py-1 rounded bg-green-900/40 hover:bg-green-900/60 text-green-300 border border-green-700 transition-colors">
                            Confirm link
                          </button>
                          <button onClick={() => decide(forecast, 'REJECT')}
                            className="text-xs px-3 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
                            Not a match
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

// -------------------------------------------------------------
// §6.1C — Re-competes
// -------------------------------------------------------------

function RecompetesTab({ onCount }: { onCount: (n: number) => void }) {
  const report = useRef(onCount)
  report.current = onCount
  const { toast } = useToast()
  const [signals, setSignals] = useState<RecompeteSignal[]>([])
  const [disclaimer, setDisclaimer] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await discoveryApi.listRecompetes()
      setSignals(result.signals)
      setDisclaimer(result.disclaimer)
      report.current(result.signals.length)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load re-compete signals.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const detect = async () => {
    setDetecting(true)
    try {
      const result = await discoveryApi.detectRecompetes()
      toast(`${result.created} new signal(s), ${result.updated} updated.`, 'success')
      await load()
    } catch {
      toast('Only a firm admin can run detection.', 'error')
    } finally {
      setDetecting(false)
    }
  }

  const decide = async (signal: RecompeteSignal, verification: 'VERIFIED' | 'DISMISSED') => {
    const reason = verification === 'DISMISSED' ? window.prompt('Why are you dismissing this signal?') : undefined
    if (verification === 'DISMISSED' && !reason) return
    try {
      await discoveryApi.decideRecompete(signal.id, { verification, ...(reason ? { reason } : {}) })
      toast(verification === 'VERIFIED' ? 'Signal verified.' : 'Signal dismissed.', 'success')
      await load()
    } catch {
      toast('Only a firm admin can change a signal.', 'error')
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <Disclaimer>{disclaimer || 'Re-compete windows are estimates, not announced solicitation dates.'}</Disclaimer>
        <button onClick={detect} disabled={detecting}
          className="text-xs px-3 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors disabled:opacity-50">
          {detecting ? 'Detecting…' : 'Run detection'}
        </button>
      </div>

      {loading ? <LoadingPanel label="Loading re-compete signals…" />
        : error ? <ErrorPanel message={error} onRetry={load} />
        : signals.length === 0 ? (
          <EmptyPanel
            message="No re-compete signals detected."
            hint="Signals are derived from tracked contracts with a period of performance, and from award history. Add contracts or run detection."
          />
        ) : (
          <div className="space-y-3">
            {signals.map((signal) => (
              <div key={signal.id} className={`bg-gray-900 border rounded-xl p-4 ${signal.verification === 'DISMISSED' ? 'border-gray-800 opacity-60' : 'border-gray-800'}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex-1 min-w-[260px]">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Target className="w-4 h-4 text-gray-500" />
                      <span className="text-sm font-medium text-gray-100">{signal.incumbentName ?? 'Unknown incumbent'}</span>
                      <Badge tone={signal.confidence === 'CONFIRMED' ? 'success' : signal.confidence === 'PROBABLE' ? 'info' : 'warning'}>
                        {signal.confidence}
                      </Badge>
                      {signal.verification !== 'UNVERIFIED' && <Badge tone="neutral">{signal.verification}</Badge>}
                    </div>
                    <p className="text-xs text-gray-400">
                      {signal.agency ?? 'Unknown agency'}{signal.contractNumber ? ` · ${signal.contractNumber}` : ''}
                      {signal.naicsCode ? ` · NAICS ${signal.naicsCode}` : ''}
                    </p>
                    <div className="flex gap-4 flex-wrap mt-2 text-[11px] text-gray-500">
                      <span>Estimated window: <span className="font-mono text-gray-400">{formatDate(signal.windowStart)} → {formatDate(signal.windowEnd)}</span></span>
                      <span>Base period ends: <span className="font-mono text-gray-400">{formatDate(signal.popEndDate)}</span></span>
                      <span>Final possible end: <span className="font-mono text-gray-400">{formatDate(signal.finalPossibleEndDate)}</span></span>
                      <span>Options: {signal.optionPeriodsRemaining}/{signal.optionPeriodCount} unresolved</span>
                    </div>
                    {signal.confidenceReason && <p className="text-[11px] text-gray-500 mt-1.5">{signal.confidenceReason}</p>}
                    {signal.dismissedReason && <p className="text-[11px] text-gray-500 mt-1">Dismissed: {signal.dismissedReason}</p>}
                    <p className="text-[10px] text-gray-600 mt-1 font-mono">
                      {signal.detectionMethod} · recalculated {formatDate(signal.lastCalculatedAt)}
                    </p>
                  </div>
                  {signal.verification === 'UNVERIFIED' && (
                    <div className="flex gap-2">
                      <button onClick={() => decide(signal, 'VERIFIED')}
                        className="text-xs px-3 py-1.5 rounded bg-green-900/40 hover:bg-green-900/60 text-green-300 border border-green-700 transition-colors">
                        Verify
                      </button>
                      <button onClick={() => decide(signal, 'DISMISSED')}
                        className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
                        Dismiss
                      </button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  )
}

// -------------------------------------------------------------
// §6.1D — Pre-solicitation notices
// -------------------------------------------------------------

function NoticesTab({ onCount }: { onCount: (n: number) => void }) {
  const report = useRef(onCount)
  report.current = onCount
  const [notices, setNotices] = useState<PreSolicitationNotice[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await discoveryApi.listNotices()
      setNotices(result)
      report.current(result.length)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load pre-solicitation notices.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading pre-solicitation notices…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (notices.length === 0) {
    return (
      <EmptyPanel
        message="No open sources-sought, RFI or other pre-solicitation notices."
        hint="These are classified automatically from the notice type as opportunities are ingested."
      />
    )
  }

  return (
    <div className="space-y-3">
      {notices.map((notice) => (
        <div key={notice.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="flex-1 min-w-[260px]">
              <div className="flex items-center gap-2 mb-1 flex-wrap">
                <RecordKindBadge kind="PRE_SOLICITATION" />
                <Badge tone="brand">{notice.classification.label}</Badge>
                <Badge tone={notice.classification.priority === 'CRITICAL' || notice.classification.priority === 'HIGH' ? 'warning' : 'neutral'}>
                  {notice.classification.priority}
                </Badge>
                {notice.amendmentCount > 0 && <Badge tone="info">{notice.amendmentCount} amendment(s)</Badge>}
              </div>
              <Link to={`/opportunities/${notice.id}`} className="text-sm font-medium text-gray-100 hover:text-amber-300">
                {notice.title}
              </Link>
              <p className="text-xs text-gray-400 mt-0.5">{notice.agency} · NAICS {notice.naicsCode || '—'}</p>
              <div className="flex gap-4 flex-wrap mt-2 text-[11px] text-gray-500">
                <span>Responds by <span className="font-mono text-gray-400">{formatDate(notice.responseDeadline)}</span></span>
                <span>Classified from: {notice.classification.basis === 'NOTICE_TYPE' ? 'the feed’s notice type' : 'the notice title'}</span>
                <span>Last seen {formatDate(notice.sourceLastSeenAt)}</span>
              </div>
              {notice.classification.whyEarlyResponseMayMatter && (
                <p className="text-[11px] text-gray-500 mt-2 leading-relaxed">
                  {notice.classification.whyEarlyResponseMayMatter}
                </p>
              )}
            </div>
            <div className="text-right space-y-1">
              {notice.match ? (
                <>
                  <div className="text-lg font-bold text-gray-100 font-mono">{notice.match.overallScore}%</div>
                  <div className="text-[10px] text-gray-500 uppercase tracking-widest">Capability match</div>
                  <EligibilityBadge state={notice.match.eligibility} reason={notice.match.eligibilityReason} />
                  {!notice.match.hasSufficientData && <div><Badge tone="neutral">Limited data</Badge></div>}
                </>
              ) : (
                <Badge tone="neutral">Not yet matched</Badge>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}

// -------------------------------------------------------------
// §6.1E — Capability library
// -------------------------------------------------------------

function CapabilitiesTab({ onCount }: { onCount: (n: number) => void }) {
  const report = useRef(onCount)
  report.current = onCount
  const { toast } = useToast()
  const [capabilities, setCapabilities] = useState<FirmCapability[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({ name: '', keywords: '', naicsCodes: '', pscCodes: '', geographies: '' })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await discoveryApi.listCapabilities()
      setCapabilities(result)
      report.current(result.length)
    } catch (err) {
      setError((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Could not load the capability library.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const split = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean)

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim()) return
    setSubmitting(true)
    try {
      await discoveryApi.createCapability({
        name: form.name.trim(),
        keywords: split(form.keywords),
        naicsCodes: split(form.naicsCodes),
        pscCodes: split(form.pscCodes),
        geographies: split(form.geographies),
      })
      setForm({ name: '', keywords: '', naicsCodes: '', pscCodes: '', geographies: '' })
      toast('Capability added. Verify it so it counts as confirmed coverage.', 'success')
      await load()
    } catch (err) {
      const e2 = err as { response?: { status?: number; data?: { error?: string } } }
      toast(e2?.response?.status === 403 ? 'Only a firm admin can add a capability.' : e2?.response?.data?.error || 'Could not add the capability.', 'error')
    } finally {
      setSubmitting(false)
    }
  }

  const verify = async (capability: FirmCapability) => {
    try {
      await discoveryApi.verifyCapability(capability.id, capability.verification === 'VERIFIED' ? 'UNVERIFIED' : 'VERIFIED')
      await load()
    } catch {
      toast('Only a firm admin can verify a capability.', 'error')
    }
  }

  return (
    <div className="space-y-6">
      <form onSubmit={create} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Add a capability</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label htmlFor="cap-name" className="block text-[11px] text-gray-500 mb-1">Name</label>
            <input id="cap-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
          </div>
          <div>
            <label htmlFor="cap-keywords" className="block text-[11px] text-gray-500 mb-1">Keywords (comma separated)</label>
            <input id="cap-keywords" value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
          </div>
          <div>
            <label htmlFor="cap-naics" className="block text-[11px] text-gray-500 mb-1">NAICS codes</label>
            <input id="cap-naics" value={form.naicsCodes} onChange={(e) => setForm({ ...form, naicsCodes: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" placeholder="541512, 541519" />
          </div>
          <div>
            <label htmlFor="cap-geo" className="block text-[11px] text-gray-500 mb-1">Geographies</label>
            <input id="cap-geo" value={form.geographies} onChange={(e) => setForm({ ...form, geographies: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" placeholder="Virginia, Nationwide" />
          </div>
        </div>
        <button type="submit" disabled={submitting || !form.name.trim()}
          className="mt-3 text-xs px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
          {submitting ? 'Adding…' : 'Add capability'}
        </button>
      </form>

      {loading ? <LoadingPanel label="Loading capabilities…" />
        : error ? <ErrorPanel message={error} onRetry={load} />
        : capabilities.length === 0 ? (
          <EmptyPanel
            message="Your capability library is empty."
            hint="Capability matching is the primary way opportunities are ranked. Without capabilities, matching falls back to the dimensions it can still assess and says so."
          />
        ) : (
          <div className="space-y-2">
            {capabilities.map((capability) => (
              <div key={capability.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-start justify-between gap-3 flex-wrap">
                <div className="flex-1 min-w-[220px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Layers className="w-4 h-4 text-gray-500" />
                    <span className="text-sm text-gray-100">{capability.name}</span>
                    <Badge tone="neutral">{capability.category}</Badge>
                    <VerifiedMark verified={capability.verification === 'VERIFIED'} />
                  </div>
                  <div className="flex gap-3 flex-wrap mt-1 text-[11px] text-gray-500">
                    {capability.naicsCodes.length > 0 && <span>NAICS {capability.naicsCodes.join(', ')}</span>}
                    {capability.pscCodes.length > 0 && <span>PSC {capability.pscCodes.join(', ')}</span>}
                    {capability.geographies.length > 0 && <span>{capability.geographies.join(', ')}</span>}
                  </div>
                </div>
                <button onClick={() => verify(capability)}
                  className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors">
                  {capability.verification === 'VERIFIED' ? 'Un-verify' : 'Verify'}
                </button>
              </div>
            ))}
          </div>
        )}

      <Disclaimer>
        Only recorded capabilities count towards a match — nothing is inferred. Verifying a capability marks it as confirmed
        coverage in gap analysis; unverified capabilities are reported as partial coverage.
      </Disclaimer>

      <div className="flex items-center gap-2 text-[11px] text-gray-600">
        <Shield className="w-3 h-3" />
        <span>Set-aside eligibility is computed from your registration and certification records, never from this library.</span>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-600">
        <FileSearch className="w-3 h-3" />
        <Link to="/registration" className="hover:text-amber-400">Manage registrations &amp; certifications →</Link>
      </div>
      <div className="flex items-center gap-2 text-[11px] text-gray-600">
        <Calendar className="w-3 h-3" />
        <Link to="/portfolio" className="hover:text-amber-400">See portfolio expected value →</Link>
      </div>
    </div>
  )
}

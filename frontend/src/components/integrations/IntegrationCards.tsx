// =============================================================
// §8.5 — Integration connection cards.
//
// The whole point of this component is telling the truth about state. There
// are four different things a card can be saying, and collapsing them into
// "connected / not connected" is how an operator discovers at year end that
// nothing ever synced:
//
//   CONNECTED           the credential was verified
//   NOT_CONFIGURED      the tenant has not connected it yet
//   CREDENTIAL_REQUIRED this deployment has no server-side credential at all
//   ERROR               connected once; the last operation failed
//
// A provider whose adapter exists but whose endpoints are supplied under
// customer contract says so on the card, rather than showing a connect button
// that leads nowhere.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Link2, Plug, RefreshCw, XCircle } from 'lucide-react'
import {
  integrationsApi, type IntegrationCategory, type IntegrationConnection, type IntegrationStatus,
} from '../../services/integrationsApi'

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never')

const CATEGORY_LABELS: Record<IntegrationCategory, string> = {
  ACCOUNTING: 'Accounting',
  CALENDAR: 'Calendar',
  CHAT: 'Chat',
  ESIGNATURE: 'E-signature',
}

const STATUS_TEXT: Record<IntegrationStatus, string> = {
  CONNECTED: 'Connected',
  NOT_CONFIGURED: 'Not connected',
  CREDENTIAL_REQUIRED: 'Credentials required',
  PENDING: 'Authorization in progress',
  ERROR: 'Error',
  EXPIRED: 'Credential expired',
  DISCONNECTED: 'Disconnected',
}

function statusClass(status: IntegrationStatus): string {
  if (status === 'CONNECTED') return 'text-green-400 border-green-800 bg-green-950/30'
  if (status === 'ERROR' || status === 'EXPIRED') return 'text-red-400 border-red-800 bg-red-950/30'
  if (status === 'CREDENTIAL_REQUIRED') return 'text-yellow-400 border-yellow-800 bg-yellow-950/30'
  return 'text-gray-400 border-gray-700 bg-gray-800/40'
}

function StatusIcon({ status }: { status: IntegrationStatus }) {
  if (status === 'CONNECTED') return <CheckCircle2 className="w-4 h-4 text-green-400" />
  if (status === 'ERROR' || status === 'EXPIRED') return <XCircle className="w-4 h-4 text-red-400" />
  if (status === 'CREDENTIAL_REQUIRED') return <AlertTriangle className="w-4 h-4 text-yellow-400" />
  return <Plug className="w-4 h-4 text-gray-500" />
}

/**
 * Unanet and Deltek are connected with an API key rather than an authorization
 * redirect, so they need their own control. Without one their cards ended at
 * "Configuration required" and there was no way to supply anything.
 */
function ApiKeyConnect({ provider, busy, onSave }: {
  provider: string
  busy: boolean
  onSave: (body: Record<string, unknown>) => void | Promise<void>
}) {
  const [f, setF] = useState({ apiKey: '', baseUrl: '', accountId: '' })
  const field = 'bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500'

  return (
    <form className="flex gap-2 flex-wrap items-center w-full"
      onSubmit={(e) => {
        e.preventDefault()
        void onSave({
          apiKey: f.apiKey.trim(),
          baseUrl: f.baseUrl.trim() || undefined,
          accountId: f.accountId.trim() || undefined,
        })
      }}>
      <input required type="password" aria-label={`${provider} API key`} placeholder="API key *"
        value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })}
        className={`${field} flex-1 min-w-[160px]`} />
      <input aria-label={`${provider} base URL`} placeholder="Base URL (optional)"
        value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} className={field} />
      <input aria-label={`${provider} account id`} placeholder="Account id (optional)"
        value={f.accountId} onChange={(e) => setF({ ...f, accountId: e.target.value })} className={field} />
      <button type="submit" disabled={busy || f.apiKey.trim().length < 8}
        className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
        Save credentials
      </button>
      <p className="w-full text-[10px] text-gray-600">
        The key is stored encrypted and never shown again. Saving it stores the credential — it does not complete the
        request mapping this provider still needs before anything can sync.
      </p>
    </form>
  )
}

/** What actually crossed the boundary, loaded only when asked for. */
function SyncRecords({ connectionId }: { connectionId: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void integrationsApi.syncRecords(connectionId)
      .then(setRows)
      .catch(() => setRows([]))
      .finally(() => setLoading(false))
  }, [open, connectionId])

  return (
    <div className="mt-2">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
        className="text-[11px] text-blue-400 hover:text-blue-300">
        {open ? 'Hide synced records' : 'Synced records'}
      </button>
      {open && (
        <div className="mt-1.5">
          {loading ? (
            <p className="text-[11px] text-gray-500">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="text-[11px] text-gray-500">Nothing has been synced through this connection yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead><tr className="text-left text-gray-600 border-b border-gray-800">
                  <th className="py-1">Record</th><th>Direction</th><th>External id</th><th>Last synced</th>
                </tr></thead>
                <tbody>{rows.slice(0, 25).map((r) => (
                  <tr key={String(r.id)} className="border-b border-gray-900">
                    <td className="py-1 text-gray-300">{String(r.localType)}</td>
                    <td className="text-gray-500">{String(r.direction)}</td>
                    <td className="font-mono text-gray-500">{r.externalId ? String(r.externalId) : '—'}</td>
                    <td className="text-gray-500">{r.lastSyncedAt ? fmt(String(r.lastSyncedAt)) : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
              {rows.some((r) => r.lastError) && (
                <p className="text-[11px] text-red-400 mt-1">
                  {rows.filter((r) => r.lastError).length} record(s) failed on their last attempt.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function IntegrationCards() {
  const [rows, setRows] = useState<IntegrationConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [teamsUrl, setTeamsUrl] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setRows(await integrationsApi.list()) }
    catch (err) { setError(readError(err, 'Could not load integrations.')) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const act = async (key: string, fn: () => Promise<unknown>, message?: string) => {
    setBusy(key); setError(null); setNotice(null)
    try {
      await fn()
      if (message) setNotice(message)
      await load()
    } catch (err) { setError(readError(err, 'That did not work.')) }
    finally { setBusy(null) }
  }

  const connect = async (row: IntegrationConnection) => {
    setBusy(row.provider); setError(null)
    try {
      const { authorizationUrl } = await integrationsApi.authorize(row.provider)
      window.location.href = authorizationUrl
    } catch (err) {
      setError(readError(err, 'That provider could not be connected.'))
      setBusy(null)
    }
  }

  if (loading) return <p className="text-sm text-gray-500">Loading integrations…</p>

  const categories: IntegrationCategory[] = ['ACCOUNTING', 'CALENDAR', 'CHAT', 'ESIGNATURE']

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-red-400">{error}</p>}
      {notice && <p className="text-sm text-green-400">{notice}</p>}

      {categories.map((category) => (
        <section key={category}>
          <h3 className="text-[11px] text-gray-500 uppercase tracking-widest mb-2">{CATEGORY_LABELS[category]}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {rows.filter((r) => r.category === category).map((row) => (
              <div key={row.provider} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2">
                    <StatusIcon status={row.status} />
                    <span className="text-sm font-medium text-gray-100">{row.label}</span>
                  </div>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${statusClass(row.status)}`}>
                    {STATUS_TEXT[row.status]}
                  </span>
                </div>

                {row.externalAccountName && (
                  <p className="text-[11px] text-gray-500 mt-1">Connected to {row.externalAccountName}</p>
                )}

                {row.implementation === 'CONTRACT_ONLY' && (
                  <p className="text-[11px] text-yellow-500/80 mt-2">{row.configurationNote}</p>
                )}

                {!row.platformConfigured && row.missingEnv.length > 0 && (
                  <p className="text-[11px] text-gray-500 mt-2">
                    This deployment is missing <span className="font-mono">{row.missingEnv.join(', ')}</span>.
                  </p>
                )}

                {row.lastError && <p className="text-[11px] text-red-400 mt-2">{row.lastError}</p>}

                {row.status === 'CONNECTED' && (
                  <p className="text-[11px] text-gray-600 mt-2">
                    Last successful sync {fmt(row.lastSuccessfulSyncAt)}
                  </p>
                )}

                {(row.status === 'CONNECTED' || row.status === 'ERROR') && row.id && (
                  <SyncRecords connectionId={row.id} />
                )}

                <div className="flex gap-2 flex-wrap mt-3">
                  {row.provider === 'MICROSOFT_TEAMS' ? (
                    <>
                      <input aria-label="Teams webhook URL" value={teamsUrl} onChange={(e) => setTeamsUrl(e.target.value)}
                        placeholder="Incoming webhook URL"
                        className="flex-1 min-w-[200px] bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-xs text-gray-200 outline-none focus:border-blue-500" />
                      <button disabled={busy === row.provider || teamsUrl.trim().length === 0}
                        onClick={() => void act(row.provider, () => integrationsApi.connectTeams(teamsUrl.trim()), 'Teams channel connected.')}
                        className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
                        Save
                      </button>
                    </>
                  ) : row.status === 'CONNECTED' || row.status === 'ERROR' ? (
                    <>
                      <button disabled={busy === row.provider || !row.id}
                        onClick={() => void act(row.provider, () => integrationsApi.test(row.id), 'Connection tested.')}
                        className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50 flex items-center gap-1">
                        <RefreshCw className="w-3 h-3" /> Test
                      </button>
                      {row.category === 'CALENDAR' && (
                        <button disabled={busy === row.provider}
                          onClick={() => void act(row.provider, () => integrationsApi.sync(row.id), 'Calendar synchronized.')}
                          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
                          Sync now
                        </button>
                      )}
                      <button disabled={busy === row.provider}
                        onClick={() => void act(row.provider, () => integrationsApi.disconnect(row.id), 'Disconnected.')}
                        className="text-xs px-3 py-1.5 rounded bg-red-900/40 hover:bg-red-900/60 text-red-300 border border-red-700 disabled:opacity-50">
                        Disconnect
                      </button>
                    </>
                  ) : row.provider === 'UNANET' || row.provider === 'DELTEK' ? (
                    // Credential storage is in place for these two even though
                    // the request mapping is not, so the key can be saved — but
                    // the "cannot sync yet" line has to stay, or saving a key
                    // reads as having finished the job.
                    <div className="w-full space-y-2">
                      <span className="block text-[11px] text-gray-600">Configuration required before this can sync.</span>
                      <ApiKeyConnect provider={row.provider} busy={busy === row.provider}
                        onSave={(body) => act(row.provider, () => integrationsApi.saveCredentials(row.provider, body), 'Credentials saved.')} />
                    </div>
                  ) : row.implementation === 'CONTRACT_ONLY' ? (
                    <span className="text-[11px] text-gray-600">Configuration required before this can sync.</span>
                  ) : (
                    <button disabled={busy === row.provider || !row.platformConfigured}
                      onClick={() => void connect(row)}
                      title={row.platformConfigured ? undefined : 'This deployment has no credentials for this provider.'}
                      className="text-xs px-3 py-1.5 rounded text-gray-950 font-medium disabled:opacity-40 flex items-center gap-1"
                      style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
                      <Link2 className="w-3 h-3" /> Connect
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

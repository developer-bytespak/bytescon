// =============================================================
// §8.4 — Public API credential management.
//
// The same `api_tokens` table the MCP connector uses, filtered to PUBLIC_API
// credentials. It is a separate panel rather than a second page because the
// two kinds are genuinely different things to grant: one connects an AI host,
// the other lets an integration read the firm's data over REST.
//
// The secret appears exactly once. The panel says so before it is generated
// and again while it is on screen, because the alternative is a support
// ticket that cannot be answered.
// =============================================================
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Copy, KeyRound, Trash2 } from 'lucide-react'
import { mcpApi } from '../services/api'

export const PUBLIC_API_SCOPES = [
  'opportunities:read', 'pursuits:read', 'contracts:read',
  'crm:read', 'partners:read', 'personnel:read', 'analytics:read',
] as const

const TIERS = ['CORE', 'PRO', 'VAULT'] as const
const TIER_RATES: Record<string, string> = { CORE: '60/min', PRO: '300/min', VAULT: '1,000/min' }

interface TokenRow {
  id: string
  name: string
  tokenPrefix: string
  tier: string
  kind: string
  scopes: string[]
  expiresAt: string | null
  revokedAt: string | null
  lastUsedAt: string | null
  createdAt: string
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—')

export function PublicApiTokens() {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>(['opportunities:read'])
  const [tier, setTier] = useState<string>('CORE')
  const [rawToken, setRawToken] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const tokensQ = useQuery({ queryKey: ['mcp-tokens'], queryFn: () => mcpApi.listTokens() })
  const rows: TokenRow[] = (tokensQ.data?.data ?? []).filter((t: TokenRow) => t.kind === 'PUBLIC_API')

  const createMut = useMutation({
    mutationFn: () => mcpApi.createPublicApiToken(name.trim(), scopes, tier),
    onSuccess: (res) => {
      setRawToken(res?.data?.rawToken ?? null)
      setName('')
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] })
    },
  })

  const revokeMut = useMutation({
    mutationFn: (id: string) => mcpApi.revokeToken(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-tokens'] }),
  })

  const toggleScope = (scope: string) =>
    setScopes(scopes.includes(scope) ? scopes.filter((s) => s !== scope) : [...scopes, scope])

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <KeyRound className="w-4 h-4 text-gray-500" />
        <h2 className="text-sm font-semibold text-gray-100">Public API tokens</h2>
      </div>
      <p className="text-[11px] text-gray-500 mb-4">
        For your own integrations against <span className="font-mono">/api/v1</span>. Version 1 is read-only —
        approvals, submissions and payments stay with a person and are not reachable with a token.
      </p>

      {rawToken && (
        <div className="mb-4 bg-gray-950 border border-amber-800 rounded-lg p-3">
          <p className="text-[12px] text-amber-300">
            Copy this token now. It is stored only as a hash and cannot be shown again.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 font-mono text-[12px] text-gray-300 break-all">{rawToken}</code>
            <button
              onClick={() => { navigator.clipboard?.writeText(rawToken); setCopied(true) }}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 flex items-center gap-1">
              <Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        <input aria-label="Token name" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="What is this token for?"
          className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />

        <div>
          <p className="text-[11px] text-gray-500 uppercase tracking-widest mb-1.5">Scopes</p>
          <div className="flex gap-1 flex-wrap">
            {PUBLIC_API_SCOPES.map((scope) => (
              <button key={scope} onClick={() => toggleScope(scope)}
                className={`text-[10px] px-1.5 py-0.5 rounded border font-mono transition-colors ${
                  scopes.includes(scope)
                    ? 'border-amber-700 bg-amber-950/40 text-amber-300'
                    : 'border-gray-700 text-gray-500 hover:text-gray-300'
                }`}>
                {scope}
              </button>
            ))}
          </div>
        </div>

        <div>
          <p className="text-[11px] text-gray-500 uppercase tracking-widest mb-1.5">Rate limit</p>
          <div className="flex gap-1 flex-wrap">
            {TIERS.map((t) => (
              <button key={t} onClick={() => setTier(t)}
                className={`text-[10px] px-1.5 py-0.5 rounded border font-mono transition-colors ${
                  tier === t ? 'border-amber-700 bg-amber-950/40 text-amber-300' : 'border-gray-700 text-gray-500 hover:text-gray-300'
                }`}>
                {t} · {TIER_RATES[t]}
              </button>
            ))}
          </div>
        </div>

        <button onClick={() => createMut.mutate()}
          disabled={createMut.isPending || name.trim().length === 0 || scopes.length === 0}
          className="text-sm px-4 py-2 rounded-lg text-gray-950 font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
          {createMut.isPending ? 'Generating…' : 'Create API token'}
        </button>
        {createMut.isError && <p className="text-sm text-red-400">Could not create that token.</p>}
      </div>

      {rows.length > 0 && (
        <div className="mt-5">
          <p className="text-[11px] text-gray-500 uppercase tracking-widest mb-2">Tokens</p>
          <div className="space-y-1.5">
            {rows.map((t) => (
              <div key={t.id} className="bg-gray-900/50 border border-gray-800 rounded px-2.5 py-2 text-xs">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-gray-400">{t.tokenPrefix}…</span>
                  <span className="text-gray-300">{t.name}</span>
                  {t.revokedAt ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-rose-900 bg-rose-950/40 text-rose-400">revoked</span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-800 bg-emerald-950/40 text-emerald-300">active</span>
                  )}
                  <span className="ml-auto text-gray-600">
                    created {fmt(t.createdAt)} · {t.lastUsedAt ? `used ${fmt(t.lastUsedAt)}` : 'never used'} · expires {fmt(t.expiresAt)}
                  </span>
                  {!t.revokedAt && (
                    <button
                      onClick={() => { if (confirm('Revoke this token? Anything using it stops working immediately.')) revokeMut.mutate(t.id) }}
                      disabled={revokeMut.isPending}
                      className="text-rose-400 hover:text-rose-300 disabled:opacity-50" title="Revoke token">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="flex gap-1 flex-wrap mt-1">
                  {t.scopes.map((s) => (
                    <span key={s} className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 font-mono">{s}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

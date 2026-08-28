import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Plug, Copy, CheckCircle, Loader2, Sparkles } from 'lucide-react'
import { mcpApi } from '../services/api'

const ONBOARDED_KEY = 'bytescon_onboarded'

/**
 * The single hosted connector URL. The gateway serves ALL 27 tools at this one
 * URL, so subscribers add exactly one connector in Claude. We derive it from the
 * app's configured origin when available (so self-hosted/dev installs point at
 * their own gateway), and otherwise fall back to the hosted production URL.
 */
export const CONNECTOR_URL: string = (() => {
  const configured = import.meta.env.VITE_API_URL as string | undefined
  if (configured && /^https?:\/\//.test(configured)) {
    return `${configured.replace(/\/+$/, '')}/all/mcp`
  }
  return 'https://bytescon.com/all/mcp'
})()

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
      }}
      className="btn-secondary text-xs flex items-center gap-1.5 shrink-0"
    >
      <Copy className="w-3.5 h-3.5" /> {copied ? 'Copied' : label ?? 'Copy'}
    </button>
  )
}

const STEP_LINES = [
  'In Claude, open Settings → Connectors.',
  'Click "Add custom connector".',
  'Paste the connector URL below and click "Connect".',
  'When Claude asks you to sign in, paste your access token on the Bytescon sign-in page.',
  "That's it — all 27 Bytescon tools are now available in Claude.",
]

/**
 * Low-friction "Connect to Claude" wizard. One button mints a token (shown once),
 * then surfaces the single connector URL + token with copy buttons and short
 * numbered steps. "I've connected" marks onboarding complete.
 *
 * Can render inline (default) or as a modal when `onClose` is provided.
 */
export function ConnectClaudeWizard({ onClose }: { onClose?: () => void }) {
  const qc = useQueryClient()
  const [rawToken, setRawToken] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const tokensQ = useQuery({ queryKey: ['mcp-tokens'], queryFn: () => mcpApi.listTokens() })
  const existingTokens: any[] = tokensQ.data?.data ?? []
  const hasActiveToken = existingTokens.some((t) => !t.revokedAt)

  const createMut = useMutation({
    mutationFn: () => mcpApi.createToken('Claude Connector'),
    onSuccess: (res: any) => {
      setRawToken(res?.data?.rawToken ?? null)
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] })
    },
  })

  function markDone() {
    localStorage.setItem(ONBOARDED_KEY, '1')
    setDone(true)
    // Best-effort confirmation that a token exists.
    qc.invalidateQueries({ queryKey: ['mcp-tokens'] })
    onClose?.()
  }

  const body = (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-cyan-400" />
        <h2 className="font-semibold text-slate-100 text-lg">Connect to Claude</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="ml-auto text-slate-600 hover:text-slate-300 transition-colors"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>
      <p className="text-sm text-slate-400 leading-relaxed">
        Connect Bytescon directly to Claude so you can ask about opportunities, pipelines, and
        market data in plain English. One connector gives Claude all 27 Bytescon tools — generate
        your connection below, then add it in Claude once.
      </p>

      {/* Step 1: generate token */}
      {!rawToken && (
        <div className="rounded-xl border border-amber-500/25 bg-cyan-500/5 p-4">
          <button
            onClick={() => createMut.mutate()}
            disabled={createMut.isPending}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            {createMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
            {createMut.isPending ? 'Generating…' : 'Generate my Claude connection'}
          </button>
          {hasActiveToken && (
            <p className="text-xs text-slate-500 mt-2">
              You already have an active token. Generating a new one is fine — each connection uses its
              own token, and you can revoke old ones in Settings.
            </p>
          )}
          {createMut.isError && (
            <p className="text-sm text-red-400 mt-2">Failed to generate your connection. Please try again.</p>
          )}
        </div>
      )}

      {/* Step 2: URL + token + steps */}
      {rawToken && (
        <div className="space-y-4">
          {/* Connector URL */}
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-4">
            <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-2">Connector URL</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-[12px] text-slate-200 bg-slate-950 rounded px-2.5 py-2 break-all">
                {CONNECTOR_URL}
              </code>
              <CopyButton value={CONNECTOR_URL} label="Copy URL" />
            </div>
          </div>

          {/* Access token (shown once) */}
          <div className="rounded-xl border border-amber-700/60 bg-amber-950/30 p-4">
            <p className="text-xs text-cyan-300 font-medium mb-2">
              ⚠ Save this access token now — it's shown only once.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-[11px] text-amber-100 bg-slate-950 rounded px-2.5 py-2 break-all">
                {rawToken}
              </code>
              <CopyButton value={rawToken} label="Copy token" />
            </div>
          </div>

          {/* Numbered steps */}
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-4">
            <p className="text-[11px] uppercase tracking-widest text-slate-500 mb-3">Add it in Claude</p>
            <ol className="space-y-2.5">
              {STEP_LINES.map((line, i) => (
                <li key={i} className="flex gap-3 text-sm text-slate-300">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-cyan-500/15 border border-cyan-500/30 text-cyan-300 text-[11px] font-semibold flex items-center justify-center">
                    {i + 1}
                  </span>
                  <span className="leading-relaxed">{line}</span>
                </li>
              ))}
            </ol>
          </div>

          {/* Done */}
          {done ? (
            <div className="flex items-center gap-2 text-sm text-emerald-300 bg-emerald-950/30 border border-emerald-800/50 rounded-lg px-3 py-2">
              <CheckCircle className="w-4 h-4 shrink-0" />
              You're connected. You can manage or revoke this token anytime in Settings → MCP Access.
            </div>
          ) : (
            <button
              onClick={markDone}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold text-black rounded-lg"
              style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}
            >
              <CheckCircle className="w-4 h-4" /> I've connected
            </button>
          )}
        </div>
      )}
    </div>
  )

  if (onClose) {
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(4px)' }}
      >
        <div
          className="relative w-full max-w-lg rounded-2xl p-7 max-h-[90vh] overflow-y-auto"
          style={{
            background: 'linear-gradient(135deg, #0a1a26 0%, #0f1e35 100%)',
            border: '1px solid rgba(6,182,212,0.25)',
            boxShadow: '0 25px 60px rgba(0,0,0,0.6)',
          }}
        >
          {body}
        </div>
      </div>
    )
  }

  return body
}

// =============================================================
// §8.5 — Single sign-on configuration.
//
// The client secret is write-only here. The form shows whether one is stored
// and lets an administrator replace it; there is no path by which it is read
// back, because the server does not return it.
//
// Enforcement carries its own warning, because a firm that turns it on with a
// misconfigured identity provider and no break-glass address is one deploy
// away from locking itself out.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { KeyRound, ShieldAlert } from 'lucide-react'
import { rbacApi, ssoApi, type SsoConfig } from '../../services/integrationsApi'

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const EMPTY = {
  displayName: 'Single sign-on', issuer: '', clientId: '', clientSecret: '',
  authorizationUrl: '', tokenUrl: '', jwksUri: '',
  allowedEmailDomains: '', breakGlassEmails: '', defaultRole: 'VIEWER',
}

export function SsoSettings() {
  const [config, setConfig] = useState<SsoConfig | null>(null)
  const [form, setForm] = useState({ ...EMPTY })
  const [enabled, setEnabled] = useState(false)
  const [enforced, setEnforced] = useState(false)
  const [autoProvision, setAutoProvision] = useState(false)
  const [roles, setRoles] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const [permitted, setPermitted] = useState(true)

  const load = useCallback(async () => {
    setError(null)
    try {
      const me = await rbacApi.me()
      if (!me.permissions.includes('SSO_MANAGE')) { setPermitted(false); return }
      const [row, catalog] = await Promise.all([ssoApi.config(), rbacApi.catalog()])
      setRoles(catalog.roles.map((r) => r.role).filter((r) => r !== 'ADMIN'))
      setConfig(row)
      if (row) {
        setEnabled(row.enabled); setEnforced(row.enforced); setAutoProvision(row.autoProvision)
        setForm({
          displayName: row.displayName, issuer: row.issuer ?? '', clientId: row.clientId ?? '',
          clientSecret: '', authorizationUrl: row.authorizationUrl ?? '', tokenUrl: row.tokenUrl ?? '',
          jwksUri: row.jwksUri ?? '',
          allowedEmailDomains: row.allowedEmailDomains.join(', '),
          breakGlassEmails: row.breakGlassEmails.join(', '),
          defaultRole: row.defaultRole,
        })
      }
    } catch (err) { setError(readError(err, 'Could not load single sign-on settings.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    setBusy(true); setError(null); setSaved(false)
    try {
      const list = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean)
      await ssoApi.save({
        providerType: 'OIDC',
        displayName: form.displayName,
        enabled, enforced, autoProvision,
        defaultRole: form.defaultRole,
        issuer: form.issuer || null,
        clientId: form.clientId || null,
        // Sent only when the administrator typed a new one, so saving the form
        // never clears a stored secret by accident.
        ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}),
        authorizationUrl: form.authorizationUrl || null,
        tokenUrl: form.tokenUrl || null,
        jwksUri: form.jwksUri || null,
        allowedEmailDomains: list(form.allowedEmailDomains),
        breakGlassEmails: list(form.breakGlassEmails),
      })
      setForm({ ...form, clientSecret: '' })
      setSaved(true)
      await load()
    } catch (err) { setError(readError(err, 'Those settings could not be saved.')) }
    finally { setBusy(false) }
  }

  if (!permitted) {
    return <p className="text-sm text-gray-500">You do not have permission to configure single sign-on.</p>
  }

  const field = (key: keyof typeof EMPTY, label: string, placeholder = '') => (
    <label className="block">
      <span className="text-[11px] text-gray-500">{label}</span>
      <input aria-label={label} value={form[key]} placeholder={placeholder}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
    </label>
  )

  return (
    <div className="space-y-4">
      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <KeyRound className="w-4 h-4 text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-100">OpenID Connect</h3>
        </div>

        {field('displayName', 'Button label', 'Sign in with Okta')}
        {field('issuer', 'Issuer', 'https://your-idp.example.com')}
        {field('clientId', 'Client ID')}
        <label className="block">
          <span className="text-[11px] text-gray-500">
            Client secret {config?.clientSecretConfigured ? '(one is stored — type a new one to replace it)' : '(none stored)'}
          </span>
          <input aria-label="Client secret" type="password" value={form.clientSecret}
            onChange={(e) => setForm({ ...form, clientSecret: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500" />
        </label>
        {field('authorizationUrl', 'Authorization URL')}
        {field('tokenUrl', 'Token URL')}
        {field('jwksUri', 'JWKS URI', 'Required for RS256 identity providers')}
        {field('allowedEmailDomains', 'Allowed email domains', 'example.com, example.org')}

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" aria-label="Enable single sign-on" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable single sign-on
        </label>

        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" aria-label="Create accounts automatically" checked={autoProvision}
            onChange={(e) => setAutoProvision(e.target.checked)} />
          Create an account on first sign-in
        </label>

        {autoProvision && (
          <label className="block">
            <span className="text-[11px] text-gray-500">Role for a newly created account</span>
            <select aria-label="Default role" value={form.defaultRole}
              onChange={(e) => setForm({ ...form, defaultRole: e.target.value })}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200">
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <span className="text-[10px] text-gray-600">Administrator cannot be granted automatically.</span>
          </label>
        )}
      </section>

      <section className="bg-gray-900 border border-amber-900/60 rounded-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldAlert className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-semibold text-gray-100">Enforcement</h3>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-300">
          <input type="checkbox" aria-label="Require single sign-on" checked={enforced} onChange={(e) => setEnforced(e.target.checked)} />
          Require single sign-on — refuse password sign-in
        </label>
        {field('breakGlassEmails', 'Break-glass addresses', 'admin@example.com')}
        <p className="text-[11px] text-gray-500">
          Break-glass addresses can always sign in with a password. If you list none, password sign-in stays
          available for everyone — enforcement without a way back in would lock your firm out of its own account.
        </p>
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {saved && <p className="text-sm text-green-400">Saved.</p>}

      <button onClick={() => void save()} disabled={busy}
        className="text-sm px-4 py-2 rounded-lg text-gray-950 font-medium disabled:opacity-50"
        style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
        {busy ? 'Saving…' : 'Save single sign-on settings'}
      </button>

      <SsoIdentities />
    </div>
  )
}

/**
 * Who has actually signed in through the identity provider.
 *
 * Configuration says what SHOULD happen; this says what did. The two disagree
 * more often than anyone expects — a provider that was saved but never
 * successfully used looks identical to a working one until you look here.
 */
function SsoIdentities() {
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([])
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoading(true); setFailed(false)
    void ssoApi.identities()
      .then(setRows)
      .catch(() => setFailed(true))
      .finally(() => setLoading(false))
  }, [open])

  const fmtDate = (v: unknown) =>
    v ? new Date(String(v)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

  return (
    <section className="bg-gray-900 border border-gray-800 rounded-xl p-4 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-sm font-semibold text-gray-100">Linked identities</h3>
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open}
          className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">
          {open ? 'Hide' : 'Show who has signed in'}
        </button>
      </div>

      {open && (
        loading ? <p className="text-[12px] text-gray-500">Loading…</p>
          : failed ? <p className="text-[12px] text-red-400">Could not read linked identities.</p>
          : rows.length === 0 ? (
            <p className="text-[12px] text-gray-500">
              Nobody has signed in through the identity provider yet. Saving a configuration does not prove it works.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[12px]">
                <thead><tr className="text-left text-gray-500 border-b border-gray-800">
                  <th className="py-1.5">Person</th><th>Provider email</th><th>Issuer</th><th>Last sign-in</th>
                </tr></thead>
                <tbody>{rows.map((r) => {
                  const user = r.user as Record<string, unknown> | null
                  return (
                    <tr key={String(r.id)} className="border-b border-gray-900">
                      <td className="py-1.5 text-gray-200">
                        {user ? `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim() || String(user.email) : '—'}
                        {user && user.isActive === false && <span className="text-gray-600"> · inactive</span>}
                      </td>
                      <td className="text-gray-400">{String(r.email)}</td>
                      <td className="font-mono text-gray-500 truncate max-w-[220px]">{String(r.issuer)}</td>
                      <td className="text-gray-500">{fmtDate(r.lastLoginAt)}</td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
          )
      )}
    </section>
  )
}

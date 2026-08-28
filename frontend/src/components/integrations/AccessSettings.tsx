// =============================================================
// §8.5 — Roles and permissions.
//
// Shows what each role can do BEFORE it is assigned, because "FINANCE" tells
// an administrator nothing on its own. The list is fetched from the server, so
// the UI can never drift from the permission model it is describing.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { rbacApi, type AccessUser, type RbacCatalog } from '../../services/integrationsApi'

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const ROLE_BLURBS: Record<string, string> = {
  ADMIN: 'Everything, including billing, credentials and access.',
  CONSULTANT: 'Read-only across the platform. Unchanged from before.',
  BD_CAPTURE: 'Contacts and the pipeline. No money, no approvals.',
  PROPOSAL: 'Proposal content and personnel, including approving a section.',
  CONTRACTS: 'Contracts, partners and sending agreements for signature.',
  FINANCE: 'Budgets, invoices, purchase orders and payments.',
  VIEWER: 'Read-only.',
}

export function AccessSettings() {
  const [catalog, setCatalog] = useState<RbacCatalog | null>(null)
  const [users, setUsers] = useState<AccessUser[]>([])
  const [mine, setMine] = useState<{ role: string | null; permissions: string[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [canAdminister, setCanAdminister] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      const [cat, me] = await Promise.all([rbacApi.catalog(), rbacApi.me()])
      setCatalog(cat); setMine(me)
      // The list is fetched only when the caller may actually administer, so a
      // user without the permission sees their own access rather than a 403.
      if (me.permissions.includes('ADMIN_SETTINGS')) {
        setCanAdminister(true)
        setUsers(await rbacApi.users())
      }
    } catch (err) { setError(readError(err, 'Could not load access settings.')) }
  }, [])
  useEffect(() => { void load() }, [load])

  const changeRole = async (user: AccessUser, role: string) => {
    setBusy(user.id); setError(null)
    try { await rbacApi.updateUser(user.id, { role }); await load() }
    catch (err) { setError(readError(err, 'That role could not be changed.')) }
    finally { setBusy(null) }
  }

  if (!catalog || !mine) return <p className="text-sm text-gray-500">Loading access settings…</p>

  return (
    <div className="space-y-4">
      {error && <p className="text-sm text-red-400">{error}</p>}

      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 mb-1">
          <ShieldCheck className="w-4 h-4 text-gray-500" />
          <h3 className="text-sm font-semibold text-gray-100">Your access</h3>
        </div>
        <p className="text-[11px] text-gray-500">
          Signed in as <span className="font-mono text-gray-300">{mine.role ?? 'unknown'}</span> ·{' '}
          {mine.permissions.length} permission(s)
        </p>
        <div className="flex gap-1 flex-wrap mt-2">
          {mine.permissions.map((p) => (
            <span key={p} className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500 font-mono">{p}</span>
          ))}
        </div>
      </section>

      <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-100 mb-2">Roles</h3>
        <div className="space-y-2">
          {catalog.roles.map((r) => (
            <div key={r.role} className="border border-gray-800 rounded-lg p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="text-sm text-gray-100 font-mono">{r.role}</span>
                <span className="text-[11px] text-gray-500">{r.permissions.length} permission(s)</span>
              </div>
              <p className="text-[11px] text-gray-500 mt-1">{ROLE_BLURBS[r.role] ?? ''}</p>
            </div>
          ))}
        </div>
      </section>

      {canAdminister && (
        <section className="bg-gray-900 border border-gray-800 rounded-xl p-4">
          <h3 className="text-sm font-semibold text-gray-100 mb-2">Team access</h3>
          <div className="space-y-1.5">
            {users.map((user) => (
              <div key={user.id} className="flex items-center gap-2 flex-wrap text-xs bg-gray-900/50 border border-gray-800 rounded px-2.5 py-2">
                <span className="text-gray-200">{user.firstName} {user.lastName}</span>
                <span className="text-gray-600">{user.email}</span>
                {!user.isActive && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 text-gray-500">inactive</span>
                )}
                <select
                  aria-label={`Role for ${user.email}`}
                  className="ml-auto bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
                  value={user.role}
                  disabled={busy === user.id}
                  onChange={(e) => void changeRole(user, e.target.value)}>
                  {catalog.roles.map((r) => <option key={r.role} value={r.role}>{r.role}</option>)}
                </select>
              </div>
            ))}
          </div>
          <p className="text-[10px] text-gray-600 mt-3">
            A change takes effect on that person&rsquo;s next request. The last administrator cannot be demoted.
          </p>
        </section>
      )}
    </div>
  )
}

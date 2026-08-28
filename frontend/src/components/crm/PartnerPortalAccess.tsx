// =============================================================
// §8.1 / §8.3 — Partner portal access, granted from the partner's CRM record.
//
// This panel sits inside the partner's own CRM detail because that is where a
// person already is when they decide to let a subcontractor in: they are
// looking at who the partner is, what work has been shared, and how the
// relationship has gone.
//
// TWO THINGS THIS SCREEN IS CAREFUL ABOUT:
//
//  1. The invite token is shown ONCE. The server stores only its hash, so a
//     token that is not copied here cannot be recovered — the screen says so
//     before it is generated and again while it is on display.
//  2. Inviting grants NOTHING. Access is default-deny: a portal user who has
//     accepted still sees an empty portal until an engagement is granted, and
//     the panel states that rather than letting someone assume otherwise.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Copy, KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import { Badge } from '../section6/Section6Ui'
import { useToast } from '../Toast'
import {
  loadContractOptions, partnerPortalAdminApi,
  type ContractOption, type PortalUserRow,
} from '../../services/crmApi'

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const fmt = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

export function PartnerPortalAccess({ partnerId, partnerName }: { partnerId: string; partnerName: string }) {
  const { toast } = useToast()
  const [users, setUsers] = useState<PortalUserRow[]>([])
  const [contracts, setContracts] = useState<ContractOption[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [form, setForm] = useState({ email: '', firstName: '', lastName: '' })
  const [issued, setIssued] = useState<{ email: string; token: string; expiresAt: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [grantFor, setGrantFor] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setUsers(await partnerPortalAdminApi.listUsers(partnerId)) }
    catch (err) { setError(readError(err, 'Could not load portal access.')) }
    finally { setLoading(false) }

    // The grant picker is supplementary; a failure here must not hide the
    // access list, which is the point of the panel.
    try { setContracts(await loadContractOptions()) }
    catch { setContracts([]) }
  }, [partnerId])
  useEffect(() => { void load() }, [load])

  const invite = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.email.trim() || !form.firstName.trim() || !form.lastName.trim()) return
    setBusy('invite'); setError(null)
    try {
      const created = await partnerPortalAdminApi.invite({
        partnerId,
        email: form.email.trim(),
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
      })
      setIssued({ email: created.email, token: created.inviteToken, expiresAt: created.inviteExpiresAt })
      setForm({ email: '', firstName: '', lastName: '' })
      setCopied(false)
      toast('Invitation created. Copy the link now — it is not shown again.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not create the invitation.'), 'error') }
    finally { setBusy(null) }
  }

  const grant = async (user: PortalUserRow) => {
    const contractId = grantFor[user.id]
    if (!contractId) return
    setBusy(user.id)
    try {
      await partnerPortalAdminApi.grant({ partnerPortalUserId: user.id, scopeType: 'CONTRACT', scopeId: contractId })
      setGrantFor({ ...grantFor, [user.id]: '' })
      toast('Contract shared with this portal user.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not grant access.'), 'error') }
    finally { setBusy(null) }
  }

  const revokeAccess = async (accessId: string) => {
    setBusy(accessId)
    try {
      await partnerPortalAdminApi.revokeAccess(accessId)
      toast('Access revoked. It stops working on their next request.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not revoke access.'), 'error') }
    finally { setBusy(null) }
  }

  const revokeUser = async (user: PortalUserRow) => {
    if (!confirm(`Revoke portal access for ${user.email}? They are signed out immediately.`)) return
    setBusy(user.id)
    try {
      await partnerPortalAdminApi.revokeUser(user.id)
      toast('Portal user revoked.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not revoke the user.'), 'error') }
    finally { setBusy(null) }
  }

  const inviteUrl = issued
    ? `${window.location.origin}/partner/accept-invite?token=${encodeURIComponent(issued.token)}`
    : ''

  const contractLabel = (id: string) => {
    const match = contracts.find((c) => c.id === id)
    return match ? `${match.contractNumber} — ${match.title}` : id
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="w-4 h-4 text-gray-500" />
        <h3 className="text-sm font-semibold text-gray-300">Subcontractor portal access</h3>
      </div>
      <p className="text-[11px] text-gray-600 mb-3">
        People at {partnerName} who can sign in to the external portal. They see only the engagements you
        grant here — never your CRM notes, relationship score or interaction history.
      </p>

      {issued && (
        <div className="mb-4 bg-gray-950 border border-amber-800 rounded-lg p-3">
          <p className="text-[12px] text-amber-300">
            Send this link to {issued.email} now. Only its hash is stored, so it cannot be shown again.
            It expires {fmt(issued.expiresAt)}.
          </p>
          <div className="flex items-center gap-2 mt-2">
            <code className="flex-1 font-mono text-[11px] text-gray-300 break-all">{inviteUrl}</code>
            <button
              onClick={() => { navigator.clipboard?.writeText(inviteUrl); setCopied(true) }}
              className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 flex items-center gap-1 flex-shrink-0">
              <Copy className="w-3 h-3" /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </div>
      )}

      <form onSubmit={invite}>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <input aria-label="Portal user email" className="input md:col-span-2" placeholder="their@email.com"
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input aria-label="Portal user first name" className="input" placeholder="First name"
            value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          <input aria-label="Portal user last name" className="input" placeholder="Last name"
            value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        </div>
        <button type="submit"
          disabled={busy === 'invite' || !form.email.trim() || !form.firstName.trim() || !form.lastName.trim()}
          className="mt-3 text-xs px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50 flex items-center gap-1"
          style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
          <KeyRound className="w-3 h-3" /> {busy === 'invite' ? 'Creating…' : 'Invite to portal'}
        </button>
      </form>

      {error && <p className="text-[12px] text-red-400 mt-2">{error}</p>}

      <div className="mt-4 pt-4 border-t border-gray-800">
        {loading ? (
          <p className="text-[12px] text-gray-500">Loading portal access…</p>
        ) : users.length === 0 ? (
          <p className="text-[12px] text-gray-500">
            Nobody at {partnerName} has portal access yet.
          </p>
        ) : (
          <div className="space-y-3">
            {users.map((user) => (
              <div key={user.id} className="border border-gray-800 rounded-lg p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[13px] text-gray-100">{user.firstName} {user.lastName}</span>
                  <span className="text-[11px] text-gray-500 font-mono">{user.email}</span>
                  {user.revokedAt || !user.isActive
                    ? <Badge tone="danger">REVOKED</Badge>
                    : user.acceptedAt
                      ? <Badge tone="success">ACTIVE</Badge>
                      : <Badge tone="warning">INVITED — NOT ACCEPTED</Badge>}
                  {!user.revokedAt && user.isActive && (
                    <button onClick={() => void revokeUser(user)} disabled={busy === user.id}
                      className="ml-auto text-rose-400 hover:text-rose-300 disabled:opacity-50" title="Revoke portal access">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <p className="text-[11px] text-gray-600 mt-0.5">
                  Invited {fmt(user.invitedAt)} · {user.acceptedAt ? `accepted ${fmt(user.acceptedAt)}` : 'not accepted yet'}
                  {user.lastLoginAt ? ` · last signed in ${fmt(user.lastLoginAt)}` : ''}
                </p>

                <div className="mt-2">
                  {user.access.length === 0 ? (
                    <p className="text-[11px] text-yellow-500/80">
                      No engagement shared yet — they will sign in to an empty portal until you share one below.
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {user.access.map((a) => (
                        <div key={a.id} className="flex items-center gap-2 text-[11px] flex-wrap">
                          <Badge tone="neutral">{a.scopeType}</Badge>
                          <span className="text-gray-400">{contractLabel(a.scopeId)}</span>
                          <button onClick={() => void revokeAccess(a.id)} disabled={busy === a.id}
                            className="text-gray-600 hover:text-rose-400 disabled:opacity-50">remove</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {!user.revokedAt && user.isActive && (
                  <div className="flex gap-2 mt-2 flex-wrap">
                    <select aria-label={`Share a contract with ${user.email}`} className="input flex-1 min-w-[200px]"
                      value={grantFor[user.id] ?? ''}
                      onChange={(e) => setGrantFor({ ...grantFor, [user.id]: e.target.value })}>
                      <option value="">Share a contract…</option>
                      {contracts.map((c) => (
                        <option key={c.id} value={c.id}>{c.contractNumber} — {c.title}</option>
                      ))}
                    </select>
                    <button onClick={() => void grant(user)} disabled={busy === user.id || !grantFor[user.id]}
                      className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
                      Share
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

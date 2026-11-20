// One subcontractor's or prime's relationship with you: their people, your
// interactions, relationship strength and teaming history. It reads the same
// partner records as the list it opens from; it never keeps a second list.
import { useCallback, useEffect, useState } from 'react'
import { Badge, ErrorPanel, LoadingPanel } from '../section6/Section6Ui'
import { ActivityTimeline, RelationshipBadge, RelationshipPanel } from './CrmUi'
import { PartnerPortalAccess } from './PartnerPortalAccess'
import { useToast } from '../Toast'
import { crmApi, type PartnerCrmDetail } from '../../services/crmApi'

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

/** Where a saved prime has got to (Agency View's status). */
const SAVED_PRIME_STATUS: Record<string, string> = {
  IDENTIFIED: 'Saved', CONTACTED: 'Contacted', CONVERSATION: 'In conversation', MOU: 'MOU / agreement', TEAMED: 'Teamed', DECLINED: 'Declined',
}

export function PartnerRelationshipView({ partnerId, onBack }: { partnerId: string; onBack: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<PartnerCrmDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ fullName: '', title: '', email: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await crmApi.getPartnerCrm(partnerId)) }
    catch (err) { setError(readError(err, 'Could not load the partner.')) }
    finally { setLoading(false) }
  }, [partnerId])
  useEffect(() => { void load() }, [load])

  const addContact = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.fullName.trim()) return
    setSaving(true)
    try {
      await crmApi.createPartnerContact({
        partnerId,
        fullName: form.fullName.trim(),
        title: form.title.trim() || null,
        email: form.email.trim() || null,
      })
      setForm({ fullName: '', title: '', email: '' })
      toast('Partner contact added.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not add the contact.'), 'error') }
    finally { setSaving(false) }
  }

  if (loading) return <LoadingPanel label="Loading partner…" />
  if (error || !data) return <ErrorPanel message={error ?? 'Partner not found.'} onRetry={load} />

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-300">← Back to your subs &amp; primes</button>

      <div className="card">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg font-semibold text-gray-100">{data.name}</span>
          <RelationshipBadge state={data.relationship.state} score={data.relationship.score} />
        </div>
        <div className="flex gap-4 text-[11px] text-gray-500 mt-1 font-mono flex-wrap">
          {data.uei && <span>UEI {data.uei}</span>}
          {data.cage && <span>CAGE {data.cage}</span>}
          {data.geography && <span>{data.geography}</span>}
        </div>
        {data.capabilities.length > 0 && (
          <p className="text-[11px] text-gray-500 mt-2">Capabilities: {data.capabilities.join(', ')}</p>
        )}
        {data.certifications.length > 0 && (
          <p className="text-[11px] text-gray-500 mt-1">Certifications: {data.certifications.join(', ')}</p>
        )}
      </div>

      <RelationshipPanel relationship={data.relationship} />

      {/* Portal access is granted from here on purpose: this is where someone
          is already looking at who the partner is when they decide to let
          them in. */}
      <PartnerPortalAccess partnerId={partnerId} partnerName={data.name} />

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-100 mb-3">People ({data.contacts.length})</h3>
        {data.contacts.length === 0 ? (
          <p className="text-[12px] text-gray-500">No contacts recorded for this partner yet.</p>
        ) : (
          <div className="space-y-1.5">
            {data.contacts.map((c) => (
              <div key={c.id} className="flex items-center gap-2 flex-wrap text-[12px]">
                <span className="text-gray-200">{c.fullName}</span>
                {c.isPrimary && <Badge tone="brand">PRIMARY</Badge>}
                {c.title && <span className="text-gray-500">{c.title}</span>}
                {c.email && <span className="text-gray-600 font-mono">{c.email}</span>}
              </div>
            ))}
          </div>
        )}

        <form onSubmit={addContact} className="mt-3 pt-3 border-t border-gray-800 flex gap-2 flex-wrap">
          <input aria-label="Partner contact name" className="input flex-1 min-w-[160px]" placeholder="Full name"
            value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <input aria-label="Partner contact title" className="input" placeholder="Title"
            value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input aria-label="Partner contact email" className="input" placeholder="Email"
            value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <button type="submit" disabled={saving || !form.fullName.trim()}
            className="btn-secondary btn-sm disabled:opacity-50">
            {saving ? 'Adding…' : 'Add person'}
          </button>
        </form>
      </div>

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-100 mb-3">Teaming history</h3>
        {data.arrangements.length === 0 ? (
          <p className="text-[12px] text-gray-500">No teaming arrangements recorded.</p>
        ) : (
          <div className="space-y-1.5">
            {data.arrangements.map((a) => (
              <div key={a.id} className="flex items-center gap-2 flex-wrap text-[12px]">
                <Badge tone="neutral">{a.role}</Badge>
                {a.clientCompany && <span className="text-gray-300">{a.clientCompany.isSelf ? 'Your company' : a.clientCompany.name}</span>}
                <Badge tone="info">{a.teamingStatus}</Badge>
                <Badge tone={a.agreementStatus === 'SIGNED' ? 'success' : 'neutral'}>{a.agreementStatus}</Badge>
                {a.opportunity && <span className="text-gray-400 truncate max-w-[320px]">{a.opportunity.title}</span>}
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-gray-600 mt-2">
          Teaming deals are managed in the agreements tracker on the list page. This view reads them; it
          does not change them.
        </p>
      </div>

      {(data.savedPrimeEntries?.length ?? 0) > 0 && (
        <div className="card">
          <h3 className="text-sm font-semibold text-gray-100 mb-1">Saved as a prime to team with</h3>
          <p className="text-[11px] text-gray-500 mb-3">From Agency View: which client might sub to them, at which agency, and how far it has got.</p>
          <div className="space-y-1.5">
            {data.savedPrimeEntries!.map((e) => (
              <div key={e.id} className="flex items-center gap-2 flex-wrap text-[12px]">
                <Badge tone="info">{SAVED_PRIME_STATUS[e.status] ?? e.status}</Badge>
                <span className="text-gray-200">{e.clientCompany ? (e.clientCompany.isSelf ? 'Your company' : e.clientCompany.name) : 'Client not recorded'}</span>
                <span className="text-gray-500">at {e.agencyName ?? e.agencyCode}</span>
                {e.fitScoreAtSave != null && <span className="text-gray-500">· fit {Math.round(e.fitScoreAtSave)}</span>}
                {e.lastOutreachAt && <span className="text-gray-600">· last outreach {new Date(e.lastOutreachAt).toLocaleDateString()}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h3 className="text-sm font-semibold text-gray-100 mb-3">Interaction history</h3>
        <ActivityTimeline activities={data.activities} />
      </div>
    </div>
  )
}

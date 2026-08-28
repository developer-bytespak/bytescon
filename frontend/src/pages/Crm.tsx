// =============================================================
// §8.1 — GovCon CRM.
//
// Agencies, contacts, activities, follow-ups and partners. This page composes
// over records the platform already owns: agencies are grouped from the agency
// names already stored on opportunities, pursuits stay in the existing pipeline
// and weighted value stays with the portfolio service. Nothing here is a second
// system for something that already exists.
// =============================================================
import { useCallback, useEffect, useState } from 'react'
import { Building2, CalendarClock, Users2, Users } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { Badge, EmptyPanel, ErrorPanel, LoadingPanel } from '../components/section6/Section6Ui'
import { ActivityTimeline, ContactRoleBadge, RelationshipBadge, RelationshipPanel } from '../components/crm/CrmUi'
import { PartnerPortalAccess } from '../components/crm/PartnerPortalAccess'
import { useToast } from '../components/Toast'
import {
  crmApi, searchOpportunityOptions, getOpportunityOption,
  CONTACT_ROLE_LABELS, ACTIVITY_TYPE_LABELS,
  type AgencyOffice, type AgencySummary, type CrmActivity, type CrmFollowUp, type GovContactRole,
  type GovernmentContact, type CrmActivityType, type OpportunityOption,
  type PartnerCrmDetail, type RelationshipStrength,
} from '../services/crmApi'
import { teamingApi } from '../services/api'
import { useTabParam } from '../hooks/useTabParam'
import { SearchSelect, type SearchOption } from '../components/SearchSelect'

type TabKey = 'agencies' | 'contacts' | 'activities' | 'follow-ups' | 'partners'

const TABS: Array<{ key: TabKey; label: string }> = [
  { key: 'agencies', label: 'Agencies' },
  { key: 'contacts', label: 'Contacts' },
  { key: 'activities', label: 'Activities' },
  { key: 'follow-ups', label: 'Follow-ups' },
  { key: 'partners', label: 'Partners' },
]

const toOpportunityOption = (o: OpportunityOption): SearchOption =>
  ({ id: o.id, label: o.title, hint: o.agency })

const searchOpportunities = async (term: string): Promise<SearchOption[]> =>
  (await searchOpportunityOptions(term)).map(toOpportunityOption)

const resolveOpportunity = async (id: string): Promise<SearchOption | null> => {
  const o = await getOpportunityOption(id)
  return o ? toOpportunityOption(o) : null
}

const readError = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error || fallback

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

/** Government contacts for the link pickers, same optional-failure rule. */
function useContactOptions() {
  const [options, setOptions] = useState<GovernmentContact[]>([])
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const rows = await crmApi.listContacts()
        if (!cancelled) setOptions(rows)
      } catch { /* linking stays optional */ }
    })()
    return () => { cancelled = true }
  }, [])
  return options
}

export default function CrmPage() {
  const [tab, setTab] = useTabParam(TABS.map((t) => t.key), 'agencies')

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="Relationships"
        subtitle="Agency contacts, interaction history, follow-ups and partner relationships — linked to the pursuits you already track."
      />

      <div className="border-b border-gray-800 flex gap-1 flex-wrap">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-2 text-sm border-b-2 transition-colors ${
              tab === t.key ? 'border-amber-500 text-amber-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'agencies' && <AgenciesTab />}
      {tab === 'contacts' && <ContactsTab />}
      {tab === 'activities' && <ActivitiesTab />}
      {tab === 'follow-ups' && <FollowUpsTab />}
      {tab === 'partners' && <PartnersTab />}
    </div>
  )
}

// -------------------------------------------------------------
// Agencies
// -------------------------------------------------------------

function AgenciesTab() {
  const { toast } = useToast()
  const [agencies, setAgencies] = useState<AgencySummary[]>([])
  const [offices, setOffices] = useState<AgencyOffice[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ agencyName: '', officeName: '', officeSymbol: '', location: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const res = await crmApi.listAgencies()
      setAgencies(res.items); setNote(res.note)
    } catch (err) { setError(readError(err, 'Could not load agencies.')) }
    finally { setLoading(false) }

    // Offices are supplementary detail on each card. Loaded separately and
    // failure-tolerant on purpose: a problem listing offices must not hide the
    // agency list, which is the point of the tab.
    try { setOffices(await crmApi.listOffices()) }
    catch { setOffices([]) }
  }, [])
  useEffect(() => { void load() }, [load])

  const createOffice = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.agencyName.trim() || !form.officeName.trim()) return
    setSaving(true)
    try {
      await crmApi.createOffice({
        agencyName: form.agencyName.trim(),
        officeName: form.officeName.trim(),
        officeSymbol: form.officeSymbol.trim() || null,
        location: form.location.trim() || null,
      })
      setForm({ agencyName: '', officeName: '', officeSymbol: '', location: '' })
      toast('Office added.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not add the office.'), 'error') }
    finally { setSaving(false) }
  }

  const officeForm = (
    <form onSubmit={createOffice} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-1">Add an agency office</h3>
      <p className="text-[11px] text-gray-600 mb-3">
        An agency appears here as soon as it has an office, a contact or a logged interaction — there is no
        separate agency record to create.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <input aria-label="Office agency" className="input" placeholder="Agency (e.g. Department of Energy)"
          value={form.agencyName} onChange={(e) => setForm({ ...form, agencyName: e.target.value })} />
        <input aria-label="Office name" className="input" placeholder="Office name"
          value={form.officeName} onChange={(e) => setForm({ ...form, officeName: e.target.value })} />
        <input aria-label="Office symbol" className="input" placeholder="Office symbol (optional)"
          value={form.officeSymbol} onChange={(e) => setForm({ ...form, officeSymbol: e.target.value })} />
        <input aria-label="Office location" className="input" placeholder="Location (optional)"
          value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
      </div>
      <button type="submit" disabled={saving || !form.agencyName.trim() || !form.officeName.trim()}
        className="mt-3 text-xs px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50"
        style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
        {saving ? 'Adding…' : 'Add office'}
      </button>
    </form>
  )

  if (loading) return <LoadingPanel label="Loading agencies…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (agencies.length === 0) {
    return (
      <div className="space-y-4">
        {officeForm}
        <EmptyPanel message="No agency relationships yet." hint="Add an office above, or add a contact — either one creates the agency." />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {officeForm}
      {note && <p className="text-[11px] text-gray-600">{note}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {agencies.map((a) => (
          <div key={a.agencyName} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <Building2 className="w-4 h-4 text-gray-500" />
              <span className="text-sm font-medium text-gray-100">{a.agencyName}</span>
            </div>
            <div className="flex gap-4 text-[11px] text-gray-500 font-mono">
              <span>{a.officeCount} office(s)</span>
              <span>{a.contactCount} contact(s)</span>
              <span>{a.activityCount} activity(ies)</span>
            </div>
            <p className="text-[11px] text-gray-600 mt-1.5">
              {a.lastActivityAt ? `Last interaction ${fmtDate(a.lastActivityAt)}` : 'No interactions logged'}
            </p>
            {offices.filter((o) => o.agencyName === a.agencyName).length > 0 && (
              <div className="mt-2 pt-2 border-t border-gray-800 space-y-0.5">
                {offices.filter((o) => o.agencyName === a.agencyName).map((o) => (
                  <p key={o.id} className="text-[11px] text-gray-500">
                    {o.officeName}
                    {o.officeSymbol ? <span className="text-gray-600 font-mono"> · {o.officeSymbol}</span> : null}
                    {o.location ? <span className="text-gray-600"> · {o.location}</span> : null}
                  </p>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// Contacts
// -------------------------------------------------------------

function ContactsTab() {
  const { toast } = useToast()
  const [contacts, setContacts] = useState<GovernmentContact[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState({ agencyName: '', agencyOfficeId: '', fullName: '', title: '', contactRole: 'CONTRACTING_OFFICER' as GovContactRole, email: '', phone: '' })
  const [offices, setOffices] = useState<AgencyOffice[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const [rows, officeRows] = await Promise.all([crmApi.listContacts(), crmApi.listOffices()])
      setContacts(rows); setOffices(officeRows)
    }
    catch (err) { setError(readError(err, 'Could not load contacts.')) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  // Only the offices belonging to the agency the user typed. Offering every
  // office would let someone file a DOE contact under a DoD office.
  const officesForAgency = offices.filter(
    (o) => o.agencyName.trim().toLowerCase() === form.agencyName.trim().toLowerCase(),
  )

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.agencyName.trim() || !form.fullName.trim()) return
    setSaving(true)
    try {
      await crmApi.createContact({
        agencyName: form.agencyName.trim(),
        agencyOfficeId: form.agencyOfficeId || null,
        fullName: form.fullName.trim(),
        title: form.title.trim() || null,
        contactRole: form.contactRole,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
      })
      setForm({ agencyName: '', agencyOfficeId: '', fullName: '', title: '', contactRole: 'CONTRACTING_OFFICER', email: '', phone: '' })
      toast('Contact added.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not add the contact.'), 'error') }
    finally { setSaving(false) }
  }

  if (selectedId) return <ContactDetail contactId={selectedId} onBack={() => { setSelectedId(null); void load() }} />

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Add a government contact</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <input aria-label="Agency" className="input" placeholder="Agency" value={form.agencyName} onChange={(e) => setForm({ ...form, agencyName: e.target.value })} />
          <input aria-label="Full name" className="input" placeholder="Full name" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          <select aria-label="Contact role" className="input" value={form.contactRole} onChange={(e) => setForm({ ...form, contactRole: e.target.value as GovContactRole })}>
            {(Object.keys(CONTACT_ROLE_LABELS) as GovContactRole[]).map((r) => (
              <option key={r} value={r}>{CONTACT_ROLE_LABELS[r]}</option>
            ))}
          </select>
          <input aria-label="Title" className="input" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input aria-label="Email" className="input" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input aria-label="Phone" className="input" placeholder="Phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          <select aria-label="Office" className="input md:col-span-3" value={form.agencyOfficeId}
            onChange={(e) => setForm({ ...form, agencyOfficeId: e.target.value })}
            disabled={officesForAgency.length === 0}>
            <option value="">
              {officesForAgency.length === 0
                ? 'No office recorded for this agency — add one on the Agencies tab (optional)'
                : 'Office (optional)'}
            </option>
            {officesForAgency.map((o) => (
              <option key={o.id} value={o.id}>{o.officeName}</option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={saving || !form.agencyName.trim() || !form.fullName.trim()}
          className="mt-3 text-xs px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50"
          style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
          {saving ? 'Adding…' : 'Add contact'}
        </button>
      </form>

      {loading ? <LoadingPanel label="Loading contacts…" />
        : error ? <ErrorPanel message={error} onRetry={load} />
        : contacts.length === 0 ? <EmptyPanel message="No government contacts yet." hint="Add the contracting officer, specialist or small business specialist you deal with." />
        : (
          <div className="space-y-2">
            {contacts.map((c) => (
              <button key={c.id} onClick={() => setSelectedId(c.id)}
                className="w-full text-left bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-colors">
                <div className="flex items-center gap-2 flex-wrap">
                  <Users className="w-4 h-4 text-gray-500" />
                  <span className="text-sm font-medium text-gray-100">{c.fullName}</span>
                  <ContactRoleBadge role={c.contactRole} />
                  {c.status !== 'ACTIVE' && <Badge tone="warning">{c.status}</Badge>}
                </div>
                <p className="text-[11px] text-gray-500 mt-1">
                  {c.agencyName}{c.agencyOffice ? ` · ${c.agencyOffice.officeName}` : ''}{c.title ? ` · ${c.title}` : ''}
                </p>
                <div className="flex gap-3 text-[11px] text-gray-600 mt-1 font-mono">
                  <span>{c._count?.activities ?? 0} interaction(s)</span>
                  <span>{c._count?.followUps ?? 0} follow-up(s)</span>
                </div>
              </button>
            ))}
          </div>
        )}
    </div>
  )
}

function ContactDetail({ contactId, onBack }: { contactId: string; onBack: () => void }) {
  const { toast } = useToast()
  const [data, setData] = useState<(GovernmentContact & { activities: CrmActivity[]; followUps: CrmFollowUp[]; relationship: RelationshipStrength }) | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [logging, setLogging] = useState(false)
  const [activity, setActivity] = useState({ activityType: 'CALL' as CrmActivityType, subject: '', summary: '', opportunityId: '' })

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setData(await crmApi.getContact(contactId)) }
    catch (err) { setError(readError(err, 'Could not load the contact.')) }
    finally { setLoading(false) }
  }, [contactId])
  useEffect(() => { void load() }, [load])

  const logActivity = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activity.subject.trim() || !data) return
    setLogging(true)
    try {
      await crmApi.createActivity({
        activityType: activity.activityType,
        occurredAt: new Date().toISOString(),
        subject: activity.subject.trim(),
        summary: activity.summary.trim() || null,
        governmentContactId: data.id,
        agencyName: data.agencyName,
        // Optional. Set it and the interaction shows on that opportunity's
        // Relationships panel; leave it and the interaction is still recorded
        // against the contact.
        opportunityId: activity.opportunityId || null,
      })
      setActivity({ activityType: 'CALL', subject: '', summary: '', opportunityId: '' })
      toast('Interaction logged.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not log the interaction.'), 'error') }
    finally { setLogging(false) }
  }

  if (loading) return <LoadingPanel label="Loading contact…" />
  if (error || !data) return <ErrorPanel message={error ?? 'Contact not found.'} onRetry={load} />

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-300">← Back to contacts</button>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-lg font-semibold text-gray-100">{data.fullName}</span>
          <ContactRoleBadge role={data.contactRole} />
          <RelationshipBadge state={data.relationship.state} score={data.relationship.score} />
        </div>
        <p className="text-[12px] text-gray-400 mt-1">
          {data.agencyName}{data.agencyOffice ? ` · ${data.agencyOffice.officeName}` : ''}{data.title ? ` · ${data.title}` : ''}
        </p>
        <div className="flex gap-4 text-[11px] text-gray-500 mt-2">
          {data.email && <span>{data.email}</span>}
          {data.phone && <span>{data.phone}</span>}
        </div>
      </div>

      <RelationshipPanel relationship={data.relationship} />

      <form onSubmit={logActivity} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Log an interaction</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <select aria-label="Activity type" className="input" value={activity.activityType}
            onChange={(e) => setActivity({ ...activity, activityType: e.target.value as CrmActivityType })}>
            {(Object.keys(ACTIVITY_TYPE_LABELS) as CrmActivityType[]).map((t) => (
              <option key={t} value={t}>{ACTIVITY_TYPE_LABELS[t]}</option>
            ))}
          </select>
          <input aria-label="Subject" className="input md:col-span-2" placeholder="What happened?" value={activity.subject}
            onChange={(e) => setActivity({ ...activity, subject: e.target.value })} />
        </div>
        <textarea aria-label="Summary" className="input w-full mt-2" rows={2} placeholder="Summary (optional)"
          value={activity.summary} onChange={(e) => setActivity({ ...activity, summary: e.target.value })} />
        <div className="mt-2">
          <SearchSelect
            label="Link to an opportunity (optional)"
            placeholder="Type to search opportunities…"
            emptyMessage="No opportunity matches that."
            value={activity.opportunityId}
            onChange={(id) => setActivity({ ...activity, opportunityId: id })}
            search={searchOpportunities}
            resolve={resolveOpportunity}
          />
        </div>
        <p className="text-[10px] text-gray-600 mt-1">
          Linked interactions appear on that opportunity&rsquo;s Relationships panel. Linking records history — it
          never moves the pursuit&rsquo;s stage or priority.
        </p>
        <button type="submit" disabled={logging || !activity.subject.trim()}
          className="mt-2 text-xs px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
          {logging ? 'Logging…' : 'Log interaction'}
        </button>
      </form>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Interaction timeline</h3>
        <ActivityTimeline activities={data.activities} />
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// Activities
// -------------------------------------------------------------

function ActivitiesTab() {
  const [activities, setActivities] = useState<CrmActivity[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setActivities(await crmApi.listActivities({ limit: 200 })) }
    catch (err) { setError(readError(err, 'Could not load activities.')) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  if (loading) return <LoadingPanel label="Loading activities…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (activities.length === 0) {
    return <EmptyPanel message="No interactions logged yet." hint="Calls, meetings, industry days and site visits all appear here as one timeline." />
  }
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <ActivityTimeline activities={activities} />
    </div>
  )
}

// -------------------------------------------------------------
// Follow-ups
// -------------------------------------------------------------

function FollowUpsTab() {
  const { toast } = useToast()
  const [followUps, setFollowUps] = useState<CrmFollowUp[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({ title: '', dueAt: '', governmentContactId: '', opportunityId: '' })
  const [saving, setSaving] = useState(false)
  const contacts = useContactOptions()

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try { setFollowUps(await crmApi.listFollowUps()) }
    catch (err) { setError(readError(err, 'Could not load follow-ups.')) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim() || !form.dueAt) return
    setSaving(true)
    try {
      await crmApi.createFollowUp({
        title: form.title.trim(),
        dueAt: new Date(form.dueAt).toISOString(),
        // Both optional. A follow-up linked to a contact counts toward that
        // relationship's strength; one linked to an opportunity shows on its
        // Relationships panel as the next thing due.
        governmentContactId: form.governmentContactId || null,
        opportunityId: form.opportunityId || null,
      })
      setForm({ title: '', dueAt: '', governmentContactId: '', opportunityId: '' })
      toast('Follow-up created. Its owner is reminded by the existing reminder scan.', 'success')
      await load()
    } catch (err) { toast(readError(err, 'Could not create the follow-up.'), 'error') }
    finally { setSaving(false) }
  }

  const transition = async (f: CrmFollowUp, status: 'IN_PROGRESS' | 'DONE' | 'CANCELLED') => {
    try {
      await crmApi.transitionFollowUp(f.id, status)
      await load()
    } catch (err) {
      const e = err as { response?: { status?: number; data?: { allowedNextStates?: string[]; error?: string } } }
      toast(
        e?.response?.status === 422
          ? `${e.response.data?.error} Allowed: ${(e.response.data?.allowedNextStates ?? []).join(', ') || 'none'}`
          : readError(err, 'Could not update the follow-up.'),
        'error',
      )
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Add a follow-up</h3>
        <div className="flex gap-2 flex-wrap">
          <input aria-label="Follow-up title" className="input flex-1 min-w-[240px]" placeholder="e.g. Call the CO next Tuesday"
            value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <input aria-label="Due date" type="date" className="input" value={form.dueAt}
            onChange={(e) => setForm({ ...form, dueAt: e.target.value })} />
          <button type="submit" disabled={saving || !form.title.trim() || !form.dueAt}
            className="text-xs px-4 py-2 rounded text-gray-950 font-medium disabled:opacity-50"
            style={{ background: 'linear-gradient(90deg,#22d3ee,#06b6d4)' }}>
            {saving ? 'Adding…' : 'Add'}
          </button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
          <select aria-label="Link to contact" className="input" value={form.governmentContactId}
            onChange={(e) => setForm({ ...form, governmentContactId: e.target.value })}>
            <option value="">Link to a contact (optional)</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.fullName} — {c.agencyName}</option>
            ))}
          </select>
          <SearchSelect
            label="Link to an opportunity (optional)"
            placeholder="Type to search opportunities…"
            emptyMessage="No opportunity matches that."
            value={form.opportunityId}
            onChange={(id) => setForm({ ...form, opportunityId: id })}
            search={searchOpportunities}
            resolve={resolveOpportunity}
          />
        </div>
        <p className="text-[10px] text-gray-600 mt-1">
          Reminders run on the platform&rsquo;s existing reminder scan — this creates no separate reminder system.
        </p>
      </form>

      {loading ? <LoadingPanel label="Loading follow-ups…" />
        : error ? <ErrorPanel message={error} onRetry={load} />
        : followUps.length === 0 ? <EmptyPanel message="No follow-ups yet." hint="Follow-ups are reminded through the platform's existing reminder scan — no separate system." />
        : (
          <div className="space-y-2">
            {followUps.map((f) => {
              const overdue = f.status !== 'DONE' && f.status !== 'CANCELLED' && new Date(f.dueAt) < new Date()
              return (
                <div key={f.id} className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-[220px]">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CalendarClock className="w-4 h-4 text-gray-500" />
                      <span className="text-sm text-gray-100">{f.title}</span>
                      <Badge tone={f.status === 'DONE' ? 'success' : f.status === 'CANCELLED' ? 'neutral' : 'info'}>{f.status}</Badge>
                      {overdue && <Badge tone="danger">OVERDUE</Badge>}
                    </div>
                    <p className="text-[11px] text-gray-500 mt-1">
                      Due {fmtDate(f.dueAt)}
                      {f.governmentContact ? ` · ${f.governmentContact.fullName}` : ''}
                      {f.partner ? ` · ${f.partner.name}` : ''}
                      {f.opportunity ? ` · ${f.opportunity.title}` : ''}
                    </p>
                  </div>
                  {f.status !== 'DONE' && f.status !== 'CANCELLED' && (
                    <div className="flex gap-2">
                      {f.status === 'OPEN' && (
                        <button onClick={() => transition(f, 'IN_PROGRESS')}
                          className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">Start</button>
                      )}
                      <button onClick={() => transition(f, 'DONE')}
                        className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700">Done</button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
    </div>
  )
}

// -------------------------------------------------------------
// Partners — extends the existing Partner records
// -------------------------------------------------------------

interface PartnerListItem { id: string; name: string; uei?: string | null }

function PartnersTab() {
  const [partners, setPartners] = useState<PartnerListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      // Reads the EXISTING teaming partner list — this view never creates a
      // second partner registry.
      const res = await teamingApi.listPartners({})
      const payload = res as { data?: { partners?: PartnerListItem[] } | PartnerListItem[] }
      const inner = payload?.data
      const rows = Array.isArray(inner) ? inner : (inner?.partners ?? [])
      setPartners(rows as PartnerListItem[])
    } catch (err) { setError(readError(err, 'Could not load partners.')) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  if (selectedId) return <PartnerCrmDetailView partnerId={selectedId} onBack={() => setSelectedId(null)} />
  if (loading) return <LoadingPanel label="Loading partners…" />
  if (error) return <ErrorPanel message={error} onRetry={load} />
  if (partners.length === 0) {
    return (
      <EmptyPanel
        message="No partners yet."
        hint="Partners are managed on the Teaming page; this view adds their people, interactions and relationship strength."
      />
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-gray-600">
        These are the partner records already held on the Teaming page. Nothing here creates a second partner list.
      </p>
      {partners.map((p) => (
        <button key={p.id} onClick={() => setSelectedId(p.id)}
          className="w-full text-left bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-colors">
          <div className="flex items-center gap-2">
            <Users2 className="w-4 h-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-100">{p.name}</span>
            {p.uei && <span className="text-[11px] text-gray-600 font-mono">UEI {p.uei}</span>}
          </div>
        </button>
      ))}
    </div>
  )
}

function PartnerCrmDetailView({ partnerId, onBack }: { partnerId: string; onBack: () => void }) {
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
      <button onClick={onBack} className="text-xs text-gray-500 hover:text-gray-300">← Back to partners</button>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
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

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">People ({data.contacts.length})</h3>
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
            className="text-xs px-4 py-2 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 disabled:opacity-50">
            {saving ? 'Adding…' : 'Add person'}
          </button>
        </form>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Teaming history</h3>
        {data.arrangements.length === 0 ? (
          <p className="text-[12px] text-gray-500">No teaming arrangements recorded.</p>
        ) : (
          <div className="space-y-1.5">
            {data.arrangements.map((a) => (
              <div key={a.id} className="flex items-center gap-2 flex-wrap text-[12px]">
                <Badge tone="neutral">{a.role}</Badge>
                <Badge tone="info">{a.teamingStatus}</Badge>
                <Badge tone={a.agreementStatus === 'SIGNED' ? 'success' : 'neutral'}>{a.agreementStatus}</Badge>
                {a.opportunity && <span className="text-gray-400 truncate max-w-[320px]">{a.opportunity.title}</span>}
              </div>
            ))}
          </div>
        )}
        <p className="text-[10px] text-gray-600 mt-2">
          Teaming arrangements and performance records are managed on the Teaming page. This view reads them; it
          does not change them.
        </p>
      </div>

      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-3">Interaction history</h3>
        <ActivityTimeline activities={data.activities} />
      </div>
    </div>
  )
}

export { CrmPage }

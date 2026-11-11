// =============================================================
// My Company — a contractor's own company profile.
//
// Scores, bid decisions, analysis and proposals use this profile, and are
// refused until its required fields are filled (backend profileGate.ts).
// Every field is edited here. The registration details (UEI, CAGE, NAICS,
// SAM status, set-asides) are saved to the registration profile, so
// Registration & Compliance shows the same values; there is one copy of each.
// The logo comes from Settings → Branding.
// =============================================================
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react'
import { profileApi, type ClientProfileStatus } from '../services/api'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import { PROFILE_STATUS_KEY, fieldHref } from '../hooks/useProfileStatus'

interface Company {
  name: string
  uei: string | null
  cage: string | null
  naicsCodes: string[]
  samRegStatus: string | null
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  eightA: boolean
  streetAddress: string | null
  city: string | null
  state: string | null
  zipCode: string | null
  phone: string | null
  website: string | null
  capabilityKeywords: string[]
  pscCodes: string[]
  contractVehicles: string[]
  employeeCount: number | null
  annualRevenue: string | number | null
  securityClearances: string[]
  isoCertifications: string[]
}

interface Registration {
  uei: string | null
  cageCode: string | null
  naicsCodes: string[]
  samStatus: string | null
  samExpiryDate: string | null
  setAsideCerts: string[]
}

// Same choices as Registration & Compliance.
const SAM_STATUSES = [
  { value: 'ACTIVE', label: 'Active' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'NOT_REGISTERED', label: 'Not registered' },
]
const SET_ASIDES = [
  { value: 'SB', label: 'Small business' },
  { value: 'SDVOSB', label: 'SDVOSB' },
  { value: 'VOSB', label: 'VOSB' },
  { value: 'WOSB', label: 'WOSB' },
  { value: 'HUBZONE', label: 'HUBZone' },
  { value: '8A', label: '8(a)' },
  { value: 'TSB', label: 'TSB' },
]

const LIST_FIELDS = ['capabilityKeywords', 'pscCodes', 'contractVehicles', 'securityClearances', 'isoCertifications'] as const
const TEXT_FIELDS = ['streetAddress', 'city', 'state', 'zipCode', 'phone', 'website'] as const
type Form = Record<
  (typeof LIST_FIELDS)[number] | (typeof TEXT_FIELDS)[number] | 'employeeCount' | 'annualRevenue'
  | 'name' | 'uei' | 'cageCode' | 'naicsCodes' | 'samStatus' | 'samExpiryDate',
  string
> & { setAsideCerts: string[] }

const toForm = (c: Company, r: Registration | null): Form => ({
  name: c.name,
  uei: r?.uei ?? c.uei ?? '',
  cageCode: r?.cageCode ?? c.cage ?? '',
  naicsCodes: (r?.naicsCodes ?? c.naicsCodes).join(', '),
  samStatus: r?.samStatus && SAM_STATUSES.some((s) => s.value === r.samStatus) ? r.samStatus : '',
  samExpiryDate: r?.samExpiryDate ? r.samExpiryDate.slice(0, 10) : '',
  setAsideCerts: r?.setAsideCerts ?? [],
  ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, c[k] ?? ''])),
  ...Object.fromEntries(LIST_FIELDS.map((k) => [k, c[k].join(', ')])),
  employeeCount: c.employeeCount?.toString() ?? '',
  annualRevenue: c.annualRevenue === null ? '' : String(Number(c.annualRevenue)),
}) as Form

const splitList = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v.replace(/[$,\s]/g, '')))

export function MyCompanyPage() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['my-company'], queryFn: profileApi.myCompany })
  const [form, setForm] = useState<Form | null>(null)

  useEffect(() => {
    if (data?.company) setForm(toForm(data.company as Company, (data.registration ?? null) as Registration | null))
  }, [data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => profileApi.saveMyCompany(body),
    onSuccess: (saved) => {
      queryClient.setQueryData(['my-company'], saved)
      void queryClient.invalidateQueries({ queryKey: PROFILE_STATUS_KEY })
      // Registration & Compliance shows the same details.
      void queryClient.invalidateQueries({ queryKey: ['reg-profile'] })
      void queryClient.invalidateQueries({ queryKey: ['reg-health'] })
      toast(saved.status?.complete ? 'Profile complete. Scores and proposals are on.' : 'Profile saved', 'success')
    },
    onError: (err: unknown) => {
      toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not save the profile', 'error')
    },
  })

  if (isLoading || !form) {
    return error
      ? <p className="text-sm text-red-400">Could not load your company profile.</p>
      : <p className="text-sm text-slate-500">Loading your company profile…</p>
  }

  const company = data.company as Company
  const status = data.status as ClientProfileStatus
  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  const missing = new Set(status.missing.map((m) => m.key))

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    const revenue = numberOrNull(form.annualRevenue)
    const employees = numberOrNull(form.employeeCount)
    if ((revenue !== null && Number.isNaN(revenue)) || (employees !== null && Number.isNaN(employees))) {
      toast('Employee count and annual revenue must be numbers', 'error')
      return
    }
    save.mutate({
      name: form.name.trim(),
      uei: form.uei.trim() || null,
      cageCode: form.cageCode.trim() || null,
      naicsCodes: splitList(form.naicsCodes),
      ...(form.samStatus ? { samStatus: form.samStatus } : {}),
      samExpiryDate: form.samExpiryDate ? new Date(`${form.samExpiryDate}T00:00:00.000Z`).toISOString() : null,
      setAsideCerts: form.setAsideCerts,
      ...Object.fromEntries(TEXT_FIELDS.map((k) => [k, form[k].trim() || null])),
      ...Object.fromEntries(LIST_FIELDS.map((k) => [k, splitList(form[k])])),
      employeeCount: employees === null ? null : Math.round(employees),
      annualRevenue: revenue,
    })
  }

  const toggleSetAside = (value: string) => setForm({
    ...form,
    setAsideCerts: form.setAsideCerts.includes(value) ? form.setAsideCerts.filter((v) => v !== value) : [...form.setAsideCerts, value],
  })

  return (
    <div className="max-w-4xl">
      <PageHeader title="My Company" subtitle="Your company profile. Scores, bid decisions, analysis and proposals use it." icon={<Building2 />} />

      <StatusPanel status={status} />

      <form onSubmit={submit} className="space-y-6 mt-6">
        <Section title="Company and registration" note={<>As registered in SAM.gov. These also show in <Link to="/registration" className="underline" style={{ color: 'var(--accent)' }}>Registration &amp; Compliance</Link>.</>}>
          <Field label="Company name" required missing={missing.has('name')}><input className="input" value={form.name} onChange={set('name')} /></Field>
          <Field label="UEI (12 letters or digits)" required missing={missing.has('uei')}><input className="input font-mono" maxLength={12} value={form.uei} onChange={set('uei')} placeholder="e.g. J7M9HPTGJ1S8" /></Field>
          <Field label="CAGE code (5 letters or digits)"><input className="input font-mono" maxLength={5} value={form.cageCode} onChange={set('cageCode')} /></Field>
          <Field label="NAICS codes" required missing={missing.has('naicsCodes')}><input className="input" value={form.naicsCodes} onChange={set('naicsCodes')} placeholder="e.g. 238210, 237130" /></Field>
          <Field label="SAM.gov status" required missing={missing.has('samRegStatus')}>
            <select className="input" value={form.samStatus} onChange={set('samStatus')}>
              <option value="">Choose…</option>
              {SAM_STATUSES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="SAM.gov expiry date"><input className="input" type="date" value={form.samExpiryDate} onChange={set('samExpiryDate')} /></Field>
          <fieldset className="sm:col-span-2">
            <legend><Label text="Small-business and set-aside status" required missing={missing.has('setAsideStatus')} /></legend>
            <p className="text-xs mb-2" style={{ color: 'var(--text-muted)' }}>Choose every one that applies. Saving with none chosen records that none apply.</p>
            <div className="flex flex-wrap gap-2">
              {SET_ASIDES.map((o) => {
                const on = form.setAsideCerts.includes(o.value)
                return (
                  <button key={o.value} type="button" aria-pressed={on} onClick={() => toggleSetAside(o.value)}
                    className="rounded-full px-3 py-1 text-sm border"
                    style={on ? { background: 'var(--accent)', color: '#fff', borderColor: 'var(--accent)' } : { borderColor: 'var(--line-strong)', color: 'var(--text-2)' }}>
                    {o.label}
                  </button>
                )
              })}
            </div>
          </fieldset>
        </Section>

        <Section title="Address and contact">
          <Field label="Street address"><input className="input" value={form.streetAddress} onChange={set('streetAddress')} /></Field>
          <Field label="City"><input className="input" value={form.city} onChange={set('city')} /></Field>
          <Field label="State" required missing={missing.has('state')}><input className="input" value={form.state} onChange={set('state')} placeholder="e.g. TX" /></Field>
          <Field label="ZIP code"><input className="input" value={form.zipCode} onChange={set('zipCode')} /></Field>
          <Field label="Phone"><input className="input" value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Website"><input className="input" value={form.website} onChange={set('website')} /></Field>
        </Section>

        <Section title="Capabilities" note="Separate several entries with commas.">
          <Field label="Capability keywords" required missing={missing.has('capabilityKeywords')} wide>
            <input className="input" value={form.capabilityKeywords} onChange={set('capabilityKeywords')} placeholder="e.g. fiber optic installation, structured cabling" />
          </Field>
          <Field label="PSC codes"><input className="input" value={form.pscCodes} onChange={set('pscCodes')} placeholder="e.g. N059, Z2AA" /></Field>
          <Field label="Contract vehicles"><input className="input" value={form.contractVehicles} onChange={set('contractVehicles')} placeholder="e.g. GSA MAS" /></Field>
          <Field label="Security clearances"><input className="input" value={form.securityClearances} onChange={set('securityClearances')} /></Field>
          <Field label="ISO certifications"><input className="input" value={form.isoCertifications} onChange={set('isoCertifications')} /></Field>
        </Section>

        <Section title="Size">
          <Field label="Employee count"><input className="input" inputMode="numeric" value={form.employeeCount} onChange={set('employeeCount')} /></Field>
          <Field label="Average annual revenue (USD)"><input className="input" inputMode="decimal" value={form.annualRevenue} onChange={set('annualRevenue')} placeholder="e.g. 4500000" /></Field>
        </Section>

        <Section title="Past performance and logo">
          <ReadOnly
            label="Past-performance projects"
            value={missing.has('pastPerformance') ? '' : 'Added'}
            required
            missing={missing.has('pastPerformance')}
            link={{ to: fieldHref('PAST_PERFORMANCE', { clientCompanyId: status.clientCompanyId, isSelf: true }), label: 'Open the past-performance library' }}
          />
          <ReadOnly label="Logo" value="Set in Settings → Branding" link={{ to: '/settings', label: 'Open Settings' }} />
        </Section>

        <div className="flex justify-end">
          <button type="submit" disabled={save.isPending} className="btn-primary px-5 py-2.5 text-sm">
            {save.isPending ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>
    </div>
  )
}

function StatusPanel({ status }: { status: ClientProfileStatus }) {
  return (
    <div className="rounded-xl p-4" style={{ background: status.complete ? 'var(--success-bg)' : 'var(--accent-soft)', border: `1px solid ${status.complete ? 'var(--success-border)' : 'var(--accent-line)'}` }}>
      <div className="flex items-center gap-2">
        {status.complete
          ? <CheckCircle2 className="w-5 h-5" style={{ color: 'var(--success)' }} aria-hidden="true" />
          : <AlertCircle className="w-5 h-5" style={{ color: 'var(--accent)' }} aria-hidden="true" />}
        <p className="text-sm font-semibold" style={{ color: 'var(--text)' }}>
          {status.complete ? `Profile complete (${status.percent}%)` : `Profile ${status.percent}% complete — ${status.missing.length} required ${status.missing.length === 1 ? 'item' : 'items'} missing`}
        </p>
      </div>
      <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--line-strong)' }} aria-hidden="true">
        <div className="h-full rounded-full" style={{ width: `${status.percent}%`, background: status.complete ? 'var(--success)' : 'var(--accent)' }} />
      </div>
      {!status.complete && (
        <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>Required: {status.missing.map((m) => m.label).join(' · ')}</p>
      )}
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</h2>
      {note && <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{note}</p>}
      <div className="grid gap-4 sm:grid-cols-2 mt-4">{children}</div>
    </section>
  )
}

function Label({ text, required, missing }: { text: string; required?: boolean; missing?: boolean }) {
  return (
    <span className="label flex items-center gap-1.5">
      {text}{required && <span aria-label="required" style={{ color: 'var(--danger)' }}>*</span>}
      {missing && <span className="text-[11px] font-normal" style={{ color: 'var(--danger)' }}>needed</span>}
    </span>
  )
}

function Field({ label, required, missing, wide, children }: { label: string; required?: boolean; missing?: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <Label text={label} required={required} missing={missing} />
      {children}
    </label>
  )
}

function ReadOnly({ label, value, required, missing, link }: { label: string; value: string | null; required?: boolean; missing?: boolean; link?: { to: string; label: string } }) {
  return (
    <div>
      <Label text={label} required={required} missing={missing} />
      <p className="text-sm" style={{ color: value ? 'var(--text)' : 'var(--text-dim)' }}>{value || 'Not set yet'}</p>
      {(link || (missing && !link)) && (
        <Link to={link?.to ?? '/registration'} className="text-xs inline-flex items-center gap-1 mt-0.5 underline" style={{ color: 'var(--accent)' }}>
          {link?.label ?? 'Add it in Registration & Compliance'} <ExternalLink className="w-3 h-3" aria-hidden="true" />
        </Link>
      )}
    </div>
  )
}

export default MyCompanyPage

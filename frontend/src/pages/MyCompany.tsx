// =============================================================
// My Company — a contractor's own company profile.
//
// Scores, bid decisions, analysis and proposals use this profile, and are
// refused until its required fields are filled (backend profileGate.ts).
// Every field is edited here. The registration details (UEI, CAGE, NAICS,
// SAM status, set-asides) are saved to the registration profile, so
// Registration & Compliance shows the same values; there is one copy of each.
// Each field is checked as you type (lib/companyFieldRules.ts, the server's
// rules). Past-performance projects and the logo are added here too and are
// saved straight away; the logo is also the firm's branding logo.
// =============================================================
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, CheckCircle2, AlertCircle, ExternalLink, Plus, Upload, Trash2 } from 'lucide-react'
import { profileApi, pastPerformanceApi, type ClientProfileStatus, type PastPerformanceRecord } from '../services/api'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import { PROFILE_STATUS_KEY, fieldHref } from '../hooks/useProfileStatus'
import { stateOptions, toStateCode } from '../lib/usStates'
import * as rules from '../lib/companyFieldRules'

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
  state: toStateCode(c.state) ?? c.state ?? '',
  ...Object.fromEntries(LIST_FIELDS.map((k) => [k, c[k].join(', ')])),
  employeeCount: c.employeeCount?.toString() ?? '',
  annualRevenue: c.annualRevenue === null ? '' : String(Number(c.annualRevenue)),
}) as Form

// What each field must look like; the message shows under the field.
const RULES: Partial<Record<keyof Form, (v: string) => string | null>> = {
  name: rules.companyName,
  uei: rules.uei,
  cageCode: rules.cage,
  naicsCodes: rules.naicsList,
  zipCode: rules.zip,
  phone: rules.phone,
  website: rules.website,
  pscCodes: rules.pscList,
  employeeCount: rules.wholeNumber('Employee count'),
  annualRevenue: rules.dollars('Average annual revenue'),
}

/** Moves focus to the first field showing an error, once it has rendered. */
const focusFirstError = () => setTimeout(() => (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus(), 0)

const splitList = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean)
const numberOrNull = (v: string) => (v.trim() === '' ? null : Number(v.replace(/[$,\s]/g, '')))

export function MyCompanyPage() {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['my-company'], queryFn: profileApi.myCompany })
  const [form, setForm] = useState<Form | null>(null)
  // A field's error shows once it has been left, or after a save attempt.
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const [triedSave, setTriedSave] = useState(false)

  useEffect(() => {
    if (data?.company) setForm(toForm(data.company as Company, (data.registration ?? null) as Registration | null))
  }, [data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => profileApi.saveMyCompany(body),
    onSuccess: (saved) => {
      // Keep the logo, which the save response doesn't carry.
      queryClient.setQueryData(['my-company'], (old: Record<string, unknown> | undefined) => ({ ...old, ...saved }))
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

  const status = data.status as ClientProfileStatus
  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })
  const missing = new Set(status.missing.map((m) => m.key))
  const errors = rules.checkAll(form as unknown as Record<string, string>, RULES as Record<string, (v: string) => string | null>)
  const errorOf = (key: keyof Form) => (triedSave || touched.has(key) ? errors[key] : undefined)
  // Value, change, leave and invalid state for a text input or select.
  const bind = (key: keyof Form, transform?: (v: string) => string) => ({
    value: form[key] as string,
    onChange: (e: { target: { value: string } }) => setForm({ ...form, [key]: transform ? transform(e.target.value) : e.target.value }),
    onBlur: () => setTouched((t) => new Set(t).add(key)),
    'aria-invalid': errorOf(key) ? true : undefined,
  })
  const upper = (v: string) => v.toUpperCase()

  function submit(e: FormEvent) {
    e.preventDefault()
    if (!form) return
    setTriedSave(true)
    const count = Object.keys(errors).length
    if (count > 0) {
      toast(`Fix the ${count === 1 ? 'highlighted field' : `${count} highlighted fields`} before saving`, 'error')
      focusFirstError()
      return
    }
    const revenue = numberOrNull(form.annualRevenue)
    const employees = numberOrNull(form.employeeCount)
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
          <Field label="Company name" required missing={missing.has('name')} error={errorOf('name')}><input className="input" maxLength={120} {...bind('name')} /></Field>
          <Field label="UEI (12 letters or digits)" required missing={missing.has('uei')} error={errorOf('uei')}><input className="input font-mono" maxLength={12} {...bind('uei', upper)} placeholder="e.g. J7M9HPTGJ1S8" /></Field>
          <Field label="CAGE code (5 letters or digits)" error={errorOf('cageCode')}><input className="input font-mono" maxLength={5} {...bind('cageCode', upper)} /></Field>
          <Field label="NAICS codes" required missing={missing.has('naicsCodes')} error={errorOf('naicsCodes')}><input className="input" inputMode="numeric" {...bind('naicsCodes')} placeholder="e.g. 238210, 237130" /></Field>
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
          <Field label="State" required missing={missing.has('state')}>
            <select className="input" value={form.state} onChange={set('state')}>
              <option value="">Choose a state…</option>
              {stateOptions(form.state).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
          <Field label="ZIP code" error={errorOf('zipCode')}><input className="input" inputMode="numeric" maxLength={10} {...bind('zipCode')} placeholder="e.g. 78701" /></Field>
          <Field label="Phone" error={errorOf('phone')}><input className="input" type="tel" {...bind('phone')} placeholder="e.g. (512) 555-0100" /></Field>
          <Field label="Website" error={errorOf('website')}><input className="input" {...bind('website')} placeholder="e.g. example.com" /></Field>
        </Section>

        <Section title="Capabilities" note="Separate several entries with commas.">
          <Field label="Capability keywords" required missing={missing.has('capabilityKeywords')} wide hint="Describe what your company does in your own words, separated by commas. Opportunities that mention them score higher, and AI proposals and document analysis use them.">
            <input className="input" value={form.capabilityKeywords} onChange={set('capabilityKeywords')} placeholder="e.g. fiber optic installation, structured cabling" />
          </Field>
          <Field label="PSC codes" error={errorOf('pscCodes')}><input className="input" {...bind('pscCodes', upper)} placeholder="e.g. N059, Z2AA" /></Field>
          <Field label="Contract vehicles"><input className="input" value={form.contractVehicles} onChange={set('contractVehicles')} placeholder="e.g. GSA MAS" /></Field>
          <Field label="Security clearances"><input className="input" value={form.securityClearances} onChange={set('securityClearances')} /></Field>
          <Field label="ISO certifications"><input className="input" value={form.isoCertifications} onChange={set('isoCertifications')} /></Field>
        </Section>

        <Section title="Size">
          <Field label="Employee count" error={errorOf('employeeCount')}><input className="input" inputMode="numeric" {...bind('employeeCount')} /></Field>
          <Field label="Average annual revenue (USD)" error={errorOf('annualRevenue')}><input className="input" inputMode="decimal" {...bind('annualRevenue')} placeholder="e.g. 4500000" /></Field>
        </Section>

        <div className="flex justify-end">
          <button type="submit" disabled={save.isPending} className="btn-primary px-5 py-2.5 text-sm">
            {save.isPending ? 'Saving…' : 'Save profile'}
          </button>
        </div>
      </form>

      <div className="space-y-6 mt-6">
        <PastPerformanceSection selfId={status.clientCompanyId} missing={missing.has('pastPerformance')} />
        <LogoSection logoUrl={(data.logoUrl as string | null | undefined) ?? null} />
      </div>
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

function Field({ label, required, missing, wide, hint, error, children }: { label: string; required?: boolean; missing?: boolean; wide?: boolean; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className={`block ${wide ? 'sm:col-span-2' : ''}`}>
      <Label text={label} required={required} missing={missing} />
      {children}
      {error && <span role="alert" className="block text-xs mt-1" style={{ color: 'var(--danger)' }}>{error}</span>}
      {hint && <span className="block text-xs mt-1" style={{ color: 'var(--text-muted)' }}>{hint}</span>}
    </label>
  )
}

// ---- Past performance --------------------------------------------------

const EMPTY_PROJECT = { contractNumber: '', customerName: '', customerAgency: '', totalValue: '', start: '', end: '', scopeSummary: '' }
type ProjectForm = typeof EMPTY_PROJECT

const PROJECT_RULES: Partial<Record<keyof ProjectForm, (v: string) => string | null>> = {
  contractNumber: rules.required('Contract number'),
  customerName: rules.required('Customer'),
  totalValue: rules.dollars('Contract value'),
}

const money = (v: string | null) => (v === null ? null : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })}`)
const year = (v: string | null) => (v ? new Date(v).getUTCFullYear() : null)

/**
 * Past-performance projects. At least one is required; scoring, the bid
 * decision and proposals cite them. Saved straight away, separate from the
 * profile form. Editing and archiving stay in the library.
 */
function PastPerformanceSection({ selfId, missing }: { selfId: string | null; missing: boolean }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['past-performance', 'my-company'], queryFn: () => pastPerformanceApi.list() })
  const records = ((data?.data ?? []) as (PastPerformanceRecord & { isArchived?: boolean })[]).filter((r) => !r.isArchived)
  const [adding, setAdding] = useState(false)
  const [project, setProject] = useState<ProjectForm>(EMPTY_PROJECT)
  const [tried, setTried] = useState(false)

  const errors: Partial<Record<keyof ProjectForm, string>> = rules.checkAll(project, PROJECT_RULES)
  if (project.start && project.end && project.end < project.start) errors.end = 'The end date must be after the start date'
  const errorOf = (k: keyof ProjectForm) => (tried ? errors[k] : undefined)
  const bind = (k: keyof ProjectForm) => ({
    value: project[k],
    onChange: (e: { target: { value: string } }) => setProject({ ...project, [k]: e.target.value }),
    'aria-invalid': errorOf(k) ? true : undefined,
  })

  const add = useMutation({
    mutationFn: () => {
      const value = project.totalValue.replace(/[$,\s]/g, '')
      const iso = (d: string) => (d ? new Date(`${d}T00:00:00.000Z`).toISOString() : null)
      return pastPerformanceApi.create({
        clientCompanyId: selfId,
        contractNumber: project.contractNumber.trim(),
        customerName: project.customerName.trim(),
        customerAgency: project.customerAgency.trim() || null,
        totalValue: value ? Number(value) : null,
        periodOfPerformanceStart: iso(project.start),
        periodOfPerformanceEnd: iso(project.end),
        scopeSummary: project.scopeSummary.trim(),
      })
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['past-performance'] })
      void queryClient.invalidateQueries({ queryKey: ['my-company'] })
      void queryClient.invalidateQueries({ queryKey: PROFILE_STATUS_KEY })
      toast('Project added', 'success')
      setProject(EMPTY_PROJECT); setTried(false); setAdding(false)
    },
    onError: (err: unknown) => toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'Could not add the project', 'error'),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    setTried(true)
    if (Object.keys(errors).length > 0) { focusFirstError(); return }
    add.mutate()
  }

  return (
    <section className="card" aria-labelledby="pp-heading">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="pp-heading" className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--text)' }}>
            Past-performance projects <span aria-label="required" style={{ color: 'var(--danger)' }}>*</span>
            {missing && <span className="text-[11px] font-normal" style={{ color: 'var(--danger)' }}>at least one needed</span>}
          </h2>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Contracts you have delivered. Scores, bid decisions and proposals cite them. Saved as soon as you add one.</p>
        </div>
        {!adding && (
          <button type="button" onClick={() => setAdding(true)} className="btn-secondary px-3 py-1.5 text-sm inline-flex items-center gap-1.5 shrink-0">
            <Plus className="w-4 h-4" aria-hidden="true" /> Add project
          </button>
        )}
      </div>

      {records.length > 0 ? (
        <ul className="mt-4 divide-y" style={{ borderColor: 'var(--line)' }}>
          {records.map((r) => (
            <li key={r.id} className="py-2 text-sm flex flex-wrap gap-x-3 gap-y-0.5" style={{ color: 'var(--text)' }}>
              <span className="font-medium">{r.customerName}</span>
              <span className="font-mono text-xs self-center" style={{ color: 'var(--text-muted)' }}>{r.contractNumber}</span>
              {[money(r.totalValue), [year(r.periodOfPerformanceStart), year(r.periodOfPerformanceEnd)].filter(Boolean).join('–') || null]
                .filter(Boolean).map((t) => <span key={t} className="text-xs self-center" style={{ color: 'var(--text-muted)' }}>{t}</span>)}
            </li>
          ))}
        </ul>
      ) : !adding && (
        <p className="text-sm mt-4" style={{ color: 'var(--text-dim)' }}>No projects yet.</p>
      )}

      {adding && (
        <form onSubmit={submit} noValidate className="mt-4 rounded-lg p-4 space-y-4" style={{ border: '1px solid var(--line-strong)' }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Contract number" required error={errorOf('contractNumber')}><input className="input font-mono" maxLength={120} {...bind('contractNumber')} placeholder="e.g. W91QUZ-23-C-0042" /></Field>
            <Field label="Customer" required error={errorOf('customerName')}><input className="input" maxLength={300} {...bind('customerName')} placeholder="e.g. U.S. Army Corps of Engineers" /></Field>
            <Field label="Agency"><input className="input" maxLength={300} {...bind('customerAgency')} placeholder="e.g. Department of Defense" /></Field>
            <Field label="Contract value (USD)" error={errorOf('totalValue')}><input className="input" inputMode="decimal" {...bind('totalValue')} placeholder="e.g. 1250000" /></Field>
            <Field label="Start date"><input className="input" type="date" {...bind('start')} /></Field>
            <Field label="End date" error={errorOf('end')}><input className="input" type="date" {...bind('end')} /></Field>
            <Field label="What you delivered" wide><textarea className="input" rows={3} maxLength={5000} {...bind('scopeSummary')} placeholder="Scope of the work and the results" /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setAdding(false); setProject(EMPTY_PROJECT); setTried(false) }} className="btn-secondary px-4 py-2 text-sm">Cancel</button>
            <button type="submit" disabled={add.isPending} className="btn-primary px-4 py-2 text-sm">{add.isPending ? 'Adding…' : 'Add project'}</button>
          </div>
        </form>
      )}

      <Link to={fieldHref('PAST_PERFORMANCE', { clientCompanyId: selfId, isSelf: true })} className="text-xs inline-flex items-center gap-1 mt-3 underline" style={{ color: 'var(--accent)' }}>
        Edit or archive projects, or add CPARS ratings, in the library <ExternalLink className="w-3 h-3" aria-hidden="true" />
      </Link>
    </section>
  )
}

// ---- Logo ----------------------------------------------------------------

const API_BASE = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_API_URL || 'http://localhost:3001'
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']
const LOGO_MAX_BYTES = 2 * 1024 * 1024
const fullUrl = (url: string) => (/^https?:\/\//.test(url) ? url : `${API_BASE}${url}`)

/** The company logo, also the firm's branding logo. Saved straight away. */
function LogoSection({ logoUrl }: { logoUrl: string | null }) {
  const { toast } = useToast()
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['my-company'] })
    void queryClient.invalidateQueries({ queryKey: PROFILE_STATUS_KEY })
  }
  const failed = (fallback: string) => (err: unknown) =>
    toast((err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback, 'error')
  const upload = useMutation({ mutationFn: profileApi.uploadMyCompanyLogo, onSuccess: () => { refresh(); toast('Logo uploaded', 'success') }, onError: failed('Could not upload the logo') })
  const remove = useMutation({ mutationFn: profileApi.removeMyCompanyLogo, onSuccess: () => { refresh(); toast('Logo removed', 'success') }, onError: failed('Could not remove the logo') })

  function choose(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    if (!LOGO_TYPES.includes(file.type)) { toast('The logo must be a PNG, JPEG, SVG or WebP image', 'error'); return }
    if (file.size > LOGO_MAX_BYTES) { toast(`The logo must be 2 MB or smaller (this one is ${(file.size / 1024 / 1024).toFixed(1)} MB)`, 'error'); return }
    upload.mutate(file)
  }

  return (
    <section className="card" aria-labelledby="logo-heading">
      <h2 id="logo-heading" className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Logo</h2>
      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>Shown on your proposals and branding. PNG, JPEG, SVG or WebP, up to 2 MB. Saved as soon as you upload it.</p>
      <div className="flex items-center gap-4 mt-4">
        <div className="w-24 h-24 rounded-lg flex items-center justify-center overflow-hidden shrink-0" style={{ border: '1px solid var(--line-strong)', background: 'var(--bg-2)' }}>
          {logoUrl
            ? <img src={fullUrl(logoUrl)} alt="Company logo" className="max-w-full max-h-full object-contain" />
            : <span className="text-xs" style={{ color: 'var(--text-dim)' }}>No logo</span>}
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept={LOGO_TYPES.join(',')} className="hidden" onChange={choose} aria-label="Logo file" />
          <button type="button" onClick={() => input.current?.click()} disabled={upload.isPending} className="btn-secondary px-3 py-1.5 text-sm inline-flex items-center gap-1.5">
            <Upload className="w-4 h-4" aria-hidden="true" /> {upload.isPending ? 'Uploading…' : logoUrl ? 'Replace logo' : 'Upload logo'}
          </button>
          {logoUrl && (
            <button type="button" onClick={() => remove.mutate()} disabled={remove.isPending} className="btn-secondary px-3 py-1.5 text-sm inline-flex items-center gap-1.5">
              <Trash2 className="w-4 h-4" aria-hidden="true" /> Remove
            </button>
          )}
        </div>
      </div>
    </section>
  )
}

export default MyCompanyPage

import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { demoApi, type DemoAccountType, type DemoCredentials } from '../demo/demoApi'

const errorText = (err: unknown): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'That did not work. Please try again.'

const DEFAULT_DAYS = 14
const EMPTY_FORM = { companyName: '', contactName: '', email: '', businessType: '', state: '', otherLocation: '', days: DEFAULT_DAYS, accountType: 'CONSULTING' as DemoAccountType }

const ACCOUNT_TYPE_LABEL: Record<DemoAccountType, string> = { CONSULTING: 'Consulting firm', CONTRACTOR: 'Contractor' }

const OTHER = 'OTHER'

/** Operators create the demo accounts they hand to clients. */
export default function DemoAdminPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['demo-accounts'], queryFn: demoApi.list })
  const [form, setForm] = useState(EMPTY_FORM)
  const [credentials, setCredentials] = useState<DemoCredentials | null>(null)
  const [message, setMessage] = useState('')
  const [notice, setNotice] = useState('')

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['demo-accounts'] })

  const create = useMutation({
    mutationFn: demoApi.create,
    onSuccess: (created) => {
      setCredentials({ email: created.email, password: created.password })
      setForm(EMPTY_FORM)
      setMessage('')
      void refresh()
    },
    onError: (err) => setMessage(errorText(err)),
  })

  const act = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      setMessage('')
      void refresh()
    },
    onError: (err) => setMessage(errorText(err)),
  })

  const changeType = useMutation({
    mutationFn: ({ firmId, accountType }: { firmId: string; accountType: DemoAccountType }) => demoApi.setAccountType(firmId, accountType),
    onSuccess: (result) => {
      setMessage('')
      setNotice(
        !result.changed ? 'No change: the account already has that type.'
          : result.accountType === 'CONTRACTOR'
            ? `Now a contractor. ${result.archivedClients} client(s) archived, not deleted; switching back restores them. The user sees the change on their next page load.`
            : `Now a consulting firm. ${result.restoredClients} client(s) restored. The user sees the change on their next page load.`,
      )
      void refresh()
    },
    onError: (err) => setMessage(errorText(err)),
  })

  const reset = useMutation({
    mutationFn: demoApi.resetPassword,
    onSuccess: setCredentials,
    onError: (err) => setMessage(errorText(err)),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    const { otherLocation, ...fields } = form
    create.mutate(form.state === OTHER ? { ...fields, otherLocation } : fields)
  }

  const input = 'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100'

  if (error) return <p className="text-sm text-slate-400">Only Bytescon operators can use this page.</p>

  return (
    <div className="space-y-6 max-w-5xl">
      <h1 className="text-xl font-semibold">Demo accounts</h1>

      {data?.pool && (
        <p role={data.pool.ok === false ? 'alert' : undefined} className={`text-sm ${data.pool.ok === false ? 'text-red-400' : 'text-slate-400'}`}>
          {data.pool.ok === null
            ? 'SAM.gov has not been pulled yet. Accounts show invented notices until it has.'
            : data.pool.ok
              ? `Last SAM.gov pull ${new Date(data.pool.lastPullAt as string).toLocaleString()}: ${data.pool.openNotices} open notices in the pool.`
              : `The last SAM.gov pull failed (${new Date(data.pool.lastPullAt as string).toLocaleString()}): ${data.pool.error}. Accounts keep what they have (${data.pool.openNotices} real notices in the pool, or invented ones). Check SAM_API_KEY on Render; SAM.gov keys expire and must be regenerated.`}
        </p>
      )}

      <form onSubmit={submit} className="card grid gap-3 sm:grid-cols-2">
        <label className="text-xs text-slate-400">Company
          <input aria-label="Company" className={`${input} mt-1`} required value={form.companyName} onChange={(e) => setForm({ ...form, companyName: e.target.value })} />
        </label>
        <label className="text-xs text-slate-400">Contact name
          <input aria-label="Contact name" className={`${input} mt-1`} required value={form.contactName} onChange={(e) => setForm({ ...form, contactName: e.target.value })} />
        </label>
        <label className="text-xs text-slate-400">Email (their login)
          <input aria-label="Email" type="email" className={`${input} mt-1`} required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </label>
        <label className="text-xs text-slate-400">Account type
          <select aria-label="Account type" className={`${input} mt-1`} value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value as DemoAccountType })}>
            <option value="CONSULTING">Consulting firm (serves clients)</option>
            <option value="CONTRACTOR">Contractor (bids for its own company)</option>
          </select>
        </label>
        <label className="text-xs text-slate-400">Business type
          <select aria-label="Business type" className={`${input} mt-1`} required value={form.businessType} onChange={(e) => setForm({ ...form, businessType: e.target.value })}>
            <option value="">Select a business type</option>
            {data?.businessTypes.map((type) => <option key={type.key} value={type.key}>{type.label}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-400">State
          <select aria-label="State" className={`${input} mt-1`} required value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value })}>
            <option value="">Select a state</option>
            {data?.states.map((state) => <option key={state.code} value={state.code}>{state.name}</option>)}
            <option value={OTHER}>Other</option>
          </select>
        </label>
        {form.state === OTHER && (
          <label className="text-xs text-slate-400">Other location
            <input aria-label="Other location" className={`${input} mt-1`} required maxLength={40} placeholder="For example, Puerto Rico" value={form.otherLocation} onChange={(e) => setForm({ ...form, otherLocation: e.target.value })} />
          </label>
        )}
        <label className="text-xs text-slate-400">Days until it ends
          <input aria-label="Days" type="number" min={1} max={90} className={`${input} mt-1`} required value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" disabled={create.isPending} className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-60">
            {create.isPending ? 'Generating…' : 'Generate'}
          </button>
        </div>
      </form>

      {message && <p role="alert" className="text-sm text-red-400">{message}</p>}
      {notice && <p role="status" className="text-sm text-slate-300">{notice}</p>}

      {credentials && (
        <div role="status" className="card border border-cyan-700">
          <p className="text-sm font-medium">Send these to the client. The password won’t be shown again.</p>
          <dl className="mt-2 text-sm text-slate-200 space-y-1">
            <div>Website: https://demo.bytesgov.com</div>
            <div>Email: {credentials.email}</div>
            <div>Password: <code>{credentials.password}</code></div>
          </dl>
        </div>
      )}

      <div className="card overflow-x-auto">
        {isLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : data?.accounts.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="py-2 pr-4">Company</th><th className="pr-4">Account type</th><th className="pr-4">Business type</th><th className="pr-4">Login</th><th className="pr-4">Ends</th><th className="pr-4">Status</th><th /></tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <tr key={account.firmId} className="border-t border-slate-800">
                  <td className="py-2 pr-4 text-slate-100">{account.companyName}</td>
                  <td className="pr-4">
                    <select
                      aria-label={`Account type for ${account.companyName}`}
                      className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                      value={account.accountType}
                      disabled={changeType.isPending}
                      onChange={(e) => changeType.mutate({ firmId: account.firmId, accountType: e.target.value as DemoAccountType })}
                    >
                      {(Object.keys(ACCOUNT_TYPE_LABEL) as DemoAccountType[]).map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABEL[t]}</option>)}
                    </select>
                  </td>
                  <td className="pr-4 text-slate-300">{account.businessType ?? 'Mixed'}</td>
                  <td className="pr-4 text-slate-300">{account.email}</td>
                  <td className="pr-4 text-slate-300">{new Date(account.expiresAt).toLocaleDateString()}</td>
                  <td className="pr-4">{account.expired ? <span className="text-red-400">Ended</span> : <span className="text-green-400">Active</span>}</td>
                  <td className="py-2 whitespace-nowrap text-xs space-x-3">
                    <button type="button" className="text-cyan-400 hover:underline" onClick={() => act.mutate(() => demoApi.extend(account.firmId, DEFAULT_DAYS))}>Add {DEFAULT_DAYS} days from today</button>
                    <button type="button" className="text-cyan-400 hover:underline" onClick={() => reset.mutate(account.firmId)}>New password</button>
                    {!account.expired && <button type="button" className="text-red-400 hover:underline" onClick={() => act.mutate(() => demoApi.end(account.firmId))}>End now</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-slate-400">No demo accounts yet.</p>
        )}
      </div>
    </div>
  )
}

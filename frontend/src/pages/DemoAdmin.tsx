import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { demoApi, type DemoCredentials } from '../demo/demoApi'

const errorText = (err: unknown): string =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? 'That did not work. Please try again.'

const DEFAULT_DAYS = 14

/** Operators create the demo accounts they hand to clients. */
export default function DemoAdminPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['demo-accounts'], queryFn: demoApi.list })
  const [form, setForm] = useState({ companyName: '', contactName: '', email: '', days: DEFAULT_DAYS })
  const [credentials, setCredentials] = useState<DemoCredentials | null>(null)
  const [standard, setStandard] = useState<DemoCredentials[] | null>(null)
  const [message, setMessage] = useState('')

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['demo-accounts'] })

  const create = useMutation({
    mutationFn: demoApi.create,
    onSuccess: (created) => {
      setCredentials({ email: created.email, password: created.password })
      setForm({ companyName: '', contactName: '', email: '', days: DEFAULT_DAYS })
      setMessage('')
      void refresh()
    },
    onError: (err) => setMessage(errorText(err)),
  })

  const createStandard = useMutation({
    mutationFn: demoApi.createStandard,
    onSuccess: (created) => {
      setStandard(created)
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

  const reset = useMutation({
    mutationFn: demoApi.resetPassword,
    onSuccess: setCredentials,
    onError: (err) => setMessage(errorText(err)),
  })

  function submit(e: FormEvent) {
    e.preventDefault()
    create.mutate(form)
  }

  const input = 'w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100'

  if (error) return <p className="text-sm text-slate-400">Only Bytescon operators can use this page.</p>

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Demo accounts</h1>
        <button type="button" disabled={createStandard.isPending} onClick={() => createStandard.mutate()} className="btn-primary text-sm">
          {createStandard.isPending ? 'Creating…' : 'Create the 5 standard accounts'}
        </button>
      </div>

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
        <label className="text-xs text-slate-400">Days until it ends
          <input aria-label="Days" type="number" min={1} max={90} className={`${input} mt-1`} required value={form.days} onChange={(e) => setForm({ ...form, days: Number(e.target.value) })} />
        </label>
        <div className="sm:col-span-2">
          <button type="submit" disabled={create.isPending} className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-60">
            {create.isPending ? 'Creating…' : 'Create demo account'}
          </button>
        </div>
      </form>

      {message && <p role="alert" className="text-sm text-red-400">{message}</p>}

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

      {standard && (
        <div role="status" className="card">
          {standard.length ? (
            <>
              <p className="text-sm font-medium">Save these now. The passwords won’t be shown again.</p>
              <table className="mt-2 text-sm">
                <tbody>
                  {standard.map((account) => (
                    <tr key={account.email}><td className="pr-6 py-1">{account.email}</td><td><code>{account.password}</code></td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="text-sm">All 5 standard accounts already exist. Use New password to get a login again.</p>
          )}
        </div>
      )}

      <div className="card overflow-x-auto">
        {isLoading ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : data?.accounts.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-500">
              <tr><th className="py-2 pr-4">Company</th><th className="pr-4">Login</th><th className="pr-4">Ends</th><th className="pr-4">Status</th><th /></tr>
            </thead>
            <tbody>
              {data.accounts.map((account) => (
                <tr key={account.firmId} className="border-t border-slate-800">
                  <td className="py-2 pr-4 text-slate-100">{account.companyName}</td>
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

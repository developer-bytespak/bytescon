import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { docRequirementsApi, clientsApi } from '../services/api'
import { PageHeader, SkeletonRows, ErrorBanner, EmptyState, formatCurrency } from '../components/ui'
import { Plus, CheckCircle, AlertTriangle, Clock, X } from 'lucide-react'

function UrgencyTag({ dueDate, status }: { dueDate: string; status: string }) {
  if (status === 'SUBMITTED') return (
    <span className="chip chip-success whitespace-nowrap">
      <CheckCircle className="w-3 h-3" /> Submitted
    </span>
  )
  const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000)
  if (days < 0) return (
    <span className="chip chip-danger whitespace-nowrap">
      <AlertTriangle className="w-3 h-3" /> OVERDUE
    </span>
  )
  if (days <= 7) return (
    <span className="chip chip-danger whitespace-nowrap tabular-nums">
      <AlertTriangle className="w-3 h-3" /> {days}d — URGENT
    </span>
  )
  if (days <= 14) return (
    <span className="chip chip-gold whitespace-nowrap tabular-nums">
      <Clock className="w-3 h-3" /> {days}d remaining
    </span>
  )
  return (
    <span className="chip chip-neutral whitespace-nowrap tabular-nums">
      {days}d remaining
    </span>
  )
}

export function DocRequirementsPage() {
  const qc = useQueryClient()
  const [showCreate, setShowCreate] = useState(false)
  const [filterClient, setFilterClient] = useState('')
  const [form, setForm] = useState({
    clientCompanyId: '',
    title: '',
    description: '',
    dueDate: '',
    penaltyType: 'flat' as 'flat' | 'percent',
    penaltyAmount: '',
    penaltyPercent: '',
    isPenaltyEnabled: true,
  })
  const [formError, setFormError] = useState('')

  const { data: clientsData } = useQuery({
    queryKey: ['clients'],
    queryFn: () => clientsApi.list({ limit: 200 }),
  })

  const { data, isLoading, error } = useQuery({
    queryKey: ['doc-requirements', filterClient],
    queryFn: () => docRequirementsApi.list(filterClient ? { clientCompanyId: filterClient } : undefined),
  })

  const createMutation = useMutation({
    mutationFn: (body: any) => docRequirementsApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['doc-requirements'] })
      setShowCreate(false)
      setForm({ clientCompanyId: '', title: '', description: '', dueDate: '', penaltyType: 'flat', penaltyAmount: '', penaltyPercent: '', isPenaltyEnabled: true })
      setFormError('')
    },
    onError: (err: any) => setFormError(err?.response?.data?.error || 'Create failed'),
  })

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: any }) => docRequirementsApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['doc-requirements'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => docRequirementsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['doc-requirements'] }),
  })

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    setFormError('')
    createMutation.mutate({
      clientCompanyId: form.clientCompanyId,
      title: form.title,
      description: form.description || undefined,
      dueDate: form.dueDate,
      isPenaltyEnabled: form.isPenaltyEnabled,
      penaltyAmount: form.isPenaltyEnabled && form.penaltyType === 'flat' && form.penaltyAmount ? form.penaltyAmount : undefined,
      penaltyPercent: form.isPenaltyEnabled && form.penaltyType === 'percent' && form.penaltyPercent ? form.penaltyPercent : undefined,
    })
  }

  const requirements = data?.data ?? []
  const clients = clientsData?.data ?? []

  return (
    <div>
      <PageHeader title="Document Requirements" subtitle="Set deadlines and manage client document submissions">
        <button onClick={() => setShowCreate(!showCreate)} className="btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Requirement
        </button>
      </PageHeader>

      {/* Create Form */}
      {showCreate && (
        <div className="card mb-6 animate-fade-up">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-gray-200">New Document Requirement</h2>
            <button onClick={() => setShowCreate(false)} aria-label="Close" className="btn-ghost btn-sm !px-1.5">
              <X className="w-4 h-4" />
            </button>
          </div>
          <form onSubmit={handleCreate} className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Client *</label>
              <select
                className="input"
                value={form.clientCompanyId}
                onChange={(e) => setForm({ ...form, clientCompanyId: e.target.value })}
                required
              >
                <option value="">Select client...</option>
                {clients.map((c: any) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">Document Title *</label>
              <input
                className="input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="e.g. SF330 Qualifications Package"
                required
              />
            </div>
            <div>
              <label className="label">Due Date *</label>
              <input
                type="date"
                className="input"
                value={form.dueDate}
                onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
                required
              />
            </div>
            <div>
              <label className="label">Description</label>
              <input
                className="input"
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                placeholder="Optional notes..."
              />
            </div>

            {/* Penalty config */}
            <div className="md:col-span-2">
              <label className="flex items-center gap-2 cursor-pointer mb-3">
                <input
                  type="checkbox"
                  checked={form.isPenaltyEnabled}
                  onChange={(e) => setForm({ ...form, isPenaltyEnabled: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-600 bg-gray-800 text-blue-500"
                />
                <span className="text-sm text-gray-300">Enable late submission penalty</span>
              </label>

              {form.isPenaltyEnabled && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pl-6">
                  <div>
                    <label className="label">Penalty Type</label>
                    <div className="flex gap-3">
                      {['flat', 'percent'].map((t) => (
                        <label key={t} className="flex items-center gap-2 cursor-pointer">
                          <input
                            type="radio"
                            name="penaltyType"
                            value={t}
                            checked={form.penaltyType === t}
                            onChange={() => setForm({ ...form, penaltyType: t as 'flat' | 'percent' })}
                          />
                          <span className="text-sm text-gray-300">
                            {t === 'flat' ? 'Flat Fee ($)' : 'Percentage (%)'}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                  {form.penaltyType === 'flat' ? (
                    <div>
                      <label className="label">Flat Fee Amount ($)</label>
                      <input
                        type="number"
                        className="input"
                        value={form.penaltyAmount}
                        onChange={(e) => setForm({ ...form, penaltyAmount: e.target.value })}
                        placeholder="e.g. 500"
                        min="0"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="label">Percentage of Contract Value (%)</label>
                      <input
                        type="number"
                        className="input"
                        value={form.penaltyPercent}
                        onChange={(e) => setForm({ ...form, penaltyPercent: e.target.value })}
                        placeholder="e.g. 2.5"
                        min="0"
                        max="100"
                        step="0.1"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {formError && <div className="md:col-span-2"><ErrorBanner message={formError} /></div>}

            <div className="md:col-span-2 flex flex-wrap gap-2">
              <button type="submit" disabled={createMutation.isPending} className="btn-primary">
                {createMutation.isPending ? 'Creating...' : 'Create Requirement'}
              </button>
              <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Filter */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <select
          className="input sm:max-w-xs text-sm"
          value={filterClient}
          onChange={(e) => setFilterClient(e.target.value)}
        >
          <option value="">All Clients</option>
          {clients.map((c: any) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {isLoading && <div className="card !py-2"><SkeletonRows rows={6} cols={5} /></div>}
      {error && <ErrorBanner message="Failed to load requirements" />}
      {!isLoading && requirements.length === 0 && (
        <EmptyState message="No document requirements yet. Create one for a client." />
      )}

      {requirements.length > 0 && (
      <div className="table-wrap max-h animate-fade-in">
        <table className="data-table">
          <thead>
            <tr>
              <th>Requirement</th>
              <th>Client / due</th>
              <th>Status</th>
              <th>Penalty</th>
              <th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
        {requirements.map((req: any) => (
          <tr key={req.id}>
            <td className="min-w-[14rem] max-w-md">
                <h3 className="font-semibold text-gray-200 text-sm">{req.title}</h3>
                {req.opportunity && (
                  <p className="text-xs text-gray-600 mt-0.5">Linked opportunity: {req.opportunity.title}</p>
                )}
                {req.description && (
                  <p className="text-xs text-gray-400 mt-1">{req.description}</p>
                )}
            </td>
            <td className="min-w-[12rem]">
                <p className="text-xs text-gray-500 tabular-nums">
                  Client: <span className="text-gray-400">{req.clientCompany?.name}</span>
                  {' · '}
                  Due: {new Date(req.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
            </td>
            <td>
                  <UrgencyTag dueDate={req.dueDate} status={req.status} />
            </td>
            <td className="min-w-[10rem]">
                {req.isPenaltyEnabled && (
                  <p className="text-xs text-red-400/70 tabular-nums">
                    Penalty: {req.penaltyAmount ? formatCurrency(Number(req.penaltyAmount)) + ' flat fee' :
                      req.penaltyPercent ? `${req.penaltyPercent}% of contract value` : 'enabled'}
                  </p>
                )}
            </td>
            <td className="text-right">
              <div className="flex items-center justify-end gap-2">
                {req.status === 'PENDING' && (
                  <button
                    onClick={() => updateMutation.mutate({ id: req.id, data: { status: 'SUBMITTED' } })}
                    disabled={updateMutation.isPending}
                    className="btn-secondary btn-sm whitespace-nowrap"
                  >
                    Mark Submitted
                  </button>
                )}
                <button
                  onClick={() => { if (window.confirm('Delete this requirement?')) deleteMutation.mutate(req.id) }}
                  aria-label="Delete requirement"
                  className="btn-ghost btn-sm !px-1.5 text-gray-600 hover:text-red-400"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </td>
          </tr>
        ))}
          </tbody>
        </table>
      </div>
      )}
    </div>
  )
}

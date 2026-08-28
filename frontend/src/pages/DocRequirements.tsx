import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { docRequirementsApi, clientsApi } from '../services/api'
import { PageHeader, Spinner, ErrorBanner, EmptyState, formatCurrency } from '../components/ui'
import { Plus, CheckCircle, AlertTriangle, Clock, X } from 'lucide-react'

function UrgencyTag({ dueDate, status }: { dueDate: string; status: string }) {
  if (status === 'SUBMITTED') return (
    <span className="inline-flex items-center gap-1 text-xs bg-green-900/40 text-green-300 border border-green-700 px-2 py-0.5 rounded">
      <CheckCircle className="w-3 h-3" /> Submitted
    </span>
  )
  const days = Math.ceil((new Date(dueDate).getTime() - Date.now()) / 86400000)
  if (days < 0) return (
    <span className="inline-flex items-center gap-1 text-xs bg-red-900/40 text-red-300 border border-red-700 px-2 py-0.5 rounded">
      <AlertTriangle className="w-3 h-3" /> OVERDUE
    </span>
  )
  if (days <= 7) return (
    <span className="inline-flex items-center gap-1 text-xs bg-orange-900/40 text-orange-300 border border-orange-700 px-2 py-0.5 rounded">
      <AlertTriangle className="w-3 h-3" /> {days}d — URGENT
    </span>
  )
  if (days <= 14) return (
    <span className="inline-flex items-center gap-1 text-xs bg-yellow-900/40 text-yellow-300 border border-yellow-700 px-2 py-0.5 rounded">
      <Clock className="w-3 h-3" /> {days}d remaining
    </span>
  )
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">
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
        <div className="card mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-gray-200">New Document Requirement</h2>
            <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-gray-300">
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

            <div className="md:col-span-2 flex gap-2">
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
      <div className="flex items-center gap-3 mb-4">
        <select
          className="input max-w-xs text-sm"
          value={filterClient}
          onChange={(e) => setFilterClient(e.target.value)}
        >
          <option value="">All Clients</option>
          {clients.map((c: any) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </div>

      {isLoading && <div className="flex justify-center mt-10"><Spinner size="lg" /></div>}
      {error && <ErrorBanner message="Failed to load requirements" />}
      {!isLoading && requirements.length === 0 && (
        <EmptyState message="No document requirements yet. Create one for a client." />
      )}

      <div className="space-y-3">
        {requirements.map((req: any) => (
          <div key={req.id} className="card">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <h3 className="font-semibold text-gray-200 text-sm">{req.title}</h3>
                  <UrgencyTag dueDate={req.dueDate} status={req.status} />
                </div>
                <p className="text-xs text-gray-500">
                  Client: <span className="text-gray-400">{req.clientCompany?.name}</span>
                  {' · '}
                  Due: {new Date(req.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </p>
                {req.opportunity && (
                  <p className="text-xs text-gray-600 mt-0.5">Linked opportunity: {req.opportunity.title}</p>
                )}
                {req.description && (
                  <p className="text-xs text-gray-400 mt-1">{req.description}</p>
                )}
                {req.isPenaltyEnabled && (
                  <p className="text-xs text-red-400/70 mt-1">
                    Penalty: {req.penaltyAmount ? formatCurrency(Number(req.penaltyAmount)) + ' flat fee' :
                      req.penaltyPercent ? `${req.penaltyPercent}% of contract value` : 'enabled'}
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {req.status === 'PENDING' && (
                  <button
                    onClick={() => updateMutation.mutate({ id: req.id, data: { status: 'SUBMITTED' } })}
                    disabled={updateMutation.isPending}
                    className="text-xs btn-secondary py-1"
                  >
                    Mark Submitted
                  </button>
                )}
                <button
                  onClick={() => { if (window.confirm('Delete this requirement?')) deleteMutation.mutate(req.id) }}
                  className="text-gray-600 hover:text-red-400 transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

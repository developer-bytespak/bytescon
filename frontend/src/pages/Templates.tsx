import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { templatesApi, clientsApi, opportunitiesApi } from '../services/api'
import { EmptyState, ErrorBanner, PageHeader, Spinner } from '../components/ui'
import { useToast } from '../components/Toast'
import { Download, FileUp, Send, X } from 'lucide-react'

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const idx = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / (1024 ** idx)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[idx]}`
}

export function TemplatesPage() {
  const qc = useQueryClient()

  const [uploadForm, setUploadForm] = useState({
    title: '',
    description: '',
    category: '',
    file: null as File | null,
  })
  const [uploadError, setUploadError] = useState('')

  const [assignForm, setAssignForm] = useState({
    templateId: '',
    dueDate: '',
    opportunityId: '',
    selectedClientIds: [] as string[],
    isPenaltyEnabled: true,
    penaltyType: 'flat' as 'flat' | 'percent',
    penaltyAmount: '',
    penaltyPercent: '',
    notes: '',
  })
  const [assignError, setAssignError] = useState('')
  const [assignResult, setAssignResult] = useState('')

  const { data: templatesData, isLoading: templatesLoading, error: templatesError } = useQuery({
    queryKey: ['templates'],
    queryFn: () => templatesApi.list(),
  })

  const { data: clientsData } = useQuery({
    queryKey: ['clients'],
    queryFn: () => clientsApi.list({ limit: 300, active: true }),
  })

  const { data: opportunitiesData } = useQuery({
    queryKey: ['opportunities', 'template-assign'],
    queryFn: () => opportunitiesApi.search({ limit: 200, sortBy: 'deadline', sortOrder: 'asc' }),
  })

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!uploadForm.file) throw new Error('File is required')
      const formData = new FormData()
      formData.append('title', uploadForm.title.trim())
      formData.append('description', uploadForm.description.trim())
      formData.append('category', uploadForm.category.trim())
      formData.append('file', uploadForm.file)
      return templatesApi.upload(formData)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] })
      setUploadError('')
      setUploadForm({ title: '', description: '', category: '', file: null })
    },
    onError: (err: any) => {
      setUploadError(err?.response?.data?.error || err?.message || 'Template upload failed')
    },
  })

  const assignMutation = useMutation({
    mutationFn: () =>
      templatesApi.assign(assignForm.templateId, {
        clientCompanyIds: assignForm.selectedClientIds,
        dueDate: assignForm.dueDate,
        opportunityId: assignForm.opportunityId || undefined,
        isPenaltyEnabled: assignForm.isPenaltyEnabled,
        penaltyAmount:
          assignForm.isPenaltyEnabled && assignForm.penaltyType === 'flat' && assignForm.penaltyAmount
            ? Number(assignForm.penaltyAmount)
            : undefined,
        penaltyPercent:
          assignForm.isPenaltyEnabled && assignForm.penaltyType === 'percent' && assignForm.penaltyPercent
            ? Number(assignForm.penaltyPercent)
            : undefined,
        notes: assignForm.notes || undefined,
      }),
    onSuccess: (result: any) => {
      const created = result?.data?.createdCount ?? 0
      const skipped = result?.data?.skippedCount ?? 0
      setAssignResult(`Assigned template to ${created} client(s); skipped ${skipped} duplicate assignment(s).`)
      setAssignError('')
      setAssignForm({
        templateId: assignForm.templateId,
        dueDate: '',
        opportunityId: '',
        selectedClientIds: [],
        isPenaltyEnabled: true,
        penaltyType: 'flat',
        penaltyAmount: '',
        penaltyPercent: '',
        notes: '',
      })
      qc.invalidateQueries({ queryKey: ['doc-requirements'] })
      qc.invalidateQueries({ queryKey: ['templates'] })
    },
    onError: (err: any) => {
      setAssignError(err?.response?.data?.error || 'Template assignment failed')
      setAssignResult('')
    },
  })

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => templatesApi.deactivate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['templates'] }),
  })

  const templates = templatesData?.data || []
  const clients = clientsData?.data || []
  const opportunities = opportunitiesData?.data || []

  const allClientsSelected = useMemo(
    () => clients.length > 0 && assignForm.selectedClientIds.length === clients.length,
    [clients.length, assignForm.selectedClientIds.length]
  )

  const toggleClient = (id: string) => {
    setAssignForm((prev) => ({
      ...prev,
      selectedClientIds: prev.selectedClientIds.includes(id)
        ? prev.selectedClientIds.filter((c) => c !== id)
        : [...prev.selectedClientIds, id],
    }))
  }

  const downloadTemplate = async (template: any) => {
    const blob = await templatesApi.download(template.id)
    const url = window.URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = template.fileName
    anchor.click()
    window.URL.revokeObjectURL(url)
  }

  const handleUpload = (e: React.FormEvent) => {
    e.preventDefault()
    if (!uploadForm.title.trim()) {
      setUploadError('Title is required')
      return
    }
    if (!uploadForm.file) {
      setUploadError('Please select a file')
      return
    }
    uploadMutation.mutate()
  }

  const handleAssign = (e: React.FormEvent) => {
    e.preventDefault()
    if (!assignForm.templateId) {
      setAssignError('Select a template')
      return
    }
    if (!assignForm.dueDate) {
      setAssignError('Select a due date')
      return
    }
    if (assignForm.selectedClientIds.length === 0) {
      setAssignError('Select at least one client')
      return
    }
    assignMutation.mutate()
  }

  return (
    <div>
      <PageHeader
        title="Template Library"
        subtitle="Upload reusable files and assign required documents to multiple clients"
      />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 mb-6">
        <form className="card" onSubmit={handleUpload}>
          <h2 className="font-semibold text-gray-200 mb-4">Upload New Template</h2>
          <div className="space-y-3">
            <div>
              <label className="label">Template Title *</label>
              <input
                className="input"
                value={uploadForm.title}
                onChange={(e) => setUploadForm({ ...uploadForm, title: e.target.value })}
                placeholder="Capability Statement Package"
                required
              />
            </div>

            <div>
              <label className="label">Category</label>
              <input
                className="input"
                value={uploadForm.category}
                onChange={(e) => setUploadForm({ ...uploadForm, category: e.target.value })}
                placeholder="Certifications, Pricing, Technical, Legal"
              />
            </div>

            <div>
              <label className="label">Description</label>
              <textarea
                className="input min-h-20"
                value={uploadForm.description}
                onChange={(e) => setUploadForm({ ...uploadForm, description: e.target.value })}
                placeholder="When consultants should use this template."
              />
            </div>

            <div>
              <label className="label">Template File *</label>
              <input
                type="file"
                className="input"
                onChange={(e) => setUploadForm({ ...uploadForm, file: e.target.files?.[0] || null })}
                required
              />
              <p className="text-xs text-gray-500 mt-1">Allowed: PDF, TXT, DOC, DOCX, XLS, XLSX</p>
            </div>

            {uploadError && <ErrorBanner message={uploadError} />}

            <button type="submit" className="btn-primary flex items-center gap-2" disabled={uploadMutation.isPending}>
              <FileUp className="w-4 h-4" />
              {uploadMutation.isPending ? 'Uploading...' : 'Save Template'}
            </button>
          </div>
        </form>

        <form className="card" onSubmit={handleAssign}>
          <h2 className="font-semibold text-gray-200 mb-4">Assign Template to Clients</h2>

          <div className="space-y-3">
            <div>
              <label className="label">Template *</label>
              <select
                className="input"
                value={assignForm.templateId}
                onChange={(e) => setAssignForm({ ...assignForm, templateId: e.target.value })}
                required
              >
                <option value="">Select template...</option>
                {templates.filter((t: any) => t.isActive).map((t: any) => (
                  <option key={t.id} value={t.id}>
                    {t.title}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="label">Due Date *</label>
                <input
                  type="date"
                  className="input"
                  value={assignForm.dueDate}
                  onChange={(e) => setAssignForm({ ...assignForm, dueDate: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="label">Opportunity (Optional)</label>
                <select
                  className="input"
                  value={assignForm.opportunityId}
                  onChange={(e) => setAssignForm({ ...assignForm, opportunityId: e.target.value })}
                >
                  <option value="">No linked opportunity</option>
                  {opportunities.map((opp: any) => (
                    <option key={opp.id} value={opp.id}>
                      {opp.title}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="label mb-0">Clients *</label>
                <button
                  type="button"
                  className="text-xs text-blue-400 hover:text-blue-300"
                  onClick={() =>
                    setAssignForm({
                      ...assignForm,
                      selectedClientIds: allClientsSelected ? [] : clients.map((c: any) => c.id),
                    })
                  }
                >
                  {allClientsSelected ? 'Clear all' : 'Select all'}
                </button>
              </div>
              <div className="max-h-36 overflow-auto border border-gray-800 rounded-md p-2 space-y-1">
                {clients.map((client: any) => (
                  <label key={client.id} className="flex items-center gap-2 text-sm text-gray-300">
                    <input
                      type="checkbox"
                      checked={assignForm.selectedClientIds.includes(client.id)}
                      onChange={() => toggleClient(client.id)}
                    />
                    {client.name}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="flex items-center gap-2 cursor-pointer mb-2">
                <input
                  type="checkbox"
                  checked={assignForm.isPenaltyEnabled}
                  onChange={(e) => setAssignForm({ ...assignForm, isPenaltyEnabled: e.target.checked })}
                />
                <span className="text-sm text-gray-300">Enable penalty</span>
              </label>

              {assignForm.isPenaltyEnabled && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="label">Penalty Type</label>
                    <select
                      className="input"
                      value={assignForm.penaltyType}
                      onChange={(e) => setAssignForm({ ...assignForm, penaltyType: e.target.value as 'flat' | 'percent' })}
                    >
                      <option value="flat">Flat Fee ($)</option>
                      <option value="percent">Percentage (%)</option>
                    </select>
                  </div>
                  {assignForm.penaltyType === 'flat' ? (
                    <div>
                      <label className="label">Flat Amount</label>
                      <input
                        type="number"
                        className="input"
                        value={assignForm.penaltyAmount}
                        onChange={(e) => setAssignForm({ ...assignForm, penaltyAmount: e.target.value })}
                        min="0"
                      />
                    </div>
                  ) : (
                    <div>
                      <label className="label">Percentage</label>
                      <input
                        type="number"
                        className="input"
                        value={assignForm.penaltyPercent}
                        onChange={(e) => setAssignForm({ ...assignForm, penaltyPercent: e.target.value })}
                        min="0"
                        max="100"
                        step="0.1"
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            <div>
              <label className="label">Internal Notes</label>
              <input
                className="input"
                value={assignForm.notes}
                onChange={(e) => setAssignForm({ ...assignForm, notes: e.target.value })}
                placeholder="Optional assignment notes"
              />
            </div>

            {assignError && <ErrorBanner message={assignError} />}
            {assignResult && <p className="text-sm text-green-400">{assignResult}</p>}

            <button type="submit" className="btn-primary flex items-center gap-2" disabled={assignMutation.isPending}>
              <Send className="w-4 h-4" />
              {assignMutation.isPending ? 'Assigning...' : 'Assign Template'}
            </button>
          </div>
        </form>
      </div>

      <div className="card">
        <h2 className="font-semibold text-gray-200 mb-4">Saved Templates</h2>

        {templatesLoading && (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        )}
        {templatesError && <ErrorBanner message="Failed to load templates" />}
        {!templatesLoading && templates.length === 0 && (
          <EmptyState message="No templates saved yet. Upload your first reusable document template." />
        )}

        <div className="space-y-2">
          {templates.map((template: any) => (
            <TemplateRow key={template.id} template={template} onDeactivate={(id) => deactivateMutation.mutate(id)}
              deactivating={deactivateMutation.isPending} onDownload={downloadTemplate} onSaved={() => qc.invalidateQueries({ queryKey: ['templates'] })} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * One template row, with its metadata editable in place.
 *
 * Only the metadata — title, category, description. The FILE is never edited:
 * a template someone already attached to a proposal must stay the file they
 * attached, so a new file means a new template.
 */
function TemplateRow({ template, onDeactivate, deactivating, onDownload, onSaved }: {
  template: any
  onDeactivate: (id: string) => void
  deactivating: boolean
  onDownload: (t: any) => void
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [f, setF] = useState({
    title: template.title ?? '', category: template.category ?? '', description: template.description ?? '',
  })

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await templatesApi.update(template.id, {
        title: f.title, category: f.category || null, description: f.description || null,
      })
      toast('Template updated', 'success')
      setEditing(false)
      onSaved()
    } catch (err: any) {
      toast(err?.response?.data?.error || 'Could not update the template', 'error')
    } finally { setSaving(false) }
  }

  if (editing) {
    return (
      <form onSubmit={save} className="border border-gray-800 rounded-lg p-3 grid grid-cols-1 md:grid-cols-3 gap-2">
        <input required aria-label="Template title" className="input" placeholder="Title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <input aria-label="Template category" className="input" placeholder="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        <input aria-label="Template description" className="input" placeholder="Description" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <div className="md:col-span-3 flex items-center gap-2">
          <button type="submit" disabled={saving} className="btn-secondary py-1 text-xs">{saving ? 'Saving…' : 'Save'}</button>
          <button type="button" onClick={() => setEditing(false)} className="text-xs text-gray-500 hover:text-gray-300">Cancel</button>
          <p className="text-[10px] text-gray-600">The file itself is never replaced — upload a new template instead.</p>
        </div>
      </form>
    )
  }

  return (
            <div className="border border-gray-800 rounded-lg p-3 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-semibold text-gray-200">{template.title}</p>
                  {!template.isActive && (
                    <span className="text-[10px] bg-red-900/40 text-red-300 px-1.5 py-0.5 rounded">Inactive</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {template.category || 'Uncategorized'} | {template.fileName} | {formatBytes(template.fileSize)}
                </p>
                {template.description && (
                  <p className="text-xs text-gray-400 mt-1">{template.description}</p>
                )}
                <p className="text-xs text-gray-600 mt-1">
                  Used in {template.assignmentCount || 0} assignment(s)
                </p>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  className="btn-secondary py-1 text-xs flex items-center gap-1"
                  onClick={() => onDownload(template)}
                >
                  <Download className="w-3.5 h-3.5" /> Download
                </button>
                {template.isActive && (
                  <>
                    <button className="text-xs text-blue-400 hover:text-blue-300" onClick={() => setEditing(true)}>Edit</button>
                    <button
                      className="text-xs text-red-400 hover:text-red-300 flex items-center gap-1"
                      onClick={() => {
                        if (window.confirm('Deactivate this template?')) onDeactivate(template.id)
                      }}
                      disabled={deactivating}
                    >
                      <X className="w-3.5 h-3.5" /> Deactivate
                    </button>
                  </>
                )}
              </div>
            </div>
  )
}


// Platform-admin cross-tenant shared-template moderation queue (C5).
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { clientDocumentsApi } from '../services/api'
import { PageHeader, Spinner, ErrorBanner } from '../components/ui'
import { ShieldCheck, Download, Check, X, AlertTriangle } from 'lucide-react'

interface PendingTemplate {
  id: string
  documentType: string
  title: string
  description?: string | null
  createdAt: string
  submittedByFirm?: { id: string; name: string }
}

export function TemplateModerationPage() {
  const qc = useQueryClient()
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [deid, setDeid] = useState<Record<string, boolean>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})

  const { data: modData, isLoading: modLoading } = useQuery({
    queryKey: ['can-moderate-templates'],
    queryFn: () => clientDocumentsApi.canModerateTemplates(),
  })
  const canModerate = !!modData?.data?.canModerate

  const { data, isLoading, error } = useQuery({
    queryKey: ['pending-templates'],
    queryFn: () => clientDocumentsApi.pendingTemplates(),
    enabled: canModerate,
  })

  const review = useMutation({
    mutationFn: (vars: { id: string; status: 'APPROVED' | 'REJECTED' }) =>
      clientDocumentsApi.reviewTemplate(vars.id, {
        status: vars.status,
        reviewNotes: notes[vars.id]?.trim() || undefined,
        deidentificationConfirmed: vars.status === 'APPROVED' ? !!deid[vars.id] : undefined,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pending-templates'] }),
    onError: (err: unknown, vars) => {
      const e = err as { response?: { data?: { error?: string } } }
      setRowError((m) => ({ ...m, [vars.id]: e?.response?.data?.error || 'Review failed' }))
    },
  })

  if (modLoading) return <Spinner />

  if (!canModerate) {
    return (
      <div>
        <PageHeader title="Template Review" subtitle="Cross-tenant shared-template moderation" />
        <div className="card flex gap-3">
          <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-gray-300">
            Platform-administrator access is required to review shared templates. Ask the platform operator
            to add your email to <code>PLATFORM_ADMIN_EMAILS</code>.
          </p>
        </div>
      </div>
    )
  }

  if (error) return <ErrorBanner message="Failed to load pending templates" />

  const templates: PendingTemplate[] = data?.data || []

  const preview = (t: PendingTemplate) => {
    const safe = t.title.replace(/[^a-zA-Z0-9-_ ]/g, '').trim().replace(/ /g, '_') || 'template'
    clientDocumentsApi.previewTemplate(t.id, `${safe}_REVIEW.txt`).catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : 'Preview failed'
      setRowError((m) => ({ ...m, [t.id]: msg }))
    })
  }

  return (
    <div>
      <PageHeader
        title="Template Review"
        subtitle="Approve cross-tenant shared templates only after verifying they are de-identified"
      />

      <div className="card flex gap-3 mb-6">
        <ShieldCheck className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-gray-400">
          A firm submits a client document as a reusable template; it is auto-anonymized, then waits here.
          Once approved it becomes downloadable by <strong>every</strong> firm. Preview the file and confirm it
          contains no client names, PII, or CUI before approving.
        </p>
      </div>

      {isLoading ? (
        <Spinner />
      ) : templates.length === 0 ? (
        <p className="text-sm text-gray-500">No templates awaiting review.</p>
      ) : (
        <div className="space-y-4">
          {templates.map((t) => (
            <div key={t.id} className="card">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-gray-100">{t.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {t.documentType} · submitted by {t.submittedByFirm?.name ?? 'Unknown firm'} ·{' '}
                    {new Date(t.createdAt).toLocaleDateString()}
                  </p>
                  {t.description && <p className="text-xs text-gray-400 mt-1">{t.description}</p>}
                </div>
                <button onClick={() => preview(t)} className="btn-secondary text-xs flex items-center gap-1 flex-shrink-0">
                  <Download className="w-3.5 h-3.5" /> Preview file
                </button>
              </div>

              <textarea
                value={notes[t.id] ?? ''}
                onChange={(e) => setNotes((m) => ({ ...m, [t.id]: e.target.value }))}
                placeholder="Review notes (optional; shown to the submitting firm)"
                className="input mt-3 w-full text-xs"
                rows={2}
              />

              <label className="flex items-center gap-2 mt-2 text-xs text-gray-300">
                <input
                  type="checkbox"
                  checked={!!deid[t.id]}
                  onChange={(e) => setDeid((m) => ({ ...m, [t.id]: e.target.checked }))}
                />
                I verified this file is de-identified (no client names, PII, or CUI).
              </label>

              {rowError[t.id] && <p className="text-xs text-red-400 mt-2">{rowError[t.id]}</p>}

              <div className="flex gap-2 mt-3">
                <button
                  onClick={() => review.mutate({ id: t.id, status: 'APPROVED' })}
                  disabled={!deid[t.id] || review.isPending}
                  className="btn-primary text-xs flex items-center gap-1 disabled:opacity-50"
                >
                  <Check className="w-3.5 h-3.5" /> Approve &amp; publish
                </button>
                <button
                  onClick={() => review.mutate({ id: t.id, status: 'REJECTED' })}
                  disabled={review.isPending}
                  className="btn-secondary text-xs flex items-center gap-1"
                >
                  <X className="w-3.5 h-3.5" /> Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default TemplateModerationPage

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { isDemoSite } from '../demo/demoMode'
import { clientDocumentsApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { motion } from 'framer-motion'
import { PageHeader, SkeletonCards, ErrorBanner, EmptyState } from '../components/ui'
import { BookMarked, Download, FileText, BookOpen, Briefcase, Users, DollarSign, Shield, FileCheck, Mail, CheckCircle, XCircle, Clock } from 'lucide-react'

const DOC_TYPES = [
  { value: '', label: 'All types' },
  { value: 'CAPABILITY_STATEMENT', label: 'Capability statement' },
  { value: 'PAST_PERFORMANCE', label: 'Past performance' },
  { value: 'TECHNICAL_PROPOSAL', label: 'Technical proposal' },
  { value: 'MANAGEMENT_APPROACH', label: 'Management approach' },
  { value: 'PRICE_VOLUME', label: 'Price/cost volume' },
  { value: 'SMALL_BUSINESS_PLAN', label: 'Small business plan' },
  { value: 'TEAMING_AGREEMENT', label: 'Teaming agreement' },
  { value: 'COVER_LETTER', label: 'Cover letter' },
  { value: 'OTHER', label: 'Other' },
]

const TYPE_ICONS: Record<string, any> = {
  CAPABILITY_STATEMENT: Briefcase,
  PAST_PERFORMANCE: FileCheck,
  TECHNICAL_PROPOSAL: BookOpen,
  MANAGEMENT_APPROACH: Users,
  PRICE_VOLUME: DollarSign,
  SMALL_BUSINESS_PLAN: Shield,
  TEAMING_AGREEMENT: Users,
  COVER_LETTER: Mail,
  OTHER: FileText,
}

export default function TemplateLibrary() {
  const [selectedType, setSelectedType] = useState('')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({})
  const [adminView, setAdminView] = useState<'pending' | 'approved'>('pending')
  const { user } = useAuth()
  const isAdmin = user?.role === 'ADMIN'
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['templates', selectedType],
    queryFn: () => clientDocumentsApi.listTemplates({ documentType: selectedType || undefined, limit: 50 }),
  })

  const { data: adminData, refetch: refetchAdmin } = useQuery({
    queryKey: ['templates-admin'],
    queryFn: () => clientDocumentsApi.listTemplatesAdmin(),
    enabled: isAdmin,
  })

  const reviewMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'APPROVED' | 'REJECTED' }) =>
      clientDocumentsApi.reviewTemplate(id, { status, reviewNotes: reviewNote[id] || undefined }),
    onSuccess: () => {
      refetchAdmin()
      qc.invalidateQueries({ queryKey: ['templates'] })
    },
  })

  const templates: any[] = data?.data ?? []
  const adminTemplates: any[] = adminData?.data ?? []
  const pendingTemplates = adminTemplates.filter((t: any) => t.status === 'PENDING_REVIEW' || t.status === 'PENDING')
  const approvedTemplates = adminTemplates.filter((t: any) => t.status === 'APPROVED')

  const [downloadError, setDownloadError] = useState('')
  const handleDownload = async (template: any) => {
    setDownloading(template.id)
    setDownloadError('')
    try {
      const safeName = template.title.replace(/[^a-zA-Z0-9- ]/g, '').trim().replace(/ /g, '_')
      await clientDocumentsApi.downloadTemplate(template.id, safeName + '_template.txt')
    } catch (err: any) {
      setDownloadError(err?.message || 'Download failed — template file may be missing from the server.')
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="space-y-6 pb-12">
      <PageHeader
        title="Template library"
        subtitle="Community-contributed, anonymized document templates for government contracting"
      />

      {/* Admin Review Panel */}
      {isAdmin && !isDemoSite && (
        <div className="card">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-gray-400" />
              <h3 className="text-base font-semibold text-gray-100">Template review queue</h3>
              {pendingTemplates.length > 0 && (
                <span className="chip badge-yellow tabular-nums">
                  {pendingTemplates.length} pending
                </span>
              )}
            </div>
            <div className="segmented">
              <button
                onClick={() => setAdminView('pending')}
                data-active={adminView === 'pending'}
              >
                {adminView === 'pending' && <motion.span layoutId="template-review-view" className="segmented-thumb" />}
                Pending ({pendingTemplates.length})
              </button>
              <button
                onClick={() => setAdminView('approved')}
                data-active={adminView === 'approved'}
              >
                {adminView === 'approved' && <motion.span layoutId="template-review-view" className="segmented-thumb" />}
                Approved ({approvedTemplates.length})
              </button>
            </div>
          </div>

          {adminView === 'pending' && (
            pendingTemplates.length === 0 ? (
              <EmptyState message="No templates pending review." hint={null} />
            ) : (
              <div className="stagger space-y-3">
                {pendingTemplates.map((t: any) => (
                  <div key={t.id} className="card">
                    <div className="flex flex-wrap sm:flex-nowrap items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Clock className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                          <p className="text-sm font-semibold text-gray-200 truncate">{t.title}</p>
                          <span className="chip chip-neutral shrink-0">
                            {DOC_TYPES.find(d => d.value === t.documentType)?.label ?? t.documentType}
                          </span>
                        </div>
                        {t.description && <p className="text-xs text-gray-500 line-clamp-2">{t.description}</p>}
                        <p className="text-xs text-gray-500 mt-1">Submitted {new Date(t.createdAt).toLocaleDateString()}</p>
                      </div>
                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <input
                          type="text"
                          placeholder="Optional review note…"
                          className="input text-xs w-full sm:w-48"
                          value={reviewNote[t.id] || ''}
                          onChange={(e) => setReviewNote(n => ({ ...n, [t.id]: e.target.value }))}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => reviewMutation.mutate({ id: t.id, status: 'APPROVED' })}
                            disabled={reviewMutation.isPending}
                            className="btn-primary btn-sm flex-1 flex items-center justify-center gap-1 disabled:opacity-50"
                          >
                            <CheckCircle className="w-3.5 h-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => reviewMutation.mutate({ id: t.id, status: 'REJECTED' })}
                            disabled={reviewMutation.isPending}
                            className="btn-danger btn-sm flex-1 flex items-center justify-center gap-1 disabled:opacity-50"
                          >
                            <XCircle className="w-3.5 h-3.5" /> Reject
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}

          {adminView === 'approved' && (
            approvedTemplates.length === 0 ? (
              <EmptyState message="No approved templates yet." hint={null} />
            ) : (
              <div className="stagger space-y-2">
                {approvedTemplates.map((t: any) => (
                  <div key={t.id} className="panel flex items-center gap-3 px-4 py-2.5">
                    <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                    <p className="text-sm text-gray-300 flex-1 truncate">{t.title}</p>
                    <span className="text-xs text-gray-500 tabular-nums">{new Date(t.createdAt).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

      <div className="card">
        <div className="flex items-start gap-3">
          <BookMarked className="w-5 h-5 text-gray-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-base font-semibold text-gray-100">How templates work</p>
            <p className="text-xs text-gray-500 mt-1">
              Templates are real documents submitted by firms like yours, with company names, emails, and identifying info removed.
              {!isDemoSite && " Upload your own branded documents from a client's profile page and share them to contribute to the community library. "}
              All submissions are reviewed before becoming available here.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {DOC_TYPES.map((t) => (
          <button
            key={t.value}
            onClick={() => setSelectedType(t.value)}
            className="v3-tag"
            aria-pressed={selectedType === t.value}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && <div><span className="sr-only">Loading…</span><SkeletonCards count={6} /></div>}
      {downloadError && <ErrorBanner message={downloadError} />}
      {error && <ErrorBanner message="Failed to load templates" />}
      {!isLoading && templates.length === 0 && (
        <EmptyState message={isDemoSite ? 'No templates available yet.' : 'No templates available yet. Be the first to contribute: upload a document from any client profile.'} />
      )}

      <div className="stagger grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((t: any) => {
          const Icon = TYPE_ICONS[t.documentType] ?? FileText
          return (
            <div key={t.id} className="card flex flex-col">
              <div className="flex items-start gap-3 mb-3">
                <div className="tile tile-sm">
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-200 leading-snug">{t.title}</p>
                  <span className="chip chip-neutral mt-1.5">
                    {DOC_TYPES.find((d) => d.value === t.documentType)?.label ?? t.documentType}
                  </span>
                </div>
              </div>

              {t.description && (
                <p className="text-xs text-gray-500 mb-3 line-clamp-2">{t.description}</p>
              )}

              <div className="mt-auto flex items-center justify-between pt-3 border-t border-gray-800">
                <div className="flex items-center gap-1 text-xs text-gray-500 tabular-nums">
                  <Download className="w-3 h-3" />
                  {(t.downloadCount ?? 0).toLocaleString()} downloads
                </div>
                <button
                  onClick={() => handleDownload(t)}
                  disabled={downloading === t.id}
                  className="btn-secondary btn-sm flex items-center gap-1.5"
                >
                  <Download className="w-3 h-3" />
                  {downloading === t.id ? 'Downloading…' : 'Download template'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

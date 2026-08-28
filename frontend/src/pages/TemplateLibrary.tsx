import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { clientDocumentsApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { PageHeader, Spinner, ErrorBanner, EmptyState } from '../components/ui'
import { BookMarked, Download, FileText, BookOpen, Briefcase, Users, DollarSign, Shield, FileCheck, Mail, CheckCircle, XCircle, Clock } from 'lucide-react'

const DOC_TYPES = [
  { value: '', label: 'All Types' },
  { value: 'CAPABILITY_STATEMENT', label: 'Capability Statement' },
  { value: 'PAST_PERFORMANCE', label: 'Past Performance' },
  { value: 'TECHNICAL_PROPOSAL', label: 'Technical Proposal' },
  { value: 'MANAGEMENT_APPROACH', label: 'Management Approach' },
  { value: 'PRICE_VOLUME', label: 'Price/Cost Volume' },
  { value: 'SMALL_BUSINESS_PLAN', label: 'Small Business Plan' },
  { value: 'TEAMING_AGREEMENT', label: 'Teaming Agreement' },
  { value: 'COVER_LETTER', label: 'Cover Letter' },
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

const TYPE_COLORS: Record<string, string> = {
  CAPABILITY_STATEMENT: 'bg-blue-900/40 text-blue-300 border-blue-700',
  PAST_PERFORMANCE: 'bg-green-900/40 text-green-300 border-green-700',
  TECHNICAL_PROPOSAL: 'bg-purple-900/40 text-purple-300 border-purple-700',
  MANAGEMENT_APPROACH: 'bg-cyan-900/40 text-cyan-300 border-cyan-700',
  PRICE_VOLUME: 'bg-yellow-900/40 text-yellow-300 border-yellow-700',
  SMALL_BUSINESS_PLAN: 'bg-orange-900/40 text-orange-300 border-orange-700',
  TEAMING_AGREEMENT: 'bg-pink-900/40 text-pink-300 border-pink-700',
  COVER_LETTER: 'bg-indigo-900/40 text-indigo-300 border-indigo-700',
  OTHER: 'bg-gray-800 text-gray-400 border-gray-700',
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
        title="Template Library"
        subtitle="Community-contributed, anonymized document templates for government contracting"
      />

      {/* Admin Review Panel */}
      {isAdmin && (
        <div className="card border-amber-700/30 bg-amber-900/10">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <CheckCircle className="w-5 h-5 text-amber-400" />
              <h3 className="font-semibold text-gray-200">Template Review Queue</h3>
              {pendingTemplates.length > 0 && (
                <span className="text-xs bg-amber-500/20 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-semibold">
                  {pendingTemplates.length} pending
                </span>
              )}
            </div>
            <div className="flex gap-1 bg-gray-800 rounded-lg p-1">
              <button
                onClick={() => setAdminView('pending')}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${adminView === 'pending' ? 'bg-amber-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}
              >
                Pending ({pendingTemplates.length})
              </button>
              <button
                onClick={() => setAdminView('approved')}
                className={`text-xs px-3 py-1 rounded-md transition-colors ${adminView === 'approved' ? 'bg-green-700 text-white' : 'text-gray-400 hover:text-gray-200'}`}
              >
                Approved ({approvedTemplates.length})
              </button>
            </div>
          </div>

          {adminView === 'pending' && (
            pendingTemplates.length === 0 ? (
              <p className="text-sm text-gray-500 italic">No templates pending review.</p>
            ) : (
              <div className="space-y-3">
                {pendingTemplates.map((t: any) => (
                  <div key={t.id} className="bg-gray-900/60 border border-gray-700 rounded-lg p-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Clock className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                          <p className="text-sm font-semibold text-gray-200 truncate">{t.title}</p>
                          <span className="text-[10px] bg-amber-900/40 text-amber-300 border border-amber-700 px-1.5 py-0.5 rounded shrink-0">
                            {DOC_TYPES.find(d => d.value === t.documentType)?.label ?? t.documentType}
                          </span>
                        </div>
                        {t.description && <p className="text-xs text-gray-500 line-clamp-2">{t.description}</p>}
                        <p className="text-[11px] text-gray-600 mt-1">Submitted {new Date(t.createdAt).toLocaleDateString()}</p>
                      </div>
                      <div className="flex flex-col gap-2 flex-shrink-0">
                        <input
                          type="text"
                          placeholder="Optional review note..."
                          className="input text-xs w-48"
                          value={reviewNote[t.id] || ''}
                          onChange={(e) => setReviewNote(n => ({ ...n, [t.id]: e.target.value }))}
                        />
                        <div className="flex gap-2">
                          <button
                            onClick={() => reviewMutation.mutate({ id: t.id, status: 'APPROVED' })}
                            disabled={reviewMutation.isPending}
                            className="flex-1 flex items-center justify-center gap-1 text-xs bg-green-900/50 hover:bg-green-900 text-green-300 border border-green-800 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
                          >
                            <CheckCircle className="w-3.5 h-3.5" /> Approve
                          </button>
                          <button
                            onClick={() => reviewMutation.mutate({ id: t.id, status: 'REJECTED' })}
                            disabled={reviewMutation.isPending}
                            className="flex-1 flex items-center justify-center gap-1 text-xs bg-red-900/30 hover:bg-red-900/60 text-red-400 border border-red-900 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
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
              <p className="text-sm text-gray-500 italic">No approved templates yet.</p>
            ) : (
              <div className="space-y-2">
                {approvedTemplates.map((t: any) => (
                  <div key={t.id} className="flex items-center gap-3 bg-gray-900/40 border border-gray-800 rounded-lg px-4 py-2.5">
                    <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                    <p className="text-sm text-gray-300 flex-1 truncate">{t.title}</p>
                    <span className="text-[10px] text-gray-600">{new Date(t.createdAt).toLocaleDateString()}</span>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      )}

      <div className="card bg-blue-950/20 border-blue-900/40">
        <div className="flex items-start gap-3">
          <BookMarked className="w-5 h-5 text-blue-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-gray-200">How templates work</p>
            <p className="text-xs text-gray-500 mt-1">
              Templates are real documents submitted by firms like yours — with company names, emails, and identifying info removed.
              Upload your own branded documents from a client's profile page and share them to contribute to the community library.
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
            className={'text-xs px-3 py-1.5 rounded-full border transition-colors ' + (
              selectedType === t.value
                ? 'bg-blue-600 text-white border-blue-600'
                : 'bg-gray-800 text-gray-400 border-gray-700 hover:border-gray-500'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading && <div className="flex justify-center mt-10"><Spinner size="lg" /></div>}
      {downloadError && <ErrorBanner message={downloadError} />}
      {error && <ErrorBanner message="Failed to load templates" />}
      {!isLoading && templates.length === 0 && (
        <EmptyState message="No templates available yet. Be the first to contribute — upload a document from any client profile." />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((t: any) => {
          const Icon = TYPE_ICONS[t.documentType] ?? FileText
          const colorClass = TYPE_COLORS[t.documentType] ?? TYPE_COLORS.OTHER
          return (
            <div key={t.id} className="card hover:border-gray-600 transition-colors flex flex-col">
              <div className="flex items-start gap-3 mb-3">
                <div className={'p-2 rounded-lg border ' + colorClass}>
                  <Icon className="w-4 h-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-gray-200 leading-snug">{t.title}</p>
                  <span className={'text-xs px-1.5 py-0.5 rounded border mt-1 inline-block ' + colorClass}>
                    {DOC_TYPES.find((d) => d.value === t.documentType)?.label ?? t.documentType}
                  </span>
                </div>
              </div>

              {t.description && (
                <p className="text-xs text-gray-500 mb-3 line-clamp-2">{t.description}</p>
              )}

              <div className="mt-auto flex items-center justify-between pt-3 border-t border-gray-800">
                <div className="flex items-center gap-1 text-xs text-gray-600">
                  <Download className="w-3 h-3" />
                  {(t.downloadCount ?? 0).toLocaleString()} downloads
                </div>
                <button
                  onClick={() => handleDownload(t)}
                  disabled={downloading === t.id}
                  className="btn-primary text-xs flex items-center gap-1.5 py-1.5 px-3"
                >
                  <Download className="w-3 h-3" />
                  {downloading === t.id ? 'Downloading...' : 'Download Template'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

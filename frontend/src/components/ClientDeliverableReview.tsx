import { useState, useEffect } from 'react'
import { FileText, CheckCircle, AlertCircle, Download, Send, X, Loader } from 'lucide-react'
import axios from 'axios'
import { DeliverableThread } from './DeliverableThread'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

interface Deliverable {
  id: string
  title: string
  documentType: string
  fileName: string
  fileSize: number
  notes?: string
  createdAt: string
  updatedAt: string
}

interface DeliverableReviewProps {
  clientAuth: any
  onDeliverableUpdated?: () => void
}

export function ClientDeliverableReview({
  clientAuth,
  onDeliverableUpdated,
}: DeliverableReviewProps) {
  const [deliverables, setDeliverables] = useState<Deliverable[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [feedbackModal, setFeedbackModal] = useState<{ id: string; open: boolean }>({
    id: '',
    open: false,
  })
  const [feedback, setFeedback] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadDeliverables()
  }, [])

  const loadDeliverables = async () => {
    try {
      setLoading(true)
      const res = await axios.get(`${API_BASE}/api/client-deliverables/list`, {
        headers: { Authorization: `Bearer ${clientAuth?.token}` },
      })
      setDeliverables(res.data.data || [])
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load deliverables')
    } finally {
      setLoading(false)
    }
  }

  const handleApprove = async (id: string) => {
    setSubmitting(true)
    try {
      await axios.post(
        `${API_BASE}/api/client-deliverables/${id}/approve`,
        {},
        { headers: { Authorization: `Bearer ${clientAuth?.token}` } }
      )
      setSelectedId(null)
      loadDeliverables()
      onDeliverableUpdated?.()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to approve deliverable')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRequestChanges = async (id: string) => {
    if (!feedback.trim()) return
    setSubmitting(true)
    try {
      await axios.post(
        `${API_BASE}/api/client-deliverables/${id}/request-changes`,
        { feedback },
        { headers: { Authorization: `Bearer ${clientAuth?.token}` } }
      )
      setFeedbackModal({ id: '', open: false })
      setFeedback('')
      loadDeliverables()
      onDeliverableUpdated?.()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to send feedback')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500 text-sm">Loading deliverables...</p>
      </div>
    )
  }

  if (deliverables.length === 0) {
    return (
      <div className="text-center py-12">
        <FileText className="w-12 h-12 text-gray-700 mx-auto mb-3" />
        <p className="text-gray-500 text-sm">
          No deliverables yet. Your consultant will send proposals here for your review.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {deliverables.map((deliverable) => (
        <div
          key={deliverable.id}
          className={`border rounded-lg p-4 transition-colors cursor-pointer ${
            selectedId === deliverable.id
              ? 'border-blue-600 bg-blue-950/20'
              : 'border-gray-800 hover:border-gray-700'
          }`}
          onClick={() => setSelectedId(selectedId === deliverable.id ? null : deliverable.id)}
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-blue-400" />
                <h3 className="font-medium text-gray-200">{deliverable.title}</h3>
              </div>
              <p className="text-xs text-gray-500 mb-2">
                {deliverable.documentType} · {deliverable.fileName} (
                {(deliverable.fileSize / 1024).toFixed(0)} KB)
              </p>
              {deliverable.notes && (
                <p className="text-xs text-gray-400 mb-2">{deliverable.notes}</p>
              )}
              <p className="text-xs text-gray-600">
                Received{' '}
                {new Date(deliverable.createdAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </p>
            </div>

            {selectedId === deliverable.id && (
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    handleApprove(deliverable.id)
                  }}
                  disabled={submitting}
                  className="flex items-center gap-1 text-xs bg-green-900/40 hover:bg-green-900/60 disabled:opacity-50 text-green-300 border border-green-700 px-3 py-1.5 rounded transition-colors"
                >
                  {submitting ? (
                    <Loader className="w-3 h-3 animate-spin" />
                  ) : (
                    <CheckCircle className="w-3 h-3" />
                  )}
                  Approve
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    setFeedbackModal({ id: deliverable.id, open: true })
                  }}
                  className="flex items-center gap-1 text-xs bg-orange-900/40 hover:bg-orange-900/60 text-orange-300 border border-orange-700 px-3 py-1.5 rounded transition-colors"
                >
                  <AlertCircle className="w-3 h-3" />
                  Request Changes
                </button>
              </div>
            )}
          </div>

          {/* Threaded discussion — visible only when deliverable is selected */}
          {selectedId === deliverable.id && clientAuth?.token && clientAuth?.user?.id && (
            <div className="mt-4 pt-4 border-t border-gray-800" onClick={(e) => e.stopPropagation()}>
              <DeliverableThread
                deliverableId={deliverable.id}
                authToken={clientAuth.token}
                currentAuthorId={clientAuth.user.id}
                currentAuthorType="CLIENT"
              />
            </div>
          )}
        </div>
      ))}

      {/* Feedback Modal */}
      {feedbackModal.open && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-gray-200 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-orange-400" />
                Request Changes
              </h3>
              <button
                onClick={() => {
                  setFeedbackModal({ id: '', open: false })
                  setFeedback('')
                }}
              >
                <X className="w-5 h-5 text-gray-500 hover:text-gray-300" />
              </button>
            </div>

            <p className="text-xs text-gray-500 mb-4">
              Describe what changes you'd like your consultant to make.
            </p>

            <textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder="e.g., Please update the pricing section and add Q3 performance metrics..."
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 resize-none mb-4"
              rows={4}
            />

            <div className="flex gap-2">
              <button
                onClick={() => {
                  setFeedbackModal({ id: '', open: false })
                  setFeedback('')
                }}
                className="flex-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 px-3 py-2 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRequestChanges(feedbackModal.id)}
                disabled={!feedback.trim() || submitting}
                className="flex-1 flex items-center justify-center gap-2 text-xs bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white px-3 py-2 rounded transition-colors"
              >
                {submitting ? (
                  <Loader className="w-3 h-3 animate-spin" />
                ) : (
                  <Send className="w-3 h-3" />
                )}
                Send Feedback
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

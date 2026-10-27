import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, Loader, ArrowLeft, Star } from 'lucide-react'
import axios from 'axios'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

function getAuthToken(): string {
  try {
    const raw = localStorage.getItem('bytescon_auth')
    return raw ? (JSON.parse(raw).token ?? '') : ''
  } catch { return '' }
}

export default function Feedback() {
  const [npsScore, setNpsScore] = useState<number | null>(null)
  const [killFeature, setKillFeature] = useState('')
  const [addFeature, setAddFeature] = useState('')
  const [freeText, setFreeText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (npsScore === null) {
      setErrorMsg('Please pick an NPS score before submitting.')
      return
    }
    setSubmitting(true)
    setErrorMsg('')
    try {
      const res = await axios.post(
        `${API_BASE}/api/beta/feedback`,
        {
          npsScore,
          killFeature: killFeature.trim() || undefined,
          addFeature: addFeature.trim() || undefined,
          freeText: freeText.trim() || undefined,
        },
        { headers: { Authorization: `Bearer ${getAuthToken()}` } },
      )
      if (res.data?.success) {
        setSubmitted(true)
      } else {
        setErrorMsg(res.data?.error || 'Submission failed.')
      }
    } catch (err: any) {
      setErrorMsg(err?.response?.data?.error || err?.message || 'Network error.')
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: 'var(--bg)' }}>
        <div className="card max-w-md w-full text-center py-12 px-8 animate-fade-up" style={{ boxShadow: 'var(--shadow-2)' }}>
          <div className="flex justify-center mb-4">
            <span className="tile tile-success" style={{ width: '3.5rem', height: '3.5rem', borderRadius: '14px' }}><CheckCircle className="w-6 h-6" /></span>
          </div>
          <h1 className="page-title mb-2">Thanks for the feedback</h1>
          <p className="text-sm text-slate-400 mb-6">
            We read every response. Material decisions will appear in subsequent product updates.
          </p>
          <Link to="/dashboard" className="btn-secondary btn-sm">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to dashboard
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen px-6 py-12" style={{ background: 'var(--bg)' }}>
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-10">
          <p className="overline mb-3" style={{ color: 'var(--accent-3)' }}>Product Feedback</p>
          <h1 className="text-3xl font-semibold mb-3" style={{ letterSpacing: '-0.025em', color: 'var(--text)' }}>
            Tell us what's working
          </h1>
          <p className="text-sm text-slate-400 max-w-xl mx-auto">
            Three short questions. Your answers go directly into the calibration backlog and the
            investor-pitch traction snapshot. Required: NPS score; everything else is optional.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="card p-6 sm:p-7 space-y-7">
            <div>
              <label className="block text-sm font-semibold mb-2.5" style={{ color: 'var(--text)' }}>
                On a scale of 0–10, how likely are you to recommend Bytescon to another consultant?
              </label>
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setNpsScore(n)}
                    className="w-10 h-10 rounded-lg text-sm font-semibold tabular-nums transition-colors"
                    style={{
                      background: npsScore === n
                        ? 'var(--accent)'
                        : 'var(--surface-2)',
                      border: npsScore === n
                        ? '1px solid var(--accent)'
                        : '1px solid var(--line)',
                      color: npsScore === n ? 'var(--surface)' : 'var(--text-2)',
                    }}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-slate-500 mt-2">
                0 = "would actively warn them off" · 10 = "already recommended"
              </p>
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2.5" style={{ color: 'var(--text)' }}>
                If you could remove one feature, what would it be?
              </label>
              <textarea
                value={killFeature}
                onChange={(e) => setKillFeature(e.target.value)}
                rows={3}
                className="input resize-none"
                placeholder="(optional)"
                disabled={submitting}
              />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2.5" style={{ color: 'var(--text)' }}>
                If you could add one feature, what would it be?
              </label>
              <textarea
                value={addFeature}
                onChange={(e) => setAddFeature(e.target.value)}
                rows={3}
                className="input resize-none"
                placeholder="(optional)"
                disabled={submitting}
              />
            </div>

            <div>
              <label className="block text-sm font-semibold mb-2.5" style={{ color: 'var(--text)' }}>
                Anything else we should know?
              </label>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                rows={4}
                className="input resize-none"
                placeholder="(optional)"
                disabled={submitting}
              />
            </div>

            {errorMsg && (
              <div className="text-sm rounded-lg px-3 py-2.5 animate-fade-up" style={{ color: 'var(--danger)', background: 'var(--danger-bg)', border: '1px solid var(--danger-border)' }}>
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || npsScore === null}
              className="btn-primary w-full py-3 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? (
                <>
                  <Loader className="w-4 h-4 animate-spin" /> Submitting…
                </>
              ) : (
                <>
                  <Star className="w-4 h-4" /> Submit feedback
                </>
              )}
            </button>
          </div>
        </form>

        <div className="text-center mt-6">
          <Link to="/dashboard" className="btn-ghost btn-sm">
            <ArrowLeft className="w-3 h-3" /> Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}

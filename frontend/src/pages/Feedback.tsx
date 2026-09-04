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
      <div className="min-h-screen flex items-center justify-center px-6" style={{ background: '#0b0b0f' }}>
        <div className="max-w-md w-full text-center card-gold py-12 px-8" style={{ borderRadius: '16px' }}>
          <div className="flex justify-center mb-4">
            <CheckCircle className="w-12 h-12 text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold text-slate-100 mb-2">Thanks for the feedback</h1>
          <p className="text-sm text-slate-400 mb-6">
            We read every response. Material decisions will appear in subsequent product updates.
          </p>
          <Link to="/dashboard" className="text-sm text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">
            <ArrowLeft className="w-3.5 h-3.5" /> Back to dashboard
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen px-6 py-12" style={{ background: '#0b0b0f' }}>
      <div className="max-w-2xl mx-auto">
        <div className="text-center mb-10">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-amber-400 mb-3">Product Feedback</p>
          <h1 className="text-3xl font-black text-slate-100 mb-3" style={{ letterSpacing: '-0.02em' }}>
            Tell us what's working
          </h1>
          <p className="text-sm text-slate-400 max-w-xl mx-auto">
            Three short questions. Your answers go directly into the calibration backlog and the
            investor-pitch traction snapshot. Required: NPS score; everything else is optional.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="card-gold p-6 space-y-6" style={{ borderRadius: '12px' }}>
            <div>
              <label className="block text-sm font-semibold text-slate-200 mb-2">
                On a scale of 0–10, how likely are you to recommend Bytescon to another consultant?
              </label>
              <div className="flex flex-wrap gap-2">
                {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setNpsScore(n)}
                    className="w-10 h-10 rounded-lg text-sm font-semibold transition-all"
                    style={{
                      background: npsScore === n
                        ? 'linear-gradient(90deg, #7b8fff, #5b74ff)'
                        : 'rgba(255,255,255,0.04)',
                      border: npsScore === n
                        ? '1px solid rgba(91,116,255,0.6)'
                        : '1px solid rgba(255,255,255,0.08)',
                      color: npsScore === n ? '#131318' : '#b3aebb',
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
              <label className="block text-sm font-semibold text-slate-200 mb-2">
                If you could remove one feature, what would it be?
              </label>
              <textarea
                value={killFeature}
                onChange={(e) => setKillFeature(e.target.value)}
                rows={3}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-500 transition-colors resize-none"
                placeholder="(optional)"
                disabled={submitting}
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-200 mb-2">
                If you could add one feature, what would it be?
              </label>
              <textarea
                value={addFeature}
                onChange={(e) => setAddFeature(e.target.value)}
                rows={3}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-500 transition-colors resize-none"
                placeholder="(optional)"
                disabled={submitting}
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-200 mb-2">
                Anything else we should know?
              </label>
              <textarea
                value={freeText}
                onChange={(e) => setFreeText(e.target.value)}
                rows={4}
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-2.5 text-sm text-slate-100 outline-none focus:border-amber-500 transition-colors resize-none"
                placeholder="(optional)"
                disabled={submitting}
              />
            </div>

            {errorMsg && (
              <div className="text-sm text-red-400 bg-red-950/30 border border-red-800/40 rounded-lg px-3 py-2">
                {errorMsg}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting || npsScore === null}
              className="btn-primary w-full text-sm py-3 flex items-center justify-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
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
          <Link to="/dashboard" className="text-xs text-slate-600 hover:text-slate-400 inline-flex items-center gap-1">
            <ArrowLeft className="w-3 h-3" /> Back to dashboard
          </Link>
        </div>
      </div>
    </div>
  )
}

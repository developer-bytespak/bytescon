import { useState, useEffect } from 'react'
import { Shield, AlertTriangle, FileText, CheckCircle, ChevronDown, ChevronRight, Loader, AlertCircle, Sparkles, Quote } from 'lucide-react'
import axios from 'axios'
import { humanize } from '../lib/humanize'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

function getAuthToken(): string {
  try {
    const raw = localStorage.getItem('bytesgov_auth')
    return raw ? (JSON.parse(raw).token ?? '') : ''
  } catch { return '' }
}

interface ComplianceGap {
  clauseCode: string
  category: 'FAR' | 'DFARS' | 'SET_ASIDE' | 'OTHER'
  title: string
  shortDescription: string
  plainLanguage: string
  requirementType: string
  documentNeeded?: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  detected: boolean
  status: 'GAP' | 'MET' | 'UNKNOWN'
  recommendation: string
  detectedBy?: 'KEYWORD' | 'AI' | 'BOTH'
  aiConfidence?: number
  aiExcerpt?: string
}

interface AnalysisResult {
  opportunityId: string
  opportunityTitle: string
  agency: string
  setAsideType: string | null
  totalClauses: number
  criticalGaps: number
  highGaps: number
  mediumGaps: number
  lowGaps: number
  gaps: ComplianceGap[]
  recommendations: string[]
  aiExtraction?: {
    enabled: boolean
    modelUsed: string
    tokensUsed: number
    cached: boolean
    aiOnlyClauseCount: number
  }
}

interface Props {
  opportunityId: string
}

// Severity is the only colour on a gap: red for critical, amber for high.
const SEVERITY_CHIP: Record<string, string> = {
  CRITICAL: 'chip-danger',
  HIGH: 'badge-yellow',
  MEDIUM: 'chip-neutral',
  LOW: 'chip-neutral',
}

const CATEGORY_LABEL: Record<string, string> = { FAR: 'FAR', DFARS: 'DFARS', SET_ASIDE: 'Set-aside', OTHER: 'Other' }

const SOURCE_BADGE: Record<string, { label: string }> = {
  KEYWORD: { label: 'Keyword' },
  AI: { label: 'AI' },
  BOTH: { label: 'AI + keyword' },
}

// Recommendations arrive with a leading emoji; the list reads plainly without it.
const plainLine = (s: string) => s.replace(/^[^\p{L}\p{N}]+/u, '')

export function ComplianceGapAnalysis({ opportunityId }: Props) {
  const [data, setData] = useState<AnalysisResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [aiLoading, setAiLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedClause, setExpandedClause] = useState<string | null>(null)
  const [useAi, setUseAi] = useState(false)

  const fetchAnalysis = (withAi: boolean) => {
    let cancelled = false
    setLoading(!data) // only show full loader on initial load
    if (data && withAi) setAiLoading(true)
    axios
      .get(`${API_BASE}/api/compliance-matrix/${opportunityId}/gap-analysis${withAi ? '?ai=true' : ''}`, {
        headers: { Authorization: `Bearer ${getAuthToken()}` },
      })
      .then((res) => {
        if (!cancelled) setData(res.data.data)
      })
      .catch((err: any) => {
        if (!cancelled) setError(err?.response?.data?.error || 'Failed to load gap analysis')
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setAiLoading(false)
        }
      })
    return () => { cancelled = true }
  }

  useEffect(() => {
    return fetchAnalysis(useAi)
  }, [opportunityId])

  const handleAiToggle = () => {
    const next = !useAi
    setUseAi(next)
    fetchAnalysis(next)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="w-5 h-5 animate-spin text-gray-500" />
        <span className="ml-2 text-sm text-gray-500">Analyzing compliance requirements...</span>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="rounded-xl p-4 text-sm flex gap-2" role="alert" style={{ background: 'var(--danger-bg)', color: 'var(--danger-text)' }}>
        <AlertCircle className="w-5 h-5 flex-shrink-0" />
        <p>{error || 'No analysis available'}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Shield className="w-5 h-5 text-gray-400" />
          <h2 className="v3-h3 text-gray-100">Compliance gap analysis</h2>
        </div>
        <button
          onClick={handleAiToggle}
          disabled={aiLoading}
          aria-pressed={useAi}
          className="btn-secondary btn-sm disabled:opacity-50"
        >
          {aiLoading ? <Loader className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
          {useAi ? 'AI extraction on' : 'Augment with AI'}
        </button>
      </div>

      {data?.aiExtraction && (
        <div className="panel text-xs text-gray-500 px-3 py-2 flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-gray-400" />
          <span>
            {data.aiExtraction.cached ? 'Cached AI analysis' : 'Fresh AI analysis'}
            {data.aiExtraction.modelUsed !== 'none' && ` · ${data.aiExtraction.modelUsed}`}
            {data.aiExtraction.tokensUsed > 0 && ` · ${data.aiExtraction.tokensUsed} tokens`}
            {data.aiExtraction.aiOnlyClauseCount > 0 && ` · ${data.aiExtraction.aiOnlyClauseCount} new clauses found`}
          </span>
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {([
          ['Critical', data.criticalGaps, 'var(--danger-text)'],
          ['High', data.highGaps, 'var(--warning)'],
          ['Medium', data.mediumGaps, 'var(--text)'],
          ['Low', data.lowGaps, 'var(--text)'],
        ] as const).map(([name, count, tone]) => (
          <div key={name} className="panel p-4">
            <p className="text-[13px] text-gray-400 mb-1">{name}</p>
            <p className="text-[28px] leading-8 font-semibold tabular-nums" style={{ color: count > 0 ? tone : 'var(--text)' }}>{count}</p>
          </div>
        ))}
      </div>

      {/* Top recommendations */}
      {data.recommendations.length > 0 && (
        <div className="panel p-4">
          <p className="text-[13px] font-semibold text-gray-200 mb-2">Action required</p>
          <ul className="space-y-1.5">
            {data.recommendations.map((r, i) => (
              <li key={i} className="text-sm text-gray-300">{plainLine(r)}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Gaps list */}
      <div className="space-y-2">
        {data.gaps.length === 0 ? (
          <div className="text-center py-8 text-gray-500 text-sm">
            <CheckCircle className="w-8 h-8 mx-auto mb-2 text-gray-500" />
            No compliance gaps detected for this opportunity.
          </div>
        ) : (
          data.gaps.map((gap) => {
            const isExpanded = expandedClause === gap.clauseCode
            return (
              <div
                key={gap.clauseCode}
                className="panel cursor-pointer transition-colors"
                onClick={() => setExpandedClause(isExpanded ? null : gap.clauseCode)}
              >
                <div className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <span className={`chip ${SEVERITY_CHIP[gap.severity] ?? 'chip-neutral'}`}>
                          {humanize(gap.severity)}
                        </span>
                        <span className="chip">
                          {CATEGORY_LABEL[gap.category] ?? humanize(gap.category)}
                        </span>
                        {gap.detectedBy && SOURCE_BADGE[gap.detectedBy] && (
                          <span className="chip">
                            {SOURCE_BADGE[gap.detectedBy].label}
                            {gap.aiConfidence !== undefined && ` ${Math.round(gap.aiConfidence * 100)}%`}
                          </span>
                        )}
                        <span className="text-xs text-gray-500 tabular-nums">{gap.clauseCode}</span>
                      </div>
                      <h3 className="font-semibold text-sm text-gray-100">{gap.title}</h3>
                      <p className="text-xs text-gray-400 mt-1">{gap.shortDescription}</p>
                    </div>
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-gray-500 flex-shrink-0" /> : <ChevronRight className="w-4 h-4 text-gray-500 flex-shrink-0" />}
                  </div>

                  {isExpanded && (
                    <div className="mt-3 pt-3 space-y-3" style={{ borderTop: '1px solid var(--line)' }}>
                      <div>
                        <p className="text-[13px] font-semibold text-gray-200 mb-1">What this means in plain language</p>
                        <p className="text-sm text-gray-300 leading-relaxed">{gap.plainLanguage}</p>
                      </div>

                      {gap.aiExcerpt && (
                        <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'var(--surface)' }}>
                          <Quote className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-gray-200 mb-0.5">AI evidence (verbatim from the document)</p>
                            <p className="text-sm text-gray-300 italic leading-relaxed break-words">"{gap.aiExcerpt}"</p>
                          </div>
                        </div>
                      )}

                      {gap.documentNeeded && (
                        <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'var(--surface)' }}>
                          <FileText className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                          <div>
                            <p className="text-[13px] font-semibold text-gray-200 mb-0.5">Document needed</p>
                            <p className="text-sm text-gray-300">{gap.documentNeeded}</p>
                          </div>
                        </div>
                      )}

                      <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'var(--surface)' }}>
                        <AlertTriangle className="w-4 h-4 text-gray-400 flex-shrink-0 mt-0.5" />
                        <div>
                          <p className="text-[13px] font-semibold text-gray-200 mb-0.5">Recommendation</p>
                          <p className="text-sm text-gray-300">{gap.recommendation}</p>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

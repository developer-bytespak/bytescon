import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { opportunitiesApi, jobsApi, documentsApi, clientsApi, decisionsApi, complianceMatrixApi, proposalAssistApi } from '../services/api'
import { ComplianceGapAnalysis } from '../components/ComplianceGapAnalysis'
import { OpportunityIntelPanel } from '../components/section6/OpportunityIntelPanel'
import { OpportunityCrmPanel } from '../components/crm/OpportunityCrmPanel'
import { ProposalAttestationPanel } from '../components/ProposalAttestationPanel'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEntitlements } from '../hooks/useEntitlements'
import { Link } from 'react-router-dom'
import { ScoreBreakdown } from '../components/ScoreBreakdown'
import { SubcontractingPath } from '../components/scw/SubcontractingPath'
import { useRecentlyViewed } from '../hooks/useRecentlyViewed'
import { useFavorites } from '../hooks/useFavorites'
import {
  Upload, FileText, Loader, CheckCircle, AlertCircle,
  ExternalLink, Trophy, Users, TrendingUp, Shield,
  Download, ArrowLeft, BookOpen, Send, Mail, ClipboardList, DollarSign, Award,
  UserCheck, BarChart3, Table2, RefreshCw, Pencil, Lightbulb, Target, AlertTriangle, Star, Zap, Trash2, FileDown, StarOff,
} from 'lucide-react'
import { parseSubmissionInstructions } from '../utils/parseSubmission'
import { buildContractSynopsis } from '../utils/contractSynopsis'
import { resolveSourceUrl, sourceLinkLabel } from '../lib/samUrl'
import { useAiJobProgress } from '../hooks/useAiJobProgress'
import { AiProgressIndicator } from '../components/AiProgressIndicator'
import { useToast } from '../components/Toast'

interface Amendment {
  id: string
  title?: string
  description?: string
  amendmentNumber?: string
  postedDate?: string
  plainLanguageSummary?: string
  interpretedAt?: string
}

interface Document {
  id: string
  fileName: string
  fileType: string
  fileUrl?: string
  analysisStatus: string
  alignmentScore?: number
  complexityScore?: number
  incumbentSignals?: string[]
  scopeKeywords?: string[]
  uploadedAt: string
}

interface OpportunityDetail {
  id: string
  samNoticeId?: string
  title: string
  agency: string
  naicsCode: string
  naicsDescription?: string
  responseDeadline: string
  probabilityScore?: number
  expectedValue?: number
  sourceUrl?: string
  setAsideType?: string
  estimatedValue?: number
  estimatedValueMin?: number
  estimatedValueMax?: number
  description?: string
  placeOfPerformance?: string
  amendments?: Amendment[]
  documents?: Document[]
  scoreBreakdown?: any
  isEnriched?: boolean
  historicalWinner?: string
  historicalAvgAward?: number
  historicalAwardCount?: number
  competitionCount?: number
  incumbentProbability?: number
  agencySdvosbRate?: number
  agencySmallBizRate?: number
  recompeteFlag?: boolean
  incumbentSignalDetected?: boolean
  deadlineClassification?: { priority: string; daysUntilDeadline: number; label: string }
  pocName?: string
  pocEmail?: string
  pocPhone?: string
  pocTitle?: string
  isDemo?: boolean
  source?: string
}

export default function OpportunityDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { toast } = useToast()
  const queryClient = useQueryClient()

  const [data, setData] = useState<OpportunityDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null)
  const [analyzeStatus, setAnalyzeStatus] = useState<'idle' | 'running' | 'complete' | 'error'>('idle')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedClientId, setSelectedClientId] = useState<string>('')
  const [clientScore, setClientScore] = useState<any>(null)
  const [scoringClient, setScoringClient] = useState(false)
  const [scoreError, setScoreError] = useState('')

  const { addView } = useRecentlyViewed()
  const { isFavorite, toggleFavorite } = useFavorites()

  // Compliance matrix
  const [matrix, setMatrix] = useState<any>(null)
  const [matrixLoading, setMatrixLoading] = useState(false)
  const [matrixGenerating, setMatrixGenerating] = useState(false)
  const [matrixError, setMatrixError] = useState('')
  const [editingReqId, setEditingReqId] = useState<string | null>(null)
  const [editProposalSection, setEditProposalSection] = useState('')

  // Bid guidance / win strategy
  const [guidance, setGuidance] = useState<any>(null)
  const bidGuidanceJob = useAiJobProgress({
    expectedSec: 30,
    phases: [
      { atSec: 0, label: 'Sending request…' },
      { atSec: 3, label: 'Reading the solicitation…' },
      { atSec: 10, label: 'Extracting bid strategy…' },
      { atSec: 22, label: 'Finalizing…' },
      { atSec: 40, label: 'Still working — almost there…' },
    ],
  })
  const guidanceGenerating = bidGuidanceJob.running
  const [guidanceError, setGuidanceError] = useState('')

  // Proposal Writing Assistant
  const [proposalOutline, setProposalOutline] = useState<any>(null)
  const outlineJob = useAiJobProgress({
    expectedSec: 40,
    phases: [
      { atSec: 0, label: 'Sending request…' },
      { atSec: 3, label: 'Reviewing the opportunity…' },
      { atSec: 12, label: 'Drafting the outline…' },
      { atSec: 28, label: 'Finalizing…' },
      { atSec: 45, label: 'Still working — almost there…' },
    ],
  })
  const proposalGenerating = outlineJob.running
  const [proposalError, setProposalError] = useState('')
  const [draftGenerating, setDraftGenerating] = useState(false)
  // Client selected for proposal branding. Empty string = use firm default
  // branding. Stored as a state so the picker controls it; when set, the
  // Generate Draft request includes clientCompanyId and the resulting PDF
  // reflects that client's branding (cover colors, logo, prepared-by line).
  const [proposalClientId, setProposalClientId] = useState<string>('')
  const [draftDownloadUrl, setDraftDownloadUrl] = useState<string | null>(null)
  const [draftFileName, setDraftFileName] = useState('')
  const [hasSavedDraft, setHasSavedDraft] = useState(false)
  // Set when the LLM hit max_tokens and the recovery path returned only the
  // sections it could salvage. Triggers a yellow review-required banner
  // instead of the green ready toast.
  const [draftPartial, setDraftPartial] = useState(false)
  const [savedDraftAt, setSavedDraftAt] = useState<string | null>(null)
  const [tokenBalance, setTokenBalance] = useState<number | null>(null)

  // Q&A interview state
  const [proposalStep, setProposalStep] = useState<'idle' | 'outlined' | 'answering'>('idle')
  const [proposalQuestions, setProposalQuestions] = useState<any[]>([])
  const [proposalAnswers, setProposalAnswers] = useState<Record<string, { answer: string; aiDecide: boolean }>>({})
  const [questionsLoading, setQuestionsLoading] = useState(false)

  // Bid forms upload state
  const [bidForms, setBidForms] = useState<Array<{ name: string; text: string }>>([])
  const [bidFormUploading, setBidFormUploading] = useState(false)
  const [bidFormError, setBidFormError] = useState('')
  const bidFormInputRef = useRef<HTMLInputElement>(null)
  // Anchor for the post-generation success card. The card lives at the bottom
  // of the Step 3 panel, below the long question list — without an explicit
  // scroll the user often misses it after the 3–5 minute generation wait and
  // assumes nothing happened until they reload.
  const draftSuccessRef = useRef<HTMLDivElement>(null)

  const { hasAddon } = useEntitlements()

  const fetchOpportunity = async () => {
    if (!id) return
    try {
      const res = await opportunitiesApi.getById(id)
      const opp = res.data ?? res
      setData(opp)
      // Track in recently viewed
      addView({
        id: opp.id,
        title: opp.title,
        agency: opp.agency,
        deadline: opp.responseDeadline,
      })
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  const fetchMatrix = async () => {
    // The compliance matrix is part of the Contract Analysis module — the
    // backend 403s without it, so skip the call entirely when unentitled.
    if (!id || !hasAddon('contract_analysis')) return
    setMatrixLoading(true)
    try {
      const res = await complianceMatrixApi.get(id)
      const m = res.data ?? null
      setMatrix(m)
      if (m?.bidGuidanceJson) {
        setGuidance({ ...m.bidGuidanceJson, generatedAt: m.bidGuidanceAt ?? undefined })
      }
    } catch { /* non-fatal */ } finally {
      setMatrixLoading(false)
    }
  }

  const handleGenerateBidGuidance = async () => {
    if (!id || bidGuidanceJob.running) return
    setGuidanceError('')
    const res = await bidGuidanceJob.run(
      (signal) => complianceMatrixApi.generateBidGuidance(id, signal),
      (err: any) => {
        const code = err?.response?.data?.error
        const text =
          code === 'NO_AI_KEY'
            ? 'AI features aren’t enabled yet — contact your administrator to turn them on.'
            : err?.response?.data?.message || 'Generation failed. Please try again.'
        setGuidanceError(text)
        return text
      },
    )
    if (res) setGuidance(res.data)
  }

  const handleGenerateMatrix = async () => {
    if (!id) return
    setMatrixGenerating(true)
    setMatrixError('')
    try {
      const res = await complianceMatrixApi.generate(id)
      setMatrix(res.data)
    } catch (err: any) {
      setMatrixError(err?.response?.data?.error || 'Generation failed')
    } finally {
      setMatrixGenerating(false)
    }
  }

  const handleUpdateRequirement = async (reqId: string, proposalSection: string) => {
    try {
      const res = await complianceMatrixApi.updateRequirement(reqId, { proposalSection })
      setMatrix((prev: any) => prev ? {
        ...prev,
        requirements: prev.requirements.map((r: any) => r.id === reqId ? res.data : r),
      } : prev)
    } catch { /* non-fatal */ } finally {
      setEditingReqId(null)
    }
  }

  const handleCycleStatus = async (req: any) => {
    const cycle = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'WAIVED', 'NON_COMPLIANT']
    const next = cycle[(cycle.indexOf(req.status) + 1) % cycle.length]
    try {
      const res = await complianceMatrixApi.updateRequirement(req.id, { status: next })
      setMatrix((prev: any) => prev ? {
        ...prev,
        requirements: prev.requirements.map((r: any) => r.id === req.id ? res.data : r),
      } : prev)
    } catch { /* non-fatal */ }
  }

  const handleProposalError = (err: any, fallback: string) => {
    const code = err?.response?.data?.error
    const status = err?.response?.status
    if (code === 'NO_TOKENS') {
      setProposalError(err?.response?.data?.message || 'No proposal tokens remaining. Purchase more in Billing.')
    } else if (code === 'AI_LIMIT') {
      setProposalError(err?.response?.data?.message || 'AI call limit reached.')
    } else if (code === 'NO_AI_KEY') {
      setProposalError('AI key not configured — go to Settings → AI Intelligence Provider.')
    } else if (code === 'RATE_LIMITED' || status === 429) {
      setProposalError('Claude rate limit reached — please wait 60 seconds and try again.')
    } else {
      setProposalError(err?.response?.data?.message || fallback)
    }
  }

  const handleGenerateProposalOutline = async () => {
    if (!id || outlineJob.running) return
    setProposalError('')
    setProposalStep('idle')
    setProposalQuestions([])
    setProposalAnswers({})
    const res = await outlineJob.run(
      (signal) => proposalAssistApi.generateOutline(id, signal),
      (err: any) => {
        handleProposalError(err, 'Generation failed — check your AI provider in Settings.')
        return 'error'
      },
    )
    if (!res) return
    setProposalOutline(res.data)
    if (res.tokensRemaining !== undefined) setTokenBalance(res.tokensRemaining)
    setProposalStep('outlined')
    // Persist outline so it survives page navigation
    proposalAssistApi.saveDraft(id, { outline: res.data, step: 'outlined' }).catch(() => {})
    // Auto-fetch questions after outline
    handleGenerateQuestions(res.data)
  }

  const handleGenerateQuestions = async (outline: any) => {
    if (!id) return
    setQuestionsLoading(true)
    try {
      const res = await proposalAssistApi.generateQuestions(id, outline)
      setProposalQuestions(res.data ?? [])
      setProposalStep('answering')
    } catch {
      // Non-fatal — user can still generate draft without Q&A
      setProposalStep('outlined')
    } finally {
      setQuestionsLoading(false)
    }
  }

  const handleSkipAllQuestions = () => {
    const aiAll: Record<string, { answer: string; aiDecide: boolean }> = {}
    proposalQuestions.forEach(q => { aiAll[q.id] = { answer: '', aiDecide: true } })
    setProposalAnswers(aiAll)
  }

  const handleBidFormUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !id) return
    setBidFormUploading(true)
    setBidFormError('')
    try {
      const formData = new FormData()
      formData.append('file', file)
      const res = await import('../services/api').then(m => m.api.post(
        `/proposal-assist/${id}/extract-form`,
        formData,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: 60000 }
      ))
      if (res.data?.success) {
        setBidForms(prev => [...prev, { name: res.data.fileName, text: res.data.text }])
      } else {
        setBidFormError('Failed to extract form content.')
      }
    } catch (err: any) {
      setBidFormError(err?.response?.data?.error || 'Upload failed — check file format.')
    } finally {
      setBidFormUploading(false)
      if (bidFormInputRef.current) bidFormInputRef.current.value = ''
    }
  }

  const handleGenerateDraftPdf = async () => {
    if (!id) return
    // Anchor recovery to the moment of the click. The server's persist-then-deduct
    // contract guarantees that any draftGeneratedAt >= clickedAt is from THIS
    // attempt, regardless of how long the LLM/PDF round-trip took. Using a wall-
    // clock window races the 600s axios timeout and was the cause of "tokens
    // deducted, no PDF" reports.
    const clickedAt = Date.now()
    setDraftGenerating(true)
    setProposalError('')
    setDraftDownloadUrl(null)
    setDraftFileName('')
    // Persist answers before generating so work isn't lost on timeout/error
    proposalAssistApi.saveDraft(id, { outline: proposalOutline, answers: proposalAnswers, step: proposalStep }).catch(() => {})
    try {
      const answersArray = proposalQuestions.map(q => ({
        questionId: q.id,
        category: q.category,
        question: q.question,
        answer: proposalAnswers[q.id]?.answer ?? '',
        aiDecide: proposalAnswers[q.id]?.aiDecide ?? false,
      }))
      const bidFormContext = bidForms.length > 0
        ? bidForms.map(f => `[${f.name}]\n${f.text}`).join('\n\n---\n\n').slice(0, 4000)
        : undefined
      const { blob, partial } = await proposalAssistApi.generateDraftPdf(
        id,
        answersArray,
        undefined,
        bidFormContext,
        proposalClientId || undefined,
      )
      const url = URL.createObjectURL(blob)
      const fileName = `Proposal_Draft_${id.slice(0, 8)}.pdf`
      // Store URL so user can click the download link manually (browser popup blockers
      // often block programmatic a.click() from async callbacks)
      setDraftDownloadUrl(url)
      setDraftFileName(fileName)
      // Server now persists the draft — record metadata so reopen doesn't re-bill
      setHasSavedDraft(true)
      setSavedDraftAt(new Date().toISOString())
      setDraftPartial(partial)
      // A regenerated draft changes the content hash: any prior attestation is
      // now stale server-side, so refresh the panel or it keeps offering a
      // "Download Final" that 403s.
      void queryClient.invalidateQueries({ queryKey: ['proposal-attestation', id] })
      // Also attempt auto-download as a convenience
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      // Deduct 5 tokens from local display
      setTokenBalance(prev => prev !== null ? Math.max(0, prev - 5) : null)
      // Scroll the success card into view after the commit so the user sees it
      // immediately. Without this, the card renders below the question list and
      // is often missed until the user reloads (which then surfaces the saved-
      // draft banner higher in the panel).
      setTimeout(() => {
        draftSuccessRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 100)
      if (partial) {
        toast('Draft generated, but the AI hit its length limit. Review carefully before submission.', 'warning')
      } else {
        toast('Proposal draft ready — download started.', 'success')
      }
    } catch (err: any) {
      // Server may have completed and persisted the PDF after the client timed out.
      // Check the saved-draft endpoint before reporting failure so the user can recover.
      try {
        const saved: any = await proposalAssistApi.getSaved(id)
        const data = saved?.data
        const generatedAt = data?.draftGeneratedAt ? new Date(data.draftGeneratedAt).getTime() : 0
        // 5s tolerance handles minor client/server clock skew. Anything earlier
        // than the click is a previous-generation artifact and must NOT be served
        // here as if the new attempt succeeded.
        const persistedFromThisAttempt = generatedAt >= clickedAt - 5_000
        if (data?.hasDraftPdf && persistedFromThisAttempt) {
          const blob = await proposalAssistApi.downloadSavedDraftPdf(id)
          const url = URL.createObjectURL(blob)
          const fileName = `Proposal_Draft_${id.slice(0, 8)}.pdf`
          setDraftDownloadUrl(url)
          setDraftFileName(fileName)
          setHasSavedDraft(true)
          setSavedDraftAt(data.draftGeneratedAt ?? new Date().toISOString())
          setDraftPartial(Boolean(data.draftPartial))
          void queryClient.invalidateQueries({ queryKey: ['proposal-attestation', id] })
          const a = document.createElement('a')
          a.href = url
          a.download = fileName
          document.body.appendChild(a)
          a.click()
          document.body.removeChild(a)
          setTimeout(() => {
            draftSuccessRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }, 100)
          if (data.draftPartial) {
            toast('Draft recovered, but the AI hit its length limit. Review carefully before submission.', 'warning')
          } else {
            toast('Proposal draft ready — download started.', 'success')
          }
          return
        }
      } catch { /* recovery best-effort; fall through to error */ }
      handleProposalError(err, 'Draft generation failed — check your AI key in Settings.')
    } finally {
      setDraftGenerating(false)
    }
  }

  useEffect(() => {
    // Clear stale data immediately when opportunity ID changes
    setData(null)
    setError(false)
    setLoading(true)
    setMatrix(null)
    setMatrixError('')
    setMatrixLoading(false)
    setGuidance(null)
    setGuidanceError('')
    setProposalOutline(null)
    setProposalError('')
    setProposalStep('idle')
    setProposalQuestions([])
    setProposalAnswers({})
    setBidForms([])
    setBidFormError('')
    setClientScore(null)
    setScoreError('')
    setAnalyzeStatus('idle')
    setUploadError('')
    if (pollRef.current) { clearTimeout(pollRef.current as any); pollRef.current = null }

    fetchOpportunity()
    fetchMatrix()

    // Restore saved proposal outline/answers if they exist
    setHasSavedDraft(false)
    setSavedDraftAt(null)
    setDraftPartial(false)
    if (id) {
      proposalAssistApi.getSaved(id).then((res: any) => {
        const saved = res?.data
        if (saved?.outline) {
          setProposalOutline(saved.outline)
          setProposalStep(saved.step || 'outlined')
        }
        if (saved?.answers) {
          setProposalAnswers(saved.answers)
        }
        if (saved?.hasDraftPdf) {
          setHasSavedDraft(true)
          setSavedDraftAt(saved.draftGeneratedAt ?? null)
          setDraftPartial(Boolean(saved.draftPartial))
        }
      }).catch(() => {}) // ignore — just means no saved state
    }
    return () => { if (pollRef.current) { clearTimeout(pollRef.current as any); pollRef.current = null } }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: reset + refetch only when the opportunity id changes; fetchOpportunity/fetchMatrix are stable component closures
  }, [id])

  const { data: clientsData } = useQuery({
    queryKey: ['clients-list'],
    queryFn: () => clientsApi.list({ limit: 200 }),
  })
  const clients: any[] = (clientsData?.data ?? []).slice().sort((a: any, b: any) => (b.probabilityScore ?? 0) - (a.probabilityScore ?? 0))

  const runClientScore = async (clientId: string) => {
    if (!clientId || !id) return
    setScoringClient(true)
    setScoreError('')
    setClientScore(null)
    try {
      const res = await decisionsApi.run(id, clientId)
      setClientScore(res.data ?? res)
    } catch (err: any) {
      setScoreError(err?.response?.data?.error || 'Scoring failed')
    } finally {
      setScoringClient(false)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (!files || files.length === 0 || !id) return
    setUploading(true)
    setUploadError('')

    const failures: string[] = []
    let lastAnalysisJobId: string | null = null
    let anyAnalysisStarted = false

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi]
      try {
        if (file.name.toLowerCase().endsWith('.zip')) {
          const zipRes = await documentsApi.uploadZip(id, file)
          const extracted: any[] = zipRes.data ?? []
          for (const doc of extracted) {
            try {
              const jobRes = await jobsApi.triggerDocumentAnalysis(doc.id)
              lastAnalysisJobId = jobRes.data?.jobId ?? jobRes.jobId ?? lastAnalysisJobId
              anyAnalysisStarted = true
            } catch (err: any) {
              failures.push(`${doc.fileName}: analysis trigger failed`)
            }
          }
          continue
        }
        const uploadRes = await documentsApi.upload(id, file)
        const documentId = uploadRes.data?.id ?? uploadRes.id
        const jobRes = await jobsApi.triggerDocumentAnalysis(documentId)
        lastAnalysisJobId = jobRes.data?.jobId ?? jobRes.jobId ?? lastAnalysisJobId
        anyAnalysisStarted = true
      } catch (err: any) {
        const reason = err?.response?.data?.error || err?.message || 'upload failed'
        failures.push(`${file.name}: ${reason}`)
      }
    }

    fetchOpportunity()

    if (anyAnalysisStarted && lastAnalysisJobId) {
      setAnalyzeStatus('running')
      let pollAttempts = 0
      const pollAnalysis = async () => {
        pollAttempts++
        if (pollAttempts > 40) { setAnalyzeStatus('error'); pollRef.current = null; return }
        try {
          const jobCheck = await jobsApi.getJob(lastAnalysisJobId!)
          const status: string = jobCheck.data?.status ?? jobCheck.status ?? ''
          if (status === 'COMPLETE') {
            pollRef.current = null
            setAnalyzeStatus('complete')
            fetchOpportunity()
          } else if (status === 'FAILED') {
            pollRef.current = null
            setAnalyzeStatus('error')
          } else {
            pollRef.current = setTimeout(pollAnalysis, 3000) as any
          }
        } catch {
          pollRef.current = setTimeout(pollAnalysis, 3000) as any
        }
      }
      pollAnalysis()
    }

    if (failures.length > 0) {
      const succeeded = files.length - failures.length
      const prefix = succeeded > 0 ? `${succeeded} of ${files.length} uploaded. Failed: ` : 'Upload failed: '
      setUploadError(prefix + failures.join(' · '))
    }

    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleDeleteDocument = async (documentId: string) => {
    if (!window.confirm('Delete this document? This cannot be undone.')) return
    setDeletingDocId(documentId)
    try {
      await documentsApi.delete(documentId)
      await fetchOpportunity()
    } catch (err: any) {
      setUploadError(err?.response?.data?.error || 'Delete failed')
    } finally {
      setDeletingDocId(null)
    }
  }

  const handleExportSynopsis = () => {
    if (!data) return

    // --- helpers ---
    const cleanAgency = (raw: string): string => {
      // Remove duplicate segments separated by dots: "VA, DEPT OF.VA, DEPT OF.SAC FREDERICK" → "VA, DEPT OF — SAC FREDERICK"
      const parts = raw.split('.').map(s => s.trim()).filter(Boolean)
      const unique: string[] = []
      for (const p of parts) {
        if (!unique.some(u => u.toLowerCase() === p.toLowerCase())) unique.push(p)
      }
      // Title-case each segment, join with em-dash
      return unique.map(p =>
        p.replace(/\b(\w)/g, c => c.toUpperCase())
         .replace(/\b(Of|The|And|For|A|An)\b/g, m => m.toLowerCase())
         .replace(/^./, c => c.toUpperCase())
      ).join(' — ')
    }

    const parseContractType = (title: string): string | null => {
      const upper = title.toUpperCase()
      if (upper.includes('IDIQ')) return 'IDIQ (Indefinite Delivery / Indefinite Quantity)'
      if (upper.includes('GWAC')) return 'GWAC (Government-Wide Acquisition Contract)'
      if (upper.includes('BPA')) return 'BPA (Blanket Purchase Agreement)'
      if (upper.includes('SBSA')) return 'SBSA (Small Business Set-Aside)'
      if (upper.includes(' FFP')) return 'FFP (Firm Fixed Price)'
      if (upper.includes(' T&M') || upper.includes(' TIME AND MATERIAL')) return 'T&M (Time & Materials)'
      if (upper.includes(' CPFF')) return 'CPFF (Cost Plus Fixed Fee)'
      if (upper.includes(' MAC')) return 'MAC (Multiple Award Contract)'
      return null
    }

    const parseSolicitationNumber = (title: string): string | null => {
      // Match leading codes like "R425", "36C10B22R0001", "W912HN-22-R-0002"
      const m = title.match(/^([A-Z0-9]{2,20}(?:[-][A-Z0-9]{2,10})*)\s+/)
      return m ? m[1] : null
    }

    const formatSetAside = (type?: string): string => {
      if (!type || type === 'NONE') return 'Open Competition (Full &amp; Open)'
      const map: Record<string, string> = {
        SDVOSB: 'Service-Disabled Veteran-Owned Small Business (SDVOSB)',
        WOSB: 'Women-Owned Small Business (WOSB)',
        EDWOSB: 'Economically Disadvantaged WOSB (EDWOSB)',
        HUBZone: 'HUBZone Small Business',
        SB: 'Small Business Set-Aside',
        '8A': '8(a) Business Development Program',
        VOSB: 'Veteran-Owned Small Business (VOSB)',
      }
      return map[type] || type
    }

    const daysUntil = (deadline: string): number =>
      Math.ceil((new Date(deadline).getTime() - Date.now()) / 86400000)

    // --- computed values ---
    const sub = parseSubmissionInstructions(data.description ?? '')
    if (data.pocEmail && !sub.email) sub.email = data.pocEmail
    if (data.pocName && !sub.contactName) sub.contactName = data.pocName

    const samLink = data.samNoticeId
      ? `https://sam.gov/opp/${data.samNoticeId}/view`
      : `https://sam.gov/search/?index=opp&keywords=${encodeURIComponent(data.title)}`

    const deadline = new Date(data.responseDeadline).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const daysLeft = daysUntil(data.responseDeadline)
    const urgencyColor = daysLeft <= 7 ? '#dc2626' : daysLeft <= 14 ? '#5b74ff' : '#16a34a'

    const value = data.estimatedValue
      ? `$${Number(data.estimatedValue).toLocaleString()}`
      : (data.estimatedValueMin && data.estimatedValueMax)
        ? `$${Number(data.estimatedValueMin).toLocaleString()} – $${Number(data.estimatedValueMax).toLocaleString()}`
        : 'TBD'

    const now = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    const contractType = parseContractType(data.title)
    const solNumber = parseSolicitationNumber(data.title)
    const agency = cleanAgency(data.agency)
    const setAside = formatSetAside(data.setAsideType)
    const prob = data.probabilityScore != null ? Math.round(data.probabilityScore * 100) : null
    const probColor = prob == null ? '#888' : prob >= 60 ? '#16a34a' : prob >= 35 ? '#5b74ff' : '#dc2626'

    // Aggregate scope keywords from all analyzed documents
    const allKeywords = [...new Set(
      (data.documents ?? []).flatMap(d => d.scopeKeywords ?? []).filter(Boolean)
    )].slice(0, 20)

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>Opportunity Synopsis — ${data.title}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; max-width: 960px; margin: 0 auto; padding: 40px 32px 60px; color: #111827; font-size: 13px; line-height: 1.65; background: #fff; }

  /* Header band */
  .header-band { background: #1e3a5f; color: #fff; border-radius: 8px; padding: 24px 28px 20px; margin-bottom: 24px; }
  .header-band .label { font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #93c5fd; margin-bottom: 6px; }
  .header-band h1 { font-size: 20px; font-weight: 700; margin: 0 0 8px; color: #fff; line-height: 1.3; }
  .header-band .meta-row { display: flex; flex-wrap: wrap; gap: 16px; font-size: 11.5px; color: #bfdbfe; margin-top: 10px; }
  .header-band .meta-row span::before { content: '· '; }
  .header-band .meta-row span:first-child::before { content: ''; }
  .header-band a { color: #93c5fd; text-decoration: underline; }

  /* Deadline badge */
  .deadline-badge { display: inline-block; background: ${urgencyColor}20; border: 1px solid ${urgencyColor}; color: ${urgencyColor}; font-weight: 700; font-size: 12px; border-radius: 20px; padding: 3px 12px; margin-left: 10px; vertical-align: middle; }

  /* Win probability banner */
  .prob-banner { display: flex; align-items: center; gap: 20px; background: #ece8df; border: 1px solid #ece8df; border-left: 4px solid ${probColor}; border-radius: 6px; padding: 12px 18px; margin-bottom: 20px; }
  .prob-score { font-size: 32px; font-weight: 800; color: ${probColor}; line-height: 1; }
  .prob-label { font-size: 11px; color: #8f8a99; }
  .prob-label strong { display: block; font-size: 13px; color: #1a1a20; }

  /* Section headers */
  h2 { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; color: #1e3a5f; border-bottom: 2px solid #1e3a5f; padding-bottom: 5px; margin: 28px 0 14px; }

  /* Key info grid */
  .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 24px; margin-bottom: 4px; }
  .grid-2 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px 24px; margin-bottom: 4px; }
  .field { padding: 10px 12px; background: #ece8df; border: 1px solid #ece8df; border-radius: 6px; }
  .field label { display: block; font-size: 9.5px; text-transform: uppercase; letter-spacing: .08em; color: #8f8a99; margin-bottom: 3px; }
  .field p { margin: 0; font-weight: 600; color: #111827; font-size: 13px; }
  .field.highlight { background: #eff6ff; border-color: #bfdbfe; }
  .field.urgent { background: #fef2f2; border-color: #fca5a5; }

  /* Set-aside badge */
  .set-aside-pill { display: inline-block; background: #fef3c7; border: 1px solid #7b8fff; color: #155e75; font-weight: 700; font-size: 11px; border-radius: 4px; padding: 2px 8px; }

  /* Boxes */
  .box { background: #ece8df; border: 1px solid #ece8df; border-radius: 6px; padding: 14px 18px; margin-bottom: 10px; }
  .box.blue { background: #eff6ff; border-color: #bfdbfe; }
  .box.amber { background: #fffbeb; border-color: #a3b1ff; }
  .box.red { background: #fef2f2; border-color: #fca5a5; }
  .box.green { background: #f0fdf4; border-color: #86efac; }

  /* Score breakdown */
  .score-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid #ece8df; }
  .score-row:last-child { border-bottom: none; }
  .score-bar-wrap { flex: 1; background: #ece8df; border-radius: 4px; height: 6px; overflow: hidden; }
  .score-bar { height: 100%; border-radius: 4px; background: #1e3a5f; }
  .score-val { font-weight: 700; font-size: 12px; width: 36px; text-align: right; color: #1e3a5f; }
  .score-name { width: 200px; font-size: 12px; color: #374151; }

  /* Keywords */
  .tag { display: inline-block; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; border-radius: 12px; padding: 2px 10px; font-size: 11px; margin: 2px 3px 2px 0; }

  ul { margin: 6px 0 0 0; padding-left: 20px; }
  li { margin-bottom: 5px; }
  a { color: #1d4ed8; }
  strong { color: #111827; }

  /* Footer */
  .footer { margin-top: 48px; font-size: 11px; color: #b3aebb; border-top: 1px solid #ece8df; padding-top: 12px; display: flex; justify-content: space-between; }

  @media print {
    body { padding: 20px; }
    .header-band { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .field { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  }
</style>
</head>
<body>

<!-- ═══ HEADER ═══ -->
<div class="header-band">
  <div class="label">Opportunity Synopsis${solNumber ? ' · Solicitation ' + solNumber : ''}</div>
  <h1>${data.title}</h1>
  <div class="meta-row">
    <span>Generated ${now}</span>
    ${data.samNoticeId ? `<span>Notice ID: ${data.samNoticeId}</span>` : ''}
    <span><a href="${samLink}" target="_blank">View on SAM.gov ↗</a></span>
  </div>
</div>

<!-- ═══ WIN PROBABILITY ═══ -->
${prob != null ? `
<div class="prob-banner">
  <div>
    <div class="prob-score">${prob}%</div>
    <div style="font-size:10px;color:#b3aebb;margin-top:2px">Win Probability</div>
  </div>
  <div style="flex:1">
    <div style="background:#ece8df;border-radius:6px;height:10px;overflow:hidden;margin-bottom:6px">
      <div style="width:${prob}%;height:100%;background:${probColor};border-radius:6px"></div>
    </div>
    <div style="font-size:11.5px;color:#6e6979">
      ${prob >= 60 ? 'Strong match — platform recommends pursuit.' : prob >= 35 ? 'Moderate match — evaluate alignment before committing.' : 'Low probability — consider carefully before bidding.'}
    </div>
  </div>
</div>` : ''}

<!-- ═══ KEY INFORMATION ═══ -->
<h2>Key Information</h2>
<div class="grid-3">
  <div class="field${daysLeft <= 14 ? ' urgent' : ' highlight'}">
    <label>Response Deadline</label>
    <p>${deadline} <span class="deadline-badge">${daysLeft > 0 ? daysLeft + ' days' : 'PAST DUE'}</span></p>
  </div>
  <div class="field">
    <label>Issuing Agency</label>
    <p>${agency}</p>
  </div>
  <div class="field">
    <label>Estimated Contract Value</label>
    <p>${value}</p>
  </div>
  <div class="field">
    <label>NAICS Code</label>
    <p>${data.naicsCode}${data.naicsDescription ? ' — ' + data.naicsDescription : ''}</p>
  </div>
  <div class="field">
    <label>Set-Aside Eligibility</label>
    <p><span class="set-aside-pill">${data.setAsideType && data.setAsideType !== 'NONE' ? data.setAsideType : 'Full &amp; Open'}</span> ${data.setAsideType && data.setAsideType !== 'NONE' ? '— ' + setAside : ''}</p>
  </div>
  ${contractType ? `<div class="field"><label>Contract Type</label><p>${contractType}</p></div>` : ''}
  ${data.placeOfPerformance ? `<div class="field"><label>Place of Performance</label><p>${data.placeOfPerformance}</p></div>` : ''}
  ${solNumber ? `<div class="field"><label>Solicitation Number</label><p>${solNumber}</p></div>` : ''}
</div>

<!-- ═══ POINT OF CONTACT ═══ -->
${(data.pocName || data.pocEmail || data.pocPhone) ? `
<h2>Point of Contact</h2>
<div class="box blue">
  ${data.pocName ? `<strong>${data.pocName}</strong>${data.pocTitle ? ', ' + data.pocTitle : ''}<br/>` : ''}
  ${data.pocEmail ? `📧 <a href="mailto:${data.pocEmail}">${data.pocEmail}</a><br/>` : ''}
  ${data.pocPhone ? `📞 ${data.pocPhone}` : ''}
</div>` : ''}

<!-- ═══ SCOPE OF WORK ═══ -->
${data.description ? `
<h2>Scope of Work</h2>
<div class="box">
  <p style="white-space:pre-wrap;margin:0">${data.description.substring(0, 5000)}${data.description.length > 5000 ? '\n\n[Truncated — view full solicitation on SAM.gov]' : ''}</p>
</div>` : ''}

<!-- ═══ SCOPE KEYWORDS (from AI document analysis) ═══ -->
${allKeywords.length > 0 ? `
<h2>AI-Extracted Scope Keywords</h2>
<div class="box">
  ${allKeywords.map(k => `<span class="tag">${k}</span>`).join('')}
</div>` : ''}

<!-- ═══ SUBMISSION INSTRUCTIONS ═══ -->
<h2>Submission Instructions</h2>
<div class="box ${sub.email ? 'blue' : ''}">
  <strong>Method:</strong> ${sub.method || 'See solicitation for details'}<br/>
  ${sub.email ? `<strong>Submit To:</strong> <a href="mailto:${sub.email}">${sub.email}</a><br/>` : ''}
  ${sub.contactName ? `<strong>Contracting Officer:</strong> ${sub.contactName}<br/>` : ''}
  ${sub.steps.length > 0 ? `<br/><strong>Steps:</strong><ul>${sub.steps.map(s => `<li>${s}</li>`).join('')}</ul>` : ''}
  ${sub.documents.length > 0 ? `<br/><strong>Required Documents / Volumes:</strong><ul>${sub.documents.map(d => `<li>${d}</li>`).join('')}</ul>` : ''}
</div>

<!-- ═══ COMPETITIVE INTELLIGENCE ═══ -->
${data.isEnriched && (data.historicalWinner || data.competitionCount || data.historicalAvgAward || data.incumbentProbability || data.agencySmallBizRate || data.agencySdvosbRate) ? `
<h2>Competitive Intelligence</h2>
<div class="grid-3">
  ${data.historicalWinner ? `<div class="field"><label>Previous Award Winner</label><p>${data.historicalWinner}</p></div>` : ''}
  ${data.competitionCount ? `<div class="field"><label>Typical Competitor Count</label><p>${data.competitionCount} bidders</p></div>` : ''}
  ${data.historicalAvgAward ? `<div class="field"><label>Historical Avg Award</label><p>$${Number(data.historicalAvgAward).toLocaleString()}</p></div>` : ''}
  ${data.historicalAwardCount ? `<div class="field"><label>Historical Award Count</label><p>${data.historicalAwardCount} awards</p></div>` : ''}
  ${data.incumbentProbability ? `<div class="field"><label>Incumbent Recompete Prob.</label><p>${Math.round(data.incumbentProbability * 100)}%</p></div>` : ''}
  ${data.agencySmallBizRate ? `<div class="field"><label>Agency Small Biz Rate</label><p>${Math.round(data.agencySmallBizRate * 100)}%</p></div>` : ''}
  ${data.agencySdvosbRate ? `<div class="field"><label>Agency SDVOSB Rate</label><p>${Math.round(data.agencySdvosbRate * 100)}%</p></div>` : ''}
  ${data.recompeteFlag ? `<div class="field highlight"><label>Recompete Flag</label><p>⚠ Incumbent contract up for recompete</p></div>` : ''}
  ${data.incumbentSignalDetected ? `<div class="field amber"><label>Incumbent Signal</label><p>⚠ Incumbent language detected in documents</p></div>` : ''}
</div>` : ''}

<!-- ═══ SCORE BREAKDOWN ═══ -->
${data.scoreBreakdown?.featureBreakdown && Object.keys(data.scoreBreakdown.featureBreakdown).length > 0 ? `
<h2>Scoring Factor Breakdown</h2>
<div class="box">
  ${Object.entries(data.scoreBreakdown.featureBreakdown as Record<string, number>).map(([name, score]) => `
  <div class="score-row">
    <div class="score-name">${name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</div>
    <div class="score-bar-wrap"><div class="score-bar" style="width:${Math.min(100, Math.max(0, score * 100))}%"></div></div>
    <div class="score-val">${Math.round(score * 100)}</div>
  </div>`).join('')}
</div>` : ''}

<!-- ═══ AMENDMENTS ═══ -->
${data.amendments && data.amendments.length > 0 ? `
<h2>Amendments (${data.amendments.length})</h2>
${data.amendments.map(a => `
<div class="box">
  <strong>${a.amendmentNumber || 'Amendment'}${a.title ? ' — ' + a.title : ''}</strong>
  ${a.postedDate ? `<span style="color:#b3aebb;font-size:11px;margin-left:10px">${new Date(a.postedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>` : ''}
  ${a.plainLanguageSummary ? `<p style="margin:6px 0 0;color:#374151">${a.plainLanguageSummary}</p>` : (a.description ? `<p style="margin:6px 0 0;color:#374151;white-space:pre-wrap">${a.description.substring(0, 600)}</p>` : '')}
</div>`).join('')}` : ''}

<!-- ═══ FOOTER ═══ -->
<div class="footer">
  <span>Bytescon — Bytes Platform · Exported ${now}</span>
  <span>CONFIDENTIAL — Internal Use Only</span>
</div>

</body>
</html>`

    const blob = new Blob([html], { type: 'text/html' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `Synopsis_${(solNumber || data.title).replace(/[^a-zA-Z0-9]/g, '_').substring(0, 60)}.html`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return (
    <div className="flex items-center gap-2 text-gray-400 mt-10">
      <Loader className="w-4 h-4 animate-spin" /> Loading opportunity...
    </div>
  )
  if (error) return <div className="text-red-400 mt-10">Failed to load opportunity.</div>
  if (!data) return null

  const prob = data.probabilityScore ?? 0
  const probColor = prob >= 0.65 ? 'text-green-400' : prob >= 0.40 ? 'text-yellow-400' : 'text-gray-400'
  const dl = data.deadlineClassification
  const deadlineBadgeClass =
    dl?.priority === 'RED' ? 'bg-red-900/50 text-red-300 border-red-700' :
    dl?.priority === 'YELLOW' ? 'bg-yellow-900/50 text-yellow-300 border-yellow-700' :
    'bg-green-900/50 text-green-300 border-green-700'

  const fmt = (v: number) =>
    v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : `$${(v / 1e3).toFixed(0)}K`

  const estValueDisplay = data.estimatedValue
    ? fmt(data.estimatedValue)
    : data.estimatedValueMin && data.estimatedValueMax
    ? `${fmt(data.estimatedValueMin)} – ${fmt(data.estimatedValueMax)}`
    : 'TBD'

  const subInfo = parseSubmissionInstructions(data.description ?? "")
  // Prefer POC email/name from SAM.gov over anything parsed from description text
  if (data.pocEmail && !subInfo.email) {
    subInfo.email = data.pocEmail
    if (!subInfo.method || subInfo.method === 'See solicitation for details') {
      subInfo.method = 'Email submission'
    }
  }
  if (data.pocName && !subInfo.contactName) subInfo.contactName = data.pocName

  // Section 4 #2: only surface a government-source link when a valid external
  // identifier/URL exists. Seeded demo rows (and rows whose notice id isn't the
  // 32-char hex the live SAM.gov feed issues) would resolve to a 404, so we
  // render no link at all rather than a broken one that reads as a broken product.
  const isDemoOpp = data.isDemo === true
  const samUrl = resolveSourceUrl(data)

  return (
    <div className="space-y-6 pb-12">
      {/* Back */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-sm"
      >
        <ArrowLeft className="w-4 h-4" /> Back to Opportunities
      </button>

      {/* ── HEADER CARD ─────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-start justify-between gap-4 mb-5">
          <div className="flex-1 min-w-0">
            <h1 className="text-xl font-bold text-gray-200 leading-snug mb-1">{data.title}</h1>
            <p className="text-sm text-gray-500">{data.agency}</p>
          </div>
          <div className="flex flex-col items-end gap-2 flex-shrink-0">
            <div className="text-right">
              <p className="text-xs text-gray-500 mb-0.5">Baseline Score</p>
              <p className={`text-4xl font-bold font-mono ${probColor}`}>
                {Math.round(prob * 100)}%
              </p>
              <p className="text-[10px] text-gray-600 mt-0.5">Run analysis below for client-specific score</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => toggleFavorite({
                  id: data.id,
                  title: data.title,
                  agency: data.agency,
                  deadline: data.responseDeadline,
                  naicsCode: data.naicsCode,
                })}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border transition-colors ${
                  isFavorite(data.id)
                    ? 'bg-yellow-900/40 border-yellow-700 text-yellow-300 hover:bg-yellow-900/60'
                    : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-gray-400 hover:text-yellow-300'
                }`}
                title={isFavorite(data.id) ? 'Remove from favorites' : 'Add to favorites'}
              >
                {isFavorite(data.id)
                  ? <><StarOff className="w-3.5 h-3.5" /> Starred</>
                  : <><Star className="w-3.5 h-3.5" /> Star</>
                }
              </button>
              <button
                onClick={handleExportSynopsis}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 transition-colors"
                title="Export opportunity synopsis"
              >
                <FileDown className="w-3.5 h-3.5" /> Export Synopsis
              </button>
              <button
                onClick={() => navigate(`/opportunities/${data.id}/proposal`)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 transition-colors"
                title="Open the collaborative proposal workspace"
              >
                <ClipboardList className="w-3.5 h-3.5" /> Proposal Workspace
              </button>
              <button
                onClick={() => navigate(`/opportunities/${data.id}/pricing`)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 transition-colors"
                title="Open the pricing & rate build-up workspace"
              >
                <DollarSign className="w-3.5 h-3.5" /> Pricing
              </button>
              <button
                onClick={() => navigate(`/opportunities/${data.id}/submission`)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 transition-colors"
                title="Open the submission management workspace"
              >
                <Send className="w-3.5 h-3.5" /> Submission
              </button>
              <button
                onClick={() => navigate(`/opportunities/${data.id}/past-performance`)}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 transition-colors"
                title="Open the past-performance relevance matrix"
              >
                <Award className="w-3.5 h-3.5" /> Past Performance
              </button>
            </div>
          </div>
        </div>

        {/* Key fields grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm mb-5">
          <div>
            <p className="text-gray-500 text-xs mb-0.5">NAICS</p>
            <p className="text-gray-200 font-mono">{data.naicsCode}</p>
            {data.naicsDescription && <p className="text-xs text-gray-600 truncate">{data.naicsDescription}</p>}
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Response Deadline</p>
            <p className="text-gray-200">
              {new Date(data.responseDeadline).toLocaleDateString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric',
              })}
            </p>
            {dl && (
              <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded border mt-0.5 ${deadlineBadgeClass}`}>
                {dl.daysUntilDeadline}d remaining
              </span>
            )}
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Est. Contract Value</p>
            <p className="text-gray-100 font-mono font-semibold text-base">{estValueDisplay}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs mb-0.5">Set-Aside</p>
            {data.setAsideType && data.setAsideType !== 'NONE' ? (
              <span className="text-xs bg-blue-900/40 text-blue-300 border border-blue-700 px-2 py-0.5 rounded">
                {data.setAsideType}
              </span>
            ) : (
              <span className="text-xs text-gray-500">Open Competition</span>
            )}
          </div>
          {data.placeOfPerformance && (
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Place of Performance</p>
              <p className="text-gray-200 text-sm">{data.placeOfPerformance}</p>
            </div>
          )}
        </div>

        {/* Point of Contact */}
        {(data.pocName || data.pocEmail) && (
          <div className="mb-4 flex items-start gap-3 bg-blue-950/20 border border-blue-900/40 rounded-lg px-4 py-3">
            <Mail className="w-4 h-4 text-blue-400 flex-shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-gray-500 mb-0.5">Contracting Officer / Point of Contact</p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                {data.pocName && <p className="text-sm font-medium text-gray-200">{data.pocName}</p>}
                {data.pocTitle && <p className="text-xs text-gray-500">{data.pocTitle}</p>}
                {data.pocEmail && (
                  <a href={"mailto:" + data.pocEmail} className="text-sm text-blue-400 hover:text-blue-300 font-mono">
                    {data.pocEmail}
                  </a>
                )}
                {data.pocPhone && <p className="text-sm text-gray-400 font-mono">{data.pocPhone}</p>}
              </div>
            </div>
          </div>
        )}

        {/* Source CTA — primary action. Rendered only when a valid external
            link exists; demo/sample rows show a label instead of a 404 link. */}
        {samUrl ? (
          <a
            href={samUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <ExternalLink className="w-4 h-4" />
            View on {sourceLinkLabel(data.source)}
          </a>
        ) : isDemoOpp ? (
          <span className="inline-flex items-center gap-2 bg-gray-800 text-gray-400 border border-gray-700 text-sm font-medium px-4 py-2 rounded-lg">
            Sample opportunity — no live SAM.gov listing
          </span>
        ) : null}

        {/* Description */}
        {data.description && (
          <div className="mt-5 border-t border-gray-800 pt-4">
            <p className="text-gray-500 text-xs uppercase tracking-wider mb-2">Description</p>
            <p className="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed">{data.description}</p>
          </div>
        )}
      </div>

      {/* ── DOCUMENT UPLOAD ──────────────────────────────────── */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-200 mb-1 flex items-center gap-2">
          <FileText className="w-5 h-5 text-blue-400" />
          Solicitation Documents
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Upload the SOW, solicitation package, or amendments. The scoring engine will re-analyze
          scope alignment and automatically update the win probability.
        </p>

        <div className="flex items-center gap-3 mb-4 flex-wrap">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.txt,.docx,.zip"
            multiple
            className="hidden"
            onChange={handleFileUpload}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading || analyzeStatus === 'running'}
            className="btn-secondary flex items-center gap-2 text-sm"
          >
            {uploading
              ? <Loader className="w-4 h-4 animate-spin" />
              : <Upload className="w-4 h-4" />}
            {uploading ? 'Uploading...' : 'Upload Documents (multiple OK) / ZIP'}
          </button>

          {analyzeStatus === 'running' && (
            <span className="flex items-center gap-2 text-blue-300 text-sm">
              <Loader className="w-4 h-4 animate-spin" />
              Analyzing — probability will update automatically
            </span>
          )}
          {analyzeStatus === 'complete' && (
            <span className="flex items-center gap-2 text-green-300 text-sm">
              <CheckCircle className="w-4 h-4" /> Analysis complete — score updated
            </span>
          )}
          {analyzeStatus === 'error' && (
            <span className="flex items-center gap-2 text-red-400 text-sm">
              <AlertCircle className="w-4 h-4" /> Analysis failed
            </span>
          )}
        </div>

        {uploadError && <p className="text-red-400 text-xs mb-3">{uploadError}</p>}

        {data.documents && data.documents.length > 0 ? (
          <div className="space-y-3">
            {data.documents.map((doc) => (
              <div key={doc.id} className="border border-gray-800 rounded-lg p-4">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <p className="text-sm font-medium text-gray-200">{doc.fileName}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {doc.fileUrl && (
                      <a
                        href={`${import.meta.env.VITE_API_URL || 'http://localhost:3001'}${doc.fileUrl}`}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
                      >
                        <Download className="w-3 h-3" /> Download
                      </a>
                    )}
                    <button
                      onClick={() => handleDeleteDocument(doc.id)}
                      disabled={deletingDocId === doc.id}
                      className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 disabled:opacity-40"
                      title="Delete document"
                    >
                      {deletingDocId === doc.id
                        ? <Loader className="w-3 h-3 animate-spin" />
                        : <Trash2 className="w-3 h-3" />}
                      Delete
                    </button>
                    <span className={`text-xs px-2 py-0.5 rounded ${
                      doc.analysisStatus === 'COMPLETE'   ? 'bg-green-900/40 text-green-300' :
                      doc.analysisStatus === 'RUNNING'    ? 'bg-blue-900/40 text-blue-300' :
                      doc.analysisStatus === 'FAILED'     ? 'bg-red-900/40 text-red-300' :
                      doc.analysisStatus === 'NO_AI_KEY'  ? 'bg-yellow-900/40 text-yellow-300' :
                      'bg-gray-800 text-gray-400'
                    }`}>
                      {doc.analysisStatus === 'NO_AI_KEY' ? 'No AI Key' : doc.analysisStatus}
                    </span>
                  </div>
                </div>

                {doc.analysisStatus === 'NO_AI_KEY' && (
                  <div className="mt-2 text-xs bg-yellow-950/30 border border-yellow-800/40 rounded-lg px-3 py-2 text-yellow-300">
                    AI analysis is not enabled for this account. Contact your administrator to configure AI-powered scope scoring.
                  </div>
                )}

                {doc.analysisStatus === 'COMPLETE' && (() => {
                  const isDefaultFallback =
                    doc.alignmentScore === 0.5 &&
                    doc.complexityScore === 0.5 &&
                    (!doc.scopeKeywords || doc.scopeKeywords.length === 0);
                  return (
                    <div className="mt-2 text-xs space-y-2">
                      {isDefaultFallback && (
                        <div className="flex items-start gap-2 bg-yellow-950/40 border border-yellow-800/50 rounded-lg px-3 py-2 text-yellow-300">
                          <span className="text-base leading-none mt-0.5">⚠</span>
                          <div>
                            <p className="font-semibold">Analysis did not complete</p>
                            <p className="text-yellow-400/80 mt-0.5">These scores are placeholder defaults (50%), not real AI output. The AI failed during analysis (likely a provider error). Delete this document and re-upload after confirming your AI provider is working in Settings.</p>
                          </div>
                        </div>
                      )}
                      {!isDefaultFallback && (
                        <div className="grid grid-cols-2 gap-3">
                          {doc.alignmentScore != null && (
                            <div>
                              <p className="text-gray-500">Scope Alignment</p>
                              <p className={`font-mono font-semibold ${
                                doc.alignmentScore >= 0.7 ? 'text-green-400' :
                                doc.alignmentScore >= 0.4 ? 'text-yellow-400' : 'text-gray-400'
                              }`}>
                                {Math.round(doc.alignmentScore * 100)}%
                              </p>
                            </div>
                          )}
                          {doc.complexityScore != null && (
                            <div>
                              <p className="text-gray-500">Technical Complexity</p>
                              <p className="text-gray-200 font-mono">{Math.round(doc.complexityScore * 100)}%</p>
                            </div>
                          )}
                        </div>
                      )}
                      {doc.scopeKeywords && doc.scopeKeywords.length > 0 && (
                        <div>
                          <p className="text-gray-500 mb-1">Keywords extracted from document <span className="text-gray-600">(verify these match the actual SOW)</span></p>
                          <div className="flex flex-wrap gap-1">
                            {doc.scopeKeywords.slice(0, 15).map((kw, i) => (
                              <span key={i} className="bg-gray-800 text-gray-300 border border-gray-700 px-2 py-0.5 rounded">
                                {kw}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {doc.incumbentSignals && doc.incumbentSignals.length > 0 && (
                        <div>
                          <p className="text-gray-500 mb-1">Incumbent Signals Detected</p>
                          <div className="flex flex-wrap gap-1">
                            {doc.incumbentSignals.map((s, i) => (
                              <span key={i} className="bg-orange-900/30 text-orange-300 border border-orange-800 px-2 py-0.5 rounded">
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-gray-600 text-sm">No documents uploaded yet.</p>
        )}
      </div>

      {/* CLIENT SCORING CONTEXT */}
      <div className="card border-blue-800/50">
        <h2 className="text-base font-semibold text-gray-200 mb-3 flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-blue-400" />
          Score for a Specific Client
        </h2>
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label htmlFor="client-score-select" className="text-gray-500 text-xs mb-1 block">Select Client Company</label>
            <select
              id="client-score-select"
              className="input w-full text-sm"
              value={selectedClientId}
              onChange={(e) => { setSelectedClientId(e.target.value); setClientScore(null); setScoreError('') }}
            >
              <option value="">-- Choose a client --</option>
              {clients.map((c: any) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <button
            onClick={() => runClientScore(selectedClientId)}
            disabled={!selectedClientId || scoringClient}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            {scoringClient ? <Loader className="w-4 h-4 animate-spin" /> : <BarChart3 className="w-4 h-4" />}
            {scoringClient ? 'Analyzing...' : 'Run Analysis'}
          </button>
        </div>
        {scoreError && <p className="text-red-400 text-xs mt-2">{scoreError}</p>}
        {clientScore && clientScore.winProbabilityPercent === '0%' && (
          <div className="mt-3 flex items-start gap-2 px-3 py-2.5 rounded-lg bg-amber-900/20 border border-amber-700/40">
            <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
            <div className="text-xs text-amber-300 leading-relaxed">
              <strong>0% score — likely missing client data.</strong> Make sure this client has NAICS codes, past performance stats, and
              set-aside certifications (SDVOSB, 8(a), etc.) configured in their{' '}
              <Link to={`/clients/${selectedClientId}`} className="underline hover:text-amber-200">client profile</Link>.
              The scoring engine needs this data to calculate a meaningful win probability.
            </div>
          </div>
        )}
        {clientScore && (
          <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4 border-t border-gray-800 pt-4">
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Win Probability</p>
              <p className="text-2xl font-bold font-mono text-green-400">{clientScore.winProbabilityPercent}</p>
              {clientScore.credibleInterval && (
                <p className="text-[10px] text-gray-500 mt-0.5 leading-tight">
                  95% credible: {Math.round(clientScore.credibleInterval.low * 100)}%–{Math.round(clientScore.credibleInterval.high * 100)}%
                </p>
              )}
              {clientScore.setAsideMatch === 'FULL' && (
                <p className="text-[10px] text-emerald-400 mt-0.5 leading-tight">★ Set-aside aligned (+5%)</p>
              )}
              {clientScore.setAsideMatch === 'PARTIAL' && (
                <p className="text-[10px] text-emerald-300 mt-0.5 leading-tight">Set-aside partial match (+2%)</p>
              )}
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Recommendation</p>
              <span className={'text-sm font-semibold px-2 py-0.5 rounded ' + (
                clientScore.recommendation === 'BID PRIME' ? 'bg-green-900/40 text-green-300' :
                clientScore.recommendation === 'BID SUB' ? 'bg-blue-900/40 text-blue-300' :
                'bg-red-900/40 text-red-300'
              )}>
                {clientScore.recommendation}
              </span>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">ROI Multiple</p>
              <p className="text-xl font-bold font-mono text-blue-300">{clientScore.roiMultiple}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs mb-0.5">Risk Level</p>
              <span className={'text-sm font-semibold px-2 py-0.5 rounded ' + (
                clientScore.riskLevel === 'LOW' ? 'bg-green-900/40 text-green-300' :
                clientScore.riskLevel === 'MODERATE' ? 'bg-yellow-900/40 text-yellow-300' :
                'bg-red-900/40 text-red-300'
              )}>
                {clientScore.riskLevel}
              </span>
              <p className="text-xs text-gray-600 mt-1 leading-tight">
                {clientScore.riskLevel === 'LOW'
                  ? 'No blockers — deadline, penalties, and compliance are clear.'
                  : clientScore.riskLevel === 'MODERATE'
                  ? 'Some risk: tight timeline, past penalties, or compliance notes. Review before committing.'
                  : 'High risk — imminent deadline, unpaid penalties, compliance block, or poor submission history.'}
              </p>
            </div>
            {clientScore.netExpectedValue != null && (
              <div>
                <p className="text-gray-500 text-xs mb-0.5">Net Expected Value</p>
                <p className="text-sm font-mono text-green-400">{fmt(Number(clientScore.netExpectedValue))}</p>
                <p className="text-[10px] text-gray-600">NPV discounted ~9mo to award</p>
              </div>
            )}
            {clientScore.deadlineSummary && (
              <div>
                <p className="text-gray-500 text-xs mb-0.5">Deadline</p>
                <p className="text-sm text-gray-300">{clientScore.deadlineSummary}</p>
              </div>
            )}
            {clientScore.expectedLifetimeValue != null && (
              <div>
                <p className="text-gray-500 text-xs mb-0.5">Expected Lifetime Value</p>
                <p className="text-sm font-mono text-purple-400">{fmt(Number(clientScore.expectedLifetimeValue))}</p>
                <p className="text-[10px] text-gray-600">Base + ~1.5 option years × win prob</p>
              </div>
            )}
            {clientScore.lifetimeValue != null && (
              <div>
                <p className="text-gray-500 text-xs mb-0.5">Contract Lifetime Value</p>
                <p className="text-sm font-mono text-yellow-400">{fmt(Number(clientScore.lifetimeValue))}</p>
                <p className="text-[10px] text-gray-600">
                  {clientScore.subContractShare
                    ? `${Math.round(clientScore.subContractShare * 100)}% sub-share × 2.5yr`
                    : 'Full prime × 2.5yr option factor'}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── AT A GLANCE — PLAIN ENGLISH SUMMARY ──────────────── */}
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-200 mb-4 flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-blue-400" />
          What Is This Contract?
        </h2>

        {/* Lead synopsis — what the contract is and the main goal, in plain
            English. Prefers the AI "what the agency wants" summary once it has
            been generated; otherwise builds a readable synopsis from the
            solicitation description (skipping FAR boilerplate). */}
        {(() => {
          const aiSummary = typeof guidance?.agencyWants === 'string' ? guidance.agencyWants.trim() : ''
          const synopsis =
            aiSummary ||
            buildContractSynopsis(data.description) ||
            `This is a ${data.naicsDescription ? data.naicsDescription.toLowerCase() : `NAICS ${data.naicsCode}`} requirement from ${data.agency}.`
          return (
            <div className="mb-4 rounded-lg bg-blue-950/20 border border-blue-900/40 px-4 py-3">
              <p className="text-xs text-blue-400 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                <Target className="w-3.5 h-3.5" /> The bottom line
                {aiSummary
                  ? <span className="text-gray-600 normal-case">· AI summary of the solicitation</span>
                  : <span className="text-gray-600 normal-case">· run &ldquo;Analyze Solicitation&rdquo; below for a deeper AI read</span>}
              </p>
              <p className="text-gray-200 text-sm leading-relaxed whitespace-pre-line">{synopsis}</p>
            </div>
          )
        })()}

        <div className="space-y-3 text-sm">
          {/* What they need you to do — the core ask, when AI guidance exists */}
          {Array.isArray(guidance?.coreRequirements) && guidance.coreRequirements.filter(Boolean).length > 0 && (
            <div className="flex gap-3">
              <span className="text-blue-400 flex-shrink-0 mt-0.5">{'•'}</span>
              <div className="text-gray-300">
                <span className="text-gray-400">What they need you to do: </span>
                <ul className="mt-1.5 space-y-1">
                  {guidance.coreRequirements.filter(Boolean).slice(0, 5).map((req: string, i: number) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-blue-500 flex-shrink-0 mt-0.5">{'–'}</span>
                      <span>{req}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          {/* Who can bid */}
          <div className="flex gap-3">
            <span className="text-blue-400 flex-shrink-0 mt-0.5">{'•'}</span>
            <p className="text-gray-300">
              <span className="text-gray-400">Who can bid: </span>
              {data.setAsideType && data.setAsideType !== 'NONE'
                ? `This is a set-aside contract restricted to ${data.setAsideType} businesses. Only eligible firms may submit a proposal.`
                : 'This is an open competition — any qualified business may submit a proposal.'}
            </p>
          </div>
          {/* Contract value — only show when known */}
          {estValueDisplay !== 'TBD' && (
            <div className="flex gap-3">
              <span className="text-blue-400 flex-shrink-0 mt-0.5">{'•'}</span>
              <p className="text-gray-300">
                <span className="text-gray-400">Estimated value: </span>
                {`The government estimates this contract is worth approximately ${estValueDisplay}.`}
              </p>
            </div>
          )}
          {/* Deadline */}
          <div className="flex gap-3">
            <span className="text-blue-400 flex-shrink-0 mt-0.5">{'•'}</span>
            <p className="text-gray-300">
              <span className="text-gray-400">Proposal deadline: </span>
              {new Date(data.responseDeadline).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              {dl ? ` — ${dl.daysUntilDeadline} days from today.` : '.'}
            </p>
          </div>
          {/* Place of performance */}
          {data.placeOfPerformance && (
            <div className="flex gap-3">
              <span className="text-blue-400 flex-shrink-0 mt-0.5">{'•'}</span>
              <p className="text-gray-300">
                <span className="text-gray-400">Where the work happens: </span>
                {data.placeOfPerformance}.
              </p>
            </div>
          )}
          {/* Win probability plain-language */}
          <div className="flex gap-3">
            <span className={probColor + ' flex-shrink-0 mt-0.5'}>{'•'}</span>
            <p className="text-gray-300">
              <span className="text-gray-400">Your estimated chances: </span>
              {prob >= 0.65
                ? `Strong fit — our model gives you a ${Math.round(prob * 100)}% win probability based on your firm profile, NAICS alignment, and agency history.`
                : prob >= 0.40
                ? `Moderate fit — ${Math.round(prob * 100)}% win probability. Review the set-aside requirements and agency preference history before committing.`
                : `Low fit — ${Math.round(prob * 100)}% win probability. Consider whether the investment in proposal preparation is justified.`}
            </p>
          </div>
        </div>
      </div>


      {/* ── HOW TO SUBMIT — only shown when real data was extracted ── */}
      {(subInfo.rawFound || subInfo.email || subInfo.documents.length > 0 || subInfo.steps.length > 0) && (
      <div className="card">
        <h2 className="text-lg font-semibold text-gray-200 mb-4 flex items-center gap-2">
          <Send className="w-5 h-5 text-blue-400" />
          How to Submit
          {subInfo.rawFound && (
            <span className="text-xs bg-green-900/40 text-green-400 border border-green-800 px-1.5 py-0.5 rounded font-normal ml-1">
              extracted
            </span>
          )}
        </h2>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px]">
              <p className="text-gray-500 text-xs mb-1 flex items-center gap-1">
                <Mail className="w-3 h-3" /> Submission Method
              </p>
              <p className="text-gray-200 text-sm font-medium">{subInfo.method}</p>
              {subInfo.email && (
                <a href={"mailto:" + subInfo.email} className="text-blue-400 hover:text-blue-300 text-sm font-mono mt-1 block">
                  {subInfo.email}
                </a>
              )}
              {subInfo.contactName && (
                <p className="text-xs text-gray-500 mt-0.5">Contact: {subInfo.contactName}</p>
              )}
            </div>
            {subInfo.subjectLine && (
              <div className="flex-1 min-w-[200px]">
                <p className="text-gray-500 text-xs mb-1">Email Subject Line</p>
                <p className="text-yellow-300 text-xs font-mono bg-gray-900 px-3 py-2 rounded border border-gray-800">
                  {subInfo.subjectLine}
                </p>
              </div>
            )}
          </div>
          {subInfo.documents.length > 0 && (
            <div>
              <p className="text-gray-500 text-xs mb-2 flex items-center gap-1">
                <ClipboardList className="w-3 h-3" /> Documents / Volumes Required
              </p>
              <div className="flex flex-wrap gap-2">
                {subInfo.documents.map((doc, i) => (
                  <span key={i} className="text-xs bg-blue-900/30 text-blue-300 border border-blue-800 px-2 py-1 rounded">{doc}</span>
                ))}
              </div>
            </div>
          )}
          {subInfo.steps.length > 0 && (
            <div>
              <p className="text-gray-500 text-xs mb-2">Key Submission Steps</p>
              <ol className="space-y-1.5">
                {subInfo.steps.map((step, i) => (
                  <li key={i} className="flex gap-2 text-sm text-gray-300">
                    <span className="text-blue-500 font-mono text-xs mt-0.5 flex-shrink-0">{i + 1}.</span>
                    {step}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
      )}

      {/* ── WIN PROBABILITY SCORE BREAKDOWN ─────────────────── */}
      <ScoreBreakdown
        breakdown={data.scoreBreakdown}
        probability={prob}
        estimatedValue={data.estimatedValue}
        expectedValue={data.expectedValue}
        samUrl={samUrl ?? undefined}
      />

      {/* ── SUBCONTRACTING PATH (SCW-6, read-only Phase 4) ──── */}
      {id && <SubcontractingPath opportunityId={id} />}

      {/* ── AWARD HISTORY INTELLIGENCE (USASpending) ────────── */}
      {data.isEnriched && (data.historicalWinner || (data.historicalAwardCount ?? 0) > 0 || (data.competitionCount ?? 0) > 0) && (
        <div className="card">
          <h2 className="text-lg font-semibold text-gray-200 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-blue-400" />
            Award History Intelligence
            <span className="text-xs text-gray-600 font-normal ml-1">(USASpending.gov — past 5 years)</span>
          </h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            {data.historicalWinner && (
              <div className="col-span-2">
                <p className="text-gray-500 text-xs flex items-center gap-1 mb-0.5">
                  <Trophy className="w-3 h-3" /> Historical Incumbent
                </p>
                <p className="text-gray-200 font-medium">{data.historicalWinner}</p>
                {data.incumbentProbability != null && (
                  <p className="text-xs text-yellow-400 mt-0.5">
                    Won {Math.round(data.incumbentProbability * 100)}% of historical awards in this category
                  </p>
                )}
              </div>
            )}
            {data.competitionCount != null && (
              <div>
                <p className="text-gray-500 text-xs flex items-center gap-1 mb-0.5">
                  <Users className="w-3 h-3" /> Competing Firms
                </p>
                <p className="text-gray-200 font-mono text-2xl font-bold">{data.competitionCount}</p>
              </div>
            )}
            {(data.historicalAvgAward ?? 0) > 0 && (
              <div>
                <p className="text-gray-500 text-xs mb-0.5">Avg Historical Award</p>
                <p className="text-gray-200 font-mono">{fmt(data.historicalAvgAward!)}</p>
              </div>
            )}
            {data.agencySdvosbRate != null && data.agencySdvosbRate !== 0.05 && (
              <div>
                <p className="text-gray-500 text-xs flex items-center gap-1 mb-0.5">
                  <Shield className="w-3 h-3" /> Agency SDVOSB Rate
                </p>
                <p className="text-gray-200 font-mono">{Math.round(data.agencySdvosbRate * 100)}%</p>
              </div>
            )}
            {data.historicalAwardCount != null && (
              <div>
                <p className="text-gray-500 text-xs mb-0.5">Total Awards (5yr)</p>
                <p className="text-gray-200 font-mono">{data.historicalAwardCount.toLocaleString()}</p>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            {data.recompeteFlag && (
              <span className="text-xs bg-yellow-900/40 text-yellow-300 border border-yellow-700 px-2 py-1 rounded">
                Recompete Detected
              </span>
            )}
            {data.incumbentSignalDetected && (
              <span className="text-xs bg-orange-900/40 text-orange-300 border border-orange-700 px-2 py-1 rounded">
                Incumbent Signal in Documents
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── CONTRACT ANALYSIS MODULE NOTICE ──────────────────── */}
      {!hasAddon('contract_analysis') && (
        <div className="card" style={{ borderColor: 'rgba(91,116,255,0.25)' }}>
          <div className="flex items-start gap-3">
            <span className="text-[10px] font-semibold px-2 py-0.5 mt-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25 whitespace-nowrap">
              Add-On Required
            </span>
            <p className="text-sm text-slate-400 flex-1">
              Win Strategy, FAR/DFARS gap analysis, and the Compliance Matrix below are part of the{' '}
              <span className="text-slate-200 font-semibold">Contract Analysis &amp; Compliance</span> add-on ($59/mo).{' '}
              <Link to="/billing#addons" className="text-blue-400 hover:text-blue-300 font-semibold">Add it from Billing →</Link>
            </p>
          </div>
        </div>
      )}

      {/* ── WIN STRATEGY / BID GUIDANCE ──────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
            <Lightbulb className="w-5 h-5 text-yellow-400" />
            Win Strategy
            <span className="text-xs font-normal text-gray-500 ml-1">AI-extracted from solicitation text</span>
          </h2>
          <button
            onClick={handleGenerateBidGuidance}
            disabled={guidanceGenerating}
            className="flex items-center gap-1.5 text-sm bg-yellow-900/30 hover:bg-yellow-900/50 text-yellow-300 border border-yellow-800 px-3 py-1.5 rounded-lg transition-colors"
          >
            {guidanceGenerating
              ? <><Loader className="w-3.5 h-3.5 animate-spin" /> Analyzing...</>
              : <><Zap className="w-3.5 h-3.5" /> {guidance ? 'Re-analyze' : 'Analyze Solicitation'}</>}
          </button>
        </div>

        {guidanceError && <p className="text-red-400 text-xs mb-3">{guidanceError}</p>}

        {!guidance && !guidanceGenerating && (
          <div className="bg-gray-900/50 border border-gray-800 rounded-lg px-4 py-4 text-sm text-gray-500">
            <p className="font-medium text-gray-400 mb-1">No strategy analysis yet</p>
            <p>Click <span className="text-yellow-400">Analyze Solicitation</span> to extract plain-language bid strategy from the RFP — what the agency wants, how they&apos;ll score you, and how to win.</p>
            <p className="mt-2 text-xs text-gray-600">Configure your AI provider in Settings to enable strategy extraction.</p>
          </div>
        )}

        <AiProgressIndicator job={bidGuidanceJob} title="Analyzing solicitation with AI" />

        {/* USASpending historical context strip — shown only when real data exists */}
        {data && data.isEnriched && (data.historicalWinner || (data.historicalAwardCount ?? 0) > 0) && (
          <div className="mb-4 bg-gray-900/60 border border-gray-700 rounded-lg px-4 py-3">
            <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
              <TrendingUp className="w-3.5 h-3.5 text-blue-400" />
              USASpending Historical Intelligence
              <span className="ml-1 text-gray-700 normal-case">— used to inform this analysis</span>
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-1.5">
              {data.historicalWinner && (
                <div className="text-xs">
                  <span className="text-gray-500">Last winner: </span>
                  <span className="text-gray-200 font-medium">{data.historicalWinner}</span>
                  {data.recompeteFlag && (
                    <span className="ml-1.5 text-orange-400 font-medium">⚠ Recompete</span>
                  )}
                </div>
              )}
              {data.historicalAvgAward != null && (
                <div className="text-xs">
                  <span className="text-gray-500">Avg award: </span>
                  <span className="text-gray-200 font-medium">${Number(data.historicalAvgAward).toLocaleString()}</span>
                </div>
              )}
              {data.historicalAwardCount != null && (
                <div className="text-xs">
                  <span className="text-gray-500">Times competed (5yr): </span>
                  <span className="text-gray-200 font-medium">{data.historicalAwardCount}</span>
                </div>
              )}
              {data.competitionCount != null && (
                <div className="text-xs">
                  <span className="text-gray-500">Avg competitors: </span>
                  <span className="text-gray-200 font-medium">{data.competitionCount}</span>
                </div>
              )}
              {data.incumbentProbability != null && (
                <div className="text-xs">
                  <span className="text-gray-500">Incumbent win rate: </span>
                  <span className={`font-medium ${data.incumbentProbability > 0.6 ? 'text-red-400' : data.incumbentProbability > 0.4 ? 'text-yellow-400' : 'text-green-400'}`}>
                    {Math.round(data.incumbentProbability * 100)}%
                  </span>
                </div>
              )}
              {data.agencySdvosbRate != null && data.agencySdvosbRate !== 0.05 && (
                <div className="text-xs">
                  <span className="text-gray-500">Agency SDVOSB rate: </span>
                  <span className="text-blue-300 font-medium">{Math.round(data.agencySdvosbRate * 100)}%</span>
                </div>
              )}
              {data.agencySmallBizRate != null && data.agencySmallBizRate !== 0.25 && (
                <div className="text-xs">
                  <span className="text-gray-500">Agency SB rate: </span>
                  <span className="text-blue-300 font-medium">{Math.round(data.agencySmallBizRate * 100)}%</span>
                </div>
              )}
            </div>
          </div>
        )}

        {guidance && !guidanceGenerating && (
          <div className="space-y-5">
            {/* "What the Agency Wants" and "Core Requirements" now live in the
                "What Is This Contract?" card above (the plain-English synopsis),
                so they are intentionally not repeated here. This card focuses on
                the strategy: scoring, how to win, differentiators, and red flags. */}

            {/* Evaluation criteria */}
            {guidance.evaluationCriteria?.length > 0 && (
              <div>
                <p className="text-xs text-purple-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                  <BarChart3 className="w-3.5 h-3.5" /> How You&apos;ll Be Scored
                </p>
                <div className="space-y-2">
                  {guidance.evaluationCriteria.map((c: any, i: number) => {
                    const weightCls = c.relativeWeight === 'high'
                      ? 'bg-red-900/30 text-red-400 border-red-800'
                      : c.relativeWeight === 'medium'
                        ? 'bg-yellow-900/30 text-yellow-400 border-yellow-800'
                        : 'bg-gray-800 text-gray-400 border-gray-700'
                    return (
                      <div key={i} className="border border-gray-800 rounded-lg p-3 bg-gray-900/30">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-gray-200">{c.criterion}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded border capitalize ${weightCls}`}>
                            {c.relativeWeight} weight
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mb-1">{c.description}</p>
                        {c.winStrategy && (
                          <p className="text-xs text-green-400 flex gap-1">
                            <span className="flex-shrink-0">→</span> {c.winStrategy}
                          </p>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Winning approach */}
              {guidance.winningApproach?.length > 0 && (
                <div className="bg-green-950/20 border border-green-800/30 rounded-lg p-3">
                  <p className="text-xs text-green-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Trophy className="w-3.5 h-3.5" /> How to Win
                  </p>
                  <ul className="space-y-1.5">
                    {guidance.winningApproach.map((item: string, i: number) => (
                      <li key={i} className="text-xs text-gray-300 flex gap-2">
                        <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Key differentiators */}
              {guidance.keyDifferentiators?.length > 0 && (
                <div className="bg-yellow-950/20 border border-yellow-800/30 rounded-lg p-3">
                  <p className="text-xs text-yellow-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <Star className="w-3.5 h-3.5" /> Differentiators to Emphasize
                  </p>
                  <ul className="space-y-1.5">
                    {guidance.keyDifferentiators.map((item: string, i: number) => (
                      <li key={i} className="text-xs text-gray-300 flex gap-2">
                        <span className="text-yellow-500 flex-shrink-0">★</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Red flags */}
              {guidance.redFlags?.length > 0 && (
                <div className="bg-red-950/20 border border-red-800/30 rounded-lg p-3">
                  <p className="text-xs text-red-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" /> Red Flags
                  </p>
                  <ul className="space-y-1.5">
                    {guidance.redFlags.map((item: string, i: number) => (
                      <li key={i} className="text-xs text-gray-300 flex gap-2">
                        <AlertTriangle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Must-dos */}
              {guidance.submissionMustDos?.length > 0 && (
                <div className="bg-orange-950/20 border border-orange-800/30 rounded-lg p-3">
                  <p className="text-xs text-orange-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                    <ClipboardList className="w-3.5 h-3.5" /> Submission Must-Dos
                  </p>
                  <ul className="space-y-1.5">
                    {guidance.submissionMustDos.map((item: string, i: number) => (
                      <li key={i} className="text-xs text-gray-300 flex gap-2">
                        <span className="text-orange-500 flex-shrink-0">!</span>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {guidance.generatedAt && (
              <p className="text-xs text-gray-700">
                Analyzed {new Date(guidance.generatedAt).toLocaleString()}
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── §6 OPPORTUNITY INTELLIGENCE ──────────────────────
          Capability match + eligibility (§6.1E/F), transparent score and
          confidence interval (§6.2A/H), competition evidence (§6.2C/D),
          pricing sensitivity (§6.2E), capability gaps (§6.2F), requirement
          intelligence (§6.3) and the milestone timeline (§6.4). */}
      {id && <OpportunityIntelPanel opportunityId={id} />}

      {/* §8.1 — agency contacts, interaction history and the next follow-up.
          Composition only; weighted value stays with the portfolio service. */}
      {id && <OpportunityCrmPanel opportunityId={id} />}

      {/* ── COMPLIANCE GAP ANALYSIS (FAR/DFARS) ─────────────── */}
      {id && (
        <div className="card">
          <ComplianceGapAnalysis opportunityId={id} />
        </div>
      )}

      {/* ── COMPLIANCE MATRIX ────────────────────────────────── */}
      {(() => {
        const reqs: any[] = matrix?.requirements ?? []
        const done = reqs.filter((r: any) => r.status === 'COMPLETE').length
        const pct = reqs.length ? Math.round((done / reqs.length) * 100) : 0

        const statusMeta: Record<string, { label: string; cls: string }> = {
          NOT_STARTED:   { label: 'Not Started',    cls: 'bg-gray-800 text-gray-400' },
          IN_PROGRESS:   { label: 'In Progress',    cls: 'bg-blue-900/40 text-blue-300 border border-blue-700' },
          COMPLETE:      { label: 'Complete',       cls: 'bg-green-900/40 text-green-300 border border-green-700' },
          WAIVED:        { label: 'Waived',         cls: 'bg-yellow-900/40 text-yellow-300 border border-yellow-700' },
          NON_COMPLIANT: { label: 'Non-Compliant',  cls: 'bg-red-900/40 text-red-300 border border-red-700' },
        }
        const typeMeta: Record<string, string> = {
          INSTRUCTION:   'bg-blue-900/30 text-blue-400',
          EVALUATION:    'bg-purple-900/30 text-purple-400',
          CLAUSE:        'bg-orange-900/30 text-orange-400',
          CERTIFICATION: 'bg-teal-900/30 text-teal-400',
        }

        return (
          <div className="card">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
                <Table2 className="w-5 h-5 text-blue-400" />
                Compliance Matrix
                {reqs.length > 0 && (
                  <span className="text-xs font-normal text-gray-500 ml-1">
                    {done}/{reqs.length} complete ({pct}%)
                  </span>
                )}
              </h2>
              <button
                onClick={handleGenerateMatrix}
                disabled={matrixGenerating}
                className="flex items-center gap-1.5 text-sm bg-blue-900/30 hover:bg-blue-900/50 text-blue-300 border border-blue-800 px-3 py-1.5 rounded-lg transition-colors"
              >
                {matrixGenerating
                  ? <><Loader className="w-3.5 h-3.5 animate-spin" /> Generating...</>
                  : <><RefreshCw className="w-3.5 h-3.5" /> {reqs.length ? 'Regenerate' : 'Generate Matrix'}</>}
              </button>
            </div>

            {matrixError && <p className="text-red-400 text-xs mb-3">{matrixError}</p>}

            {matrixLoading && (
              <p className="text-gray-500 text-sm flex items-center gap-2">
                <Loader className="w-4 h-4 animate-spin" /> Loading...
              </p>
            )}

            {!matrixLoading && reqs.length === 0 && (
              <div className="bg-gray-900/50 border border-gray-800 rounded-lg px-4 py-4 text-sm text-gray-500">
                <p className="font-medium text-gray-400 mb-1">No compliance matrix yet</p>
                <p>Click <span className="text-blue-400">Generate Matrix</span> to extract Section L/M requirements from the opportunity description or any uploaded solicitation document.</p>
                <p className="mt-2 text-xs text-gray-600">Tip: Upload the full RFP/SOW first for best results. Configure your AI provider in Settings for AI-powered requirement extraction.</p>
              </div>
            )}

            {reqs.length > 0 && (
              <>
                {/* Progress bar */}
                <div className="w-full bg-gray-800 rounded-full h-1.5 mb-4">
                  <div
                    className="h-1.5 rounded-full bg-green-500 transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>

                {/* Legend */}
                <div className="flex flex-wrap gap-2 mb-4 text-xs">
                  {Object.entries(typeMeta).map(([type, cls]) => (
                    <span key={type} className={`px-2 py-0.5 rounded ${cls}`}>{type}</span>
                  ))}
                  <span className="text-gray-600 ml-2">Click status badge to cycle through states.</span>
                </div>

                {/* Table */}
                <div className="overflow-x-auto rounded-lg border border-gray-800">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-gray-800 bg-gray-900/60">
                        <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium w-20">Section</th>
                        <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium w-24">Type</th>
                        <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Requirement</th>
                        <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium w-36">Proposal Section</th>
                        <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium w-32">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {reqs.map((req: any) => {
                        const sm = statusMeta[req.status] ?? statusMeta.NOT_STARTED
                        const tm = typeMeta[req.sectionType] ?? typeMeta.INSTRUCTION
                        const isEditing = editingReqId === req.id
                        return (
                          <tr key={req.id} className="border-b border-gray-800/60 hover:bg-gray-800/20">
                            <td className="px-3 py-2.5">
                              <span className="font-mono text-xs text-gray-300">{req.section}</span>
                              {req.farReference && (
                                <p className="text-xs text-orange-400 mt-0.5">{req.farReference}</p>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <span className={`text-xs px-1.5 py-0.5 rounded ${tm}`}>{req.sectionType}</span>
                            </td>
                            <td className="px-3 py-2.5">
                              <p className="text-gray-200 leading-snug text-xs">{req.requirementText}</p>
                              {!req.isMandatory && (
                                <span className="text-xs text-gray-600 italic">optional</span>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              {isEditing ? (
                                <div className="flex gap-1">
                                  <input
                                    // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: this field only renders when the user clicks Edit on a row, so focus follows their explicit action
                                    className="input text-xs py-1 px-2 w-24"
                                    value={editProposalSection}
                                    onChange={(e) => setEditProposalSection(e.target.value)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') handleUpdateRequirement(req.id, editProposalSection)
                                      if (e.key === 'Escape') setEditingReqId(null)
                                    }}
                                    placeholder="e.g. Vol I §3"
                                  />
                                  <button
                                    className="text-green-400 hover:text-green-300"
                                    onClick={() => handleUpdateRequirement(req.id, editProposalSection)}
                                  >
                                    <CheckCircle className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ) : (
                                <button
                                  className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 group"
                                  onClick={() => { setEditingReqId(req.id); setEditProposalSection(req.proposalSection ?? '') }}
                                >
                                  <span className={req.proposalSection ? 'text-gray-200' : 'text-gray-600 italic'}>
                                    {req.proposalSection || 'Click to set'}
                                  </span>
                                  <Pencil className="w-3 h-3 opacity-0 group-hover:opacity-100" />
                                </button>
                              )}
                            </td>
                            <td className="px-3 py-2.5">
                              <button
                                onClick={() => handleCycleStatus(req)}
                                className={`text-xs px-2 py-0.5 rounded cursor-pointer hover:opacity-80 ${sm.cls}`}
                                title="Click to cycle status"
                              >
                                {sm.label}
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <p className="text-xs text-gray-700 mt-2">
                  Generated {new Date(matrix.generatedAt).toLocaleString()} · {reqs.length} requirements extracted
                </p>
              </>
            )}
          </div>
        )
      })()}

      {/* ── PROPOSAL WRITING ASSISTANT ───────────────────────── */}
      {hasAddon('proposal_studio') ? (() => {
        const CATEGORY_COLORS: Record<string, string> = {
          PRICING: 'bg-green-900/40 text-green-300 border-green-700/50',
          TECHNICAL: 'bg-blue-900/40 text-blue-300 border-blue-700/50',
          PERSONNEL: 'bg-purple-900/40 text-purple-300 border-purple-700/50',
          PAST_PERFORMANCE: 'bg-amber-900/40 text-amber-300 border-amber-700/50',
          TEAMING: 'bg-cyan-900/40 text-cyan-300 border-cyan-700/50',
          CERTIFICATIONS: 'bg-pink-900/40 text-pink-300 border-pink-700/50',
          OTHER: 'bg-gray-800 text-gray-400 border-gray-700',
        }
        return (
          <div className="card">
            {/* Header */}
            <div className="flex items-center justify-between mb-1">
              <h2 className="text-lg font-semibold text-gray-200 flex items-center gap-2">
                <Lightbulb className="w-5 h-5 text-amber-400" />
                Proposal Writing Assistant
                <span className="text-xs font-normal text-amber-500 bg-amber-900/20 border border-amber-700/30 px-2 py-0.5 rounded-full ml-1">Add-On</span>
              </h2>
              {/* Token balance */}
              <div className="flex items-center gap-3">
                {tokenBalance !== null && (
                  <span className="text-xs text-gray-400 flex items-center gap-1">
                    🪙 <span className={tokenBalance === 0 ? 'text-red-400 font-medium' : 'text-gray-300'}>{tokenBalance} token{tokenBalance !== 1 ? 's' : ''}</span>
                    <Link to="/billing" className="text-blue-400 hover:text-blue-300 ml-1">Buy more →</Link>
                  </span>
                )}
                <button
                  onClick={handleGenerateProposalOutline}
                  disabled={proposalGenerating || draftGenerating}
                  className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg transition-colors"
                  style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.3)', color: '#5b74ff' }}
                  title="Costs 1 proposal token"
                >
                  {proposalGenerating
                    ? <><Loader className="w-3.5 h-3.5 animate-spin" /> Generating...</>
                    : <><Zap className="w-3.5 h-3.5" /> {proposalOutline ? 'Regenerate Outline' : 'Generate Outline'} (1 token)</>}
                </button>
              </div>
            </div>

            {/* Step indicator */}
            <div className="flex items-center gap-2 mb-4 mt-2">
              {(['Step 1: Outline', 'Step 2: Answer Questions', 'Step 3: Generate Draft'] as const).map((label, i) => {
                const active = i === 0 ? proposalStep !== 'idle' : i === 1 ? proposalStep === 'answering' : false
                const done = i === 0 ? proposalStep !== 'idle' : false
                return (
                  <div key={i} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-gray-700 text-xs">›</span>}
                    <span className={`text-xs px-2 py-0.5 rounded-full border ${active || done ? 'bg-amber-900/30 text-amber-300 border-amber-700/40' : 'bg-gray-900 text-gray-600 border-gray-800'}`}>
                      {label}
                    </span>
                  </div>
                )
              })}
            </div>

            {proposalError && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-red-950/30 border border-red-800/40 text-xs text-red-300 flex items-start gap-2">
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                <span>{proposalError} {proposalError.includes('token') && <Link to="/billing" className="underline ml-1">Purchase tokens →</Link>}</span>
              </div>
            )}

            <div className="mb-3">
              <AiProgressIndicator job={outlineJob} title="Generating proposal outline" />
            </div>

            {/* Step 1 idle state */}
            {proposalStep === 'idle' && !proposalGenerating && (
              <div className="bg-gray-900/50 border border-gray-800 rounded-lg px-4 py-4 text-sm text-gray-500">
                <p className="font-medium text-gray-400 mb-1">Start with Step 1 — Generate an Outline</p>
                <p>The AI will analyze this opportunity and create an executive summary, win themes, and section structure. Then it will ask you targeted questions to personalize your draft.</p>
                <p className="mt-2 text-xs text-gray-600">Tip: Generate the Compliance Matrix first for best results. Outline costs 1 token · Full Draft PDF costs 5 tokens.</p>
              </div>
            )}

            {/* Outline display */}
            {proposalOutline && !proposalGenerating && (
              <div className="space-y-4">
                {proposalOutline.executiveSummary && (
                  <div className="bg-blue-950/30 border border-blue-800/40 rounded-lg p-4">
                    <p className="text-xs text-blue-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                      <FileText className="w-3.5 h-3.5" /> Executive Summary Approach
                    </p>
                    <p className="text-sm text-gray-200 leading-relaxed">{proposalOutline.executiveSummary}</p>
                  </div>
                )}
                {proposalOutline.winThemes?.length > 0 && (
                  <div>
                    <p className="text-xs text-amber-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                      <Trophy className="w-3.5 h-3.5" /> Win Themes
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {proposalOutline.winThemes.map((theme: string, i: number) => (
                        <span key={i} className="text-xs bg-amber-900/20 text-amber-300 border border-amber-700/30 px-2 py-1 rounded">{theme}</span>
                      ))}
                    </div>
                  </div>
                )}
                {proposalOutline.sections?.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1">
                      <ClipboardList className="w-3.5 h-3.5" /> Proposed Sections
                    </p>
                    <div className="overflow-x-auto rounded-lg border border-gray-800">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-gray-800 bg-gray-900/60">
                            <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Section</th>
                            <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium">Description</th>
                            <th className="text-left px-3 py-2 text-xs text-gray-500 font-medium w-28">Pages</th>
                          </tr>
                        </thead>
                        <tbody>
                          {proposalOutline.sections.map((sec: any, i: number) => (
                            <tr key={i} className="border-b border-gray-800/60 hover:bg-gray-800/20">
                              <td className="px-3 py-2.5">
                                <p className="text-gray-200 font-medium text-xs">{sec.title}</p>
                                {sec.keyPoints?.length > 0 && (
                                  <div className="flex flex-wrap gap-1 mt-1">
                                    {sec.keyPoints.map((kp: string, j: number) => (
                                      <span key={j} className="text-[10px] bg-gray-800 text-gray-400 px-1.5 py-0.5 rounded">{kp}</span>
                                    ))}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-xs text-gray-400">{sec.description}</td>
                              <td className="px-3 py-2.5 text-xs text-gray-500 font-mono">{sec.pageEstimate}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {proposalOutline.discriminators?.length > 0 && (
                    <div className="bg-green-950/20 border border-green-800/30 rounded-lg p-3">
                      <p className="text-xs text-green-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <Star className="w-3.5 h-3.5" /> Key Discriminators
                      </p>
                      <ul className="space-y-1.5">
                        {proposalOutline.discriminators.map((d: string, i: number) => (
                          <li key={i} className="text-xs text-gray-300 flex gap-2">
                            <CheckCircle className="w-3.5 h-3.5 text-green-500 flex-shrink-0 mt-0.5" />{d}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {proposalOutline.riskMitigations?.length > 0 && (
                    <div className="bg-orange-950/20 border border-orange-800/30 rounded-lg p-3">
                      <p className="text-xs text-orange-400 uppercase tracking-wider mb-2 flex items-center gap-1">
                        <AlertTriangle className="w-3.5 h-3.5" /> Risk Mitigations
                      </p>
                      <ul className="space-y-1.5">
                        {proposalOutline.riskMitigations.map((r: string, i: number) => (
                          <li key={i} className="text-xs text-gray-300 flex gap-2">
                            <span className="text-orange-500 flex-shrink-0">!</span>{r}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
                {proposalOutline.pastPerformanceHint && (
                  <div className="bg-purple-950/20 border border-purple-800/30 rounded-lg p-3">
                    <p className="text-xs text-purple-400 uppercase tracking-wider mb-1 flex items-center gap-1">
                      <UserCheck className="w-3.5 h-3.5" /> Past Performance Guidance
                    </p>
                    <p className="text-xs text-gray-300">{proposalOutline.pastPerformanceHint}</p>
                  </div>
                )}
              </div>
            )}

            {/* Step 2 — Q&A Interview */}
            {proposalStep !== 'idle' && !proposalGenerating && (
              <div className="mt-5 border-t border-gray-800 pt-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-200 flex items-center gap-2">
                    <Send className="w-4 h-4 text-blue-400" />
                    Step 2 — Answer Questions to Strengthen Your Draft
                  </h3>
                  <button
                    onClick={handleSkipAllQuestions}
                    className="text-xs text-gray-500 hover:text-gray-300 underline"
                  >
                    Let AI handle everything
                  </button>
                </div>

                {questionsLoading ? (
                  <p className="text-xs text-gray-500 flex items-center gap-2">
                    <Loader className="w-3.5 h-3.5 animate-spin" /> Generating targeted questions...
                  </p>
                ) : proposalQuestions.length === 0 ? (
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>Questions not loaded.</span>
                    <button
                      onClick={() => proposalOutline && handleGenerateQuestions(proposalOutline)}
                      className="text-blue-400 hover:text-blue-300 underline"
                    >
                      Load questions
                    </button>
                    <span className="text-gray-700">or click &ldquo;Let AI handle everything&rdquo; above to skip.</span>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {proposalQuestions.map((q: any) => {
                      const ans = proposalAnswers[q.id] ?? { answer: '', aiDecide: false }
                      return (
                        <div key={q.id} className="bg-gray-900/60 border border-gray-800 rounded-lg p-3">
                          <div className="flex items-start justify-between gap-2 mb-2">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${CATEGORY_COLORS[q.category] ?? CATEGORY_COLORS.OTHER}`}>
                                {q.category.replace(/_/g, ' ')}
                              </span>
                              {q.required && <span className="text-[10px] text-amber-400">★ Priority</span>}
                              <span className="text-xs text-gray-300">{q.question}</span>
                            </div>
                            <label className="flex items-center gap-1.5 flex-shrink-0 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={ans.aiDecide}
                                onChange={e => setProposalAnswers(prev => ({ ...prev, [q.id]: { ...ans, aiDecide: e.target.checked } }))}
                                className="w-3.5 h-3.5 accent-blue-500"
                              />
                              <span className="text-[10px] text-gray-500 whitespace-nowrap">AI decide</span>
                            </label>
                          </div>
                          {!ans.aiDecide && (
                            <input
                              type="text"
                              value={ans.answer}
                              onChange={e => setProposalAnswers(prev => ({ ...prev, [q.id]: { ...ans, answer: e.target.value } }))}
                              placeholder={q.hint}
                              className="w-full bg-gray-800 border border-gray-700 rounded text-xs text-gray-200 px-2.5 py-1.5 focus:outline-none focus:border-blue-500 placeholder-gray-600"
                            />
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Step 3 — Generate Draft */}
            {proposalStep !== 'idle' && !proposalGenerating && (
              <div className="mt-5 border-t border-gray-800 pt-4 space-y-4">

                {/* Bid Forms Upload */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-semibold text-gray-400 flex items-center gap-1.5">
                      <Upload className="w-3.5 h-3.5 text-amber-400" />
                      Bid Forms <span className="text-gray-600 font-normal">(optional — PDF, Excel, CSV, Word)</span>
                    </p>
                    <button
                      onClick={() => bidFormInputRef.current?.click()}
                      disabled={bidFormUploading}
                      className="text-xs px-2.5 py-1 rounded-lg flex items-center gap-1 transition-colors"
                      style={{ background: 'rgba(91,116,255,0.1)', border: '1px solid rgba(91,116,255,0.25)', color: '#5b74ff' }}
                    >
                      {bidFormUploading ? <><Loader className="w-3 h-3 animate-spin" /> Extracting...</> : <><Upload className="w-3 h-3" /> Upload Form</>}
                    </button>
                    <input
                      ref={bidFormInputRef}
                      type="file"
                      className="hidden"
                      accept=".pdf,.doc,.docx,.xlsx,.xls,.csv,.txt"
                      onChange={handleBidFormUpload}
                    />
                  </div>
                  {bidFormError && <p className="text-xs text-red-400 mb-1">{bidFormError}</p>}
                  {bidForms.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {bidForms.map((f, i) => (
                        <div key={i} className="flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-full"
                          style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80' }}>
                          <FileText className="w-3 h-3" />
                          {f.name}
                          <button onClick={() => setBidForms(prev => prev.filter((_, j) => j !== i))}
                            className="text-gray-500 hover:text-red-400 ml-0.5">×</button>
                        </div>
                      ))}
                    </div>
                  )}
                  {bidForms.length === 0 && !bidFormUploading && (
                    <p className="text-[11px] text-gray-600">Upload government bid forms (SF-1449, SF-33, etc.) so the AI can incorporate required fields into the proposal.</p>
                  )}
                </div>

                {/* Truncation banner — persistent warning when the AI hit
                    its length limit and only the salvaged sections made it
                    into the PDF. Survives reopen via savedProposalDraft.partial. */}
                {draftPartial && (
                  <div className="flex items-start gap-3 p-3 rounded-lg"
                    style={{ background: 'rgba(234,179,8,0.10)', border: '1px solid rgba(234,179,8,0.35)' }}>
                    <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
                    <div className="flex-1">
                      <p className="text-sm text-yellow-200 font-medium">Draft is partial — review before submission.</p>
                      <p className="text-[11px] text-yellow-300/80 mt-0.5">
                        The AI hit its output length limit. Earlier sections are complete; the final section(s) may be missing or truncated. Read the PDF end-to-end before sending it to the agency. Regenerating may produce a complete draft (charges 5 tokens).
                      </p>
                    </div>
                  </div>
                )}

                {/* Saved draft banner — appears when a draft has already been generated for this opportunity */}
                {hasSavedDraft && !draftDownloadUrl && (
                  <div className="flex items-center gap-3 p-3 rounded-lg border-t border-gray-800/60"
                    style={{ background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.25)' }}>
                    <CheckCircle className="w-4 h-4 text-blue-400 flex-shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm text-blue-200">A previously generated draft is on file{savedDraftAt ? ` from ${new Date(savedDraftAt).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ''}.</p>
                      <p className="text-[11px] text-gray-500 mt-0.5">Re-download is free. Regenerating will charge 5 tokens.</p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!id) return
                        try {
                          const blob = await proposalAssistApi.downloadSavedDraftPdf(id)
                          const url = URL.createObjectURL(blob)
                          const a = document.createElement('a')
                          a.href = url
                          a.download = `Proposal_Draft_${id.slice(0, 8)}.pdf`
                          document.body.appendChild(a)
                          a.click()
                          document.body.removeChild(a)
                          URL.revokeObjectURL(url)
                        } catch (err: any) {
                          setProposalError(err?.response?.data?.error || 'Could not download saved draft')
                        }
                      }}
                      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium flex-shrink-0"
                      style={{ background: 'rgba(59,130,246,0.18)', border: '1px solid rgba(59,130,246,0.4)', color: '#60a5fa' }}
                    >
                      <FileDown className="w-3.5 h-3.5" /> Download Saved Draft
                    </button>
                  </div>
                )}

                {/* FIX-6 — human-in-the-loop attestation gate for the final export */}
                {id && hasSavedDraft && <ProposalAttestationPanel opportunityId={id} />}

                {/* Client branding selector — picks which client's identity
                    appears on the proposal PDF cover. Empty value falls back
                    to firm default branding (the historical behavior). */}
                <div className="border-t border-gray-800/60 pt-3">
                  <label htmlFor="proposal-client-select" className="block text-xs font-medium text-gray-400 mb-1.5">
                    Submit proposal as
                  </label>
                  <select
                    id="proposal-client-select"
                    value={proposalClientId}
                    onChange={(e) => setProposalClientId(e.target.value)}
                    disabled={draftGenerating}
                    className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500 disabled:opacity-50"
                  >
                    <option value="">Use firm default branding</option>
                    {[...clients]
                      .filter((c: any) => c.isActive !== false)
                      .sort((a: any, b: any) => (a.name || '').localeCompare(b.name || ''))
                      .map((c: any) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                          {c.uei ? ` · UEI ${c.uei}` : ''}
                        </option>
                      ))}
                  </select>
                  <p className="text-[11px] text-gray-500 mt-1">
                    {proposalClientId
                      ? 'PDF cover, logo, and footer will reflect the selected client\'s branding (configured on the Client Detail page).'
                      : 'No client selected — the PDF will use the firm default branding.'}
                  </p>
                </div>

                {/* Generate Draft */}
                <div className="flex items-center justify-between border-t border-gray-800/60 pt-3">
                  <p className="text-xs text-gray-500">
                    {draftGenerating
                      ? 'Writing full proposal draft — this typically takes 3–5 minutes. Do not close this tab; the page will update automatically when the PDF is ready.'
                      : draftDownloadUrl
                        ? 'Draft ready! Click Download if it did not save automatically.'
                        : hasSavedDraft
                          ? 'A draft is already saved (above). Regenerating will charge 5 tokens again.'
                          : 'Ready to generate your full draft PDF. This will cost 5 proposal tokens.'}
                  </p>
                  <button
                    onClick={handleGenerateDraftPdf}
                    disabled={draftGenerating || questionsLoading || bidFormUploading}
                    className="flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg transition-colors flex-shrink-0"
                    style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.3)', color: '#22c55e' }}
                  >
                    {draftGenerating
                      ? <><Loader className="w-3.5 h-3.5 animate-spin" /> Writing Draft...</>
                      : hasSavedDraft
                        ? <><FileDown className="w-3.5 h-3.5" /> Regenerate Draft (5 tokens)</>
                        : <><FileDown className="w-3.5 h-3.5" /> Generate Full Draft PDF (5 tokens)</>}
                  </button>
                </div>
                {draftDownloadUrl && (
                  <div ref={draftSuccessRef} className="mt-3 flex items-center gap-3 p-3 rounded-lg"
                    style={{ background: 'rgba(34,197,94,0.08)', border: '1px solid rgba(34,197,94,0.25)' }}>
                    <CheckCircle className="w-4 h-4 text-green-400 flex-shrink-0" />
                    <span className="text-sm text-green-300 flex-1">Draft generated successfully!</span>
                    <a
                      href={draftDownloadUrl}
                      download={draftFileName}
                      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg font-medium"
                      style={{ background: 'rgba(34,197,94,0.18)', border: '1px solid rgba(34,197,94,0.4)', color: '#4ade80' }}
                    >
                      <FileDown className="w-3.5 h-3.5" /> Download PDF
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })() : (
        <div className="card">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl flex-shrink-0"
              style={{ background: 'rgba(91,116,255,0.08)', border: '1px solid rgba(91,116,255,0.2)' }}>
              <Lightbulb className="w-6 h-6 text-amber-400" />
            </div>
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-base font-semibold text-slate-100">Proposal Studio</h3>
                <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/25">
                  Add-On Required
                </span>
              </div>
              <p className="text-sm text-slate-400 mb-3">
                AI-guided 3-step proposal workflow — outline, targeted Q&A interview, then a full draft PDF with your pricing, personnel, and win strategy woven in. Includes 25 proposal tokens every month.
              </p>
              <Link
                to="/billing#addons"
                className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg transition-all"
                style={{ background: 'rgba(91,116,255,0.12)', border: '1px solid rgba(91,116,255,0.3)', color: '#5b74ff' }}
              >
                <Zap className="w-4 h-4" /> Add Proposal Studio — $79/mo →
              </Link>
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

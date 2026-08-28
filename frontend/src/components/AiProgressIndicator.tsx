import { Loader, X } from 'lucide-react'
import type { UseAiJobProgress } from '../hooks/useAiJobProgress'

// Section 4 #3: shared progress affordance for the synchronous AI operations.
// Shows the current phase, a live elapsed timer, realistic duration guidance,
// and a cancel button — so a 15–40s call reads as working rather than frozen.

export function AiProgressIndicator({
  job,
  title = 'Working…',
}: {
  job: Pick<UseAiJobProgress, 'phase' | 'elapsedSec' | 'etaHint' | 'cancel' | 'running'>
  title?: string
}) {
  if (!job.running) return null
  return (
    <div className="border border-gray-700 bg-gray-900/60 rounded-lg p-4 flex items-center gap-3">
      <Loader className="w-5 h-5 animate-spin text-blue-400 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-gray-200">{title}</p>
        <p className="text-xs text-gray-400 mt-0.5">
          {job.phase} · {job.elapsedSec}s elapsed <span className="text-gray-600">({job.etaHint})</span>
        </p>
      </div>
      <button
        onClick={job.cancel}
        className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 border border-gray-700 hover:border-gray-600 rounded px-2 py-1 transition-colors"
      >
        <X className="w-3.5 h-3.5" /> Cancel
      </button>
    </div>
  )
}

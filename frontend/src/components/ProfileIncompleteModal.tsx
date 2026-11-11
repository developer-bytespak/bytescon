// Shown when the server refuses scoring, analysis or a proposal because the
// company profile it uses is incomplete (422 PROFILE_INCOMPLETE). The API
// client broadcasts 'bytescon:profile-incomplete'; this turns it into the
// list of what to fill and a link to fill it.
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { ClipboardList, X } from 'lucide-react'
import type { ProfileMissingField } from '../services/api'
import { fieldHref, profileHref, PROFILE_STATUS_KEY } from '../hooks/useProfileStatus'

interface Detail {
  error?: string
  clientCompanyId: string | null
  clientName: string | null
  isSelf: boolean
  missing: ProfileMissingField[]
}

export function ProfileIncompleteModal() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [detail, setDetail] = useState<Detail | null>(null)

  useEffect(() => {
    const onIncomplete = (e: Event) => {
      const d = (e as CustomEvent).detail as Detail | undefined
      if (!d) return
      setDetail((prev) => prev ?? d)
      void queryClient.invalidateQueries({ queryKey: PROFILE_STATUS_KEY })
    }
    window.addEventListener('bytescon:profile-incomplete', onIncomplete)
    return () => window.removeEventListener('bytescon:profile-incomplete', onIncomplete)
  }, [queryClient])

  if (!detail) return null
  const close = () => setDetail(null)
  const go = (to: string) => { close(); navigate(to) }
  // No profile named: a consulting firm with no complete client.
  const target = detail.clientCompanyId || detail.isSelf ? profileHref(detail) : '/clients'

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="profile-incomplete-title" className="modal-panel rounded-xl p-6 w-full max-w-md space-y-4" style={{ background: 'var(--surface)', border: '1px solid var(--accent-line)' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="inline-grid place-items-center w-10 h-10 rounded-full" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
              <ClipboardList className="w-5 h-5" aria-hidden="true" />
            </span>
            <h2 id="profile-incomplete-title" className="text-base font-bold" style={{ color: 'var(--text)' }}>Complete your profile first</h2>
          </div>
          <button type="button" onClick={close} aria-label="Close" className="text-slate-500 hover:text-slate-300"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm" style={{ color: 'var(--text-2)' }}>
          {detail.error ?? 'This needs a complete company profile.'} Scores, analysis and proposals use the profile, so it has to be filled in first.
        </p>
        {detail.missing.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-muted)' }}>Still needed</p>
            <ul className="space-y-1">
              {detail.missing.map((m) => (
                <li key={m.key} className="text-sm">
                  <button type="button" onClick={() => go(fieldHref(m.where, detail))} className="underline underline-offset-2" style={{ color: 'var(--accent)' }}>
                    {m.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-3 pt-1">
          <button type="button" onClick={close} className="btn-secondary px-4 py-2 text-sm">Not now</button>
          <button type="button" onClick={() => go(target)} className="btn-primary px-4 py-2 text-sm">
            {detail.clientCompanyId || detail.isSelf ? 'Complete profile' : 'Go to clients'}
          </button>
        </div>
      </div>
    </div>
  )
}

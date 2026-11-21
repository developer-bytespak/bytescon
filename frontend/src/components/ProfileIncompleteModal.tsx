// Shown when the server refuses scoring, analysis or a proposal because the
// company profile it uses is incomplete (422 PROFILE_INCOMPLETE). The API
// client broadcasts 'bytesgov:profile-incomplete'; this turns it into the
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
    window.addEventListener('bytesgov:profile-incomplete', onIncomplete)
    return () => window.removeEventListener('bytesgov:profile-incomplete', onIncomplete)
  }, [queryClient])

  if (!detail) return null
  const close = () => setDetail(null)
  const go = (to: string) => { close(); navigate(to) }
  // No profile named: a consulting firm with no complete client.
  const target = detail.clientCompanyId || detail.isSelf ? profileHref(detail) : '/clients'

  return (
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(17,17,17,0.4)' }}>
      <div role="dialog" aria-modal="true" aria-labelledby="profile-incomplete-title" className="modal-panel p-7 w-full max-w-md space-y-5" style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-3)' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="inline-grid place-items-center w-10 h-10 rounded-full" style={{ background: 'var(--surface-3)', color: 'var(--text)' }}>
              <ClipboardList className="w-5 h-5" aria-hidden="true" />
            </span>
            <h2 id="profile-incomplete-title" className="text-[20px] leading-[28px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text)' }}>Complete your profile first</h2>
          </div>
          <button type="button" onClick={close} aria-label="Close" className="btn-ghost btn-sm !px-2"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-[15px] leading-[22px]" style={{ color: 'var(--text-muted)' }}>
          {detail.error ?? 'This needs a complete company profile.'} Scores, analysis and proposals use the profile, so it has to be filled in first.
        </p>
        {detail.missing.length > 0 && (
          <div className="pt-4" style={{ borderTop: '1px solid var(--line)' }}>
            <p className="text-sm font-semibold mb-2" style={{ color: 'var(--text)' }}>Still needed</p>
            <ul className="space-y-1.5">
              {detail.missing.map((m) => (
                <li key={m.key} className="text-sm">
                  <button type="button" onClick={() => go(fieldHref(m.where, detail))} className="underline underline-offset-2" style={{ color: 'var(--text-2)' }}>
                    {m.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-3 pt-1">
          <button type="button" onClick={close} className="btn-secondary">Not now</button>
          <button type="button" onClick={() => go(target)} className="btn-primary">
            {detail.clientCompanyId || detail.isSelf ? 'Complete profile' : 'Go to clients'}
          </button>
        </div>
      </div>
    </div>
  )
}

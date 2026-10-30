import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AnimatePresence, motion } from 'framer-motion'
import { Bell, X } from 'lucide-react'
import { notificationsApi } from '../services/api'

interface UnreadItem {
  id: string
  title: string
  body: string | null
  linkPath: string | null
}

const POLL_MS = 20_000
const POPUP_MS = 5_000

// Shared unread poll. Keyed under ['notifications'] so the Notifications page's
// invalidations (mark read, archive) refresh the bell badge too.
export function useUnreadNotifications() {
  return useQuery<{ data: { items: UnreadItem[]; unreadCount: number } }>({
    queryKey: ['notifications', 'unread-poll'],
    queryFn: () => notificationsApi.list({ unread: 'true', limit: 10 }),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
  })
}

/**
 * Phone-style popups for notifications that arrive while the app is open. Each
 * shows for 5 seconds; the notification itself stays in the Notifications page.
 * Notifications already unread at page load are not popped — only new ones.
 */
export function NotificationPopups() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data } = useUnreadNotifications()
  const seen = useRef<Set<string> | null>(null)
  const [popups, setPopups] = useState<UnreadItem[]>([])

  useEffect(() => {
    const items = data?.data?.items
    if (!items) return
    if (seen.current === null) {
      seen.current = new Set(items.map((n) => n.id))
      return
    }
    const fresh = items.filter((n) => !seen.current!.has(n.id))
    if (fresh.length === 0) return
    fresh.forEach((n) => seen.current!.add(n.id))
    setPopups((prev) => [...fresh, ...prev].slice(0, 3))
    for (const n of fresh) {
      setTimeout(() => setPopups((prev) => prev.filter((p) => p.id !== n.id)), POPUP_MS)
    }
  }, [data])

  const dismiss = (id: string) => setPopups((prev) => prev.filter((p) => p.id !== id))

  const open = async (n: UnreadItem) => {
    dismiss(n.id)
    try { await notificationsApi.markRead(n.id) } catch { /* stays unread; the page still lists it */ }
    qc.invalidateQueries({ queryKey: ['notifications'] })
    navigate(n.linkPath || '/notifications')
  }

  return (
    <div className="fixed top-4 right-4 left-4 sm:left-auto z-[130] flex flex-col items-end gap-2 sm:w-[360px] pointer-events-none" aria-live="polite">
      <AnimatePresence initial={false}>
        {popups.map((n) => (
          <motion.div
            key={n.id}
            layout
            role="status"
            initial={{ opacity: 0, y: -16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12, transition: { duration: 0.16 } }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="pointer-events-auto w-full flex items-start gap-3 p-3 rounded-2xl cursor-pointer"
            style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-3)', color: 'var(--text)' }}
            onClick={() => open(n)}
          >
            <span className="tile tile-sm tile-accent flex-shrink-0"><Bell /></span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold leading-snug">{n.title}</p>
              {n.body && <p className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-muted)' }}>{n.body}</p>}
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); dismiss(n.id) }}
              className="p-1 rounded-md transition-colors hover:bg-ink/5"
              style={{ color: 'var(--text-faint)' }}
              aria-label="Dismiss notification"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  )
}

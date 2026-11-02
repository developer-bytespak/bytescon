import { useQuery } from '@tanstack/react-query'
import { notificationsApi } from '../services/api'

interface UnreadItem {
  id: string
  title: string
  body: string | null
  linkPath: string | null
}

export const POLL_MS = 20_000

// Shared unread poll for the header bell badge. Keyed under ['notifications']
// so the Notifications page's invalidations (mark read, archive) refresh it too.
// Notifications are listed only on the Notifications page — no on-screen popups.
export function useUnreadNotifications() {
  return useQuery<{ data: { items: UnreadItem[]; unreadCount: number } }>({
    queryKey: ['notifications', 'unread-poll'],
    queryFn: () => notificationsApi.list({ unread: 'true', limit: 10 }),
    refetchInterval: POLL_MS,
    staleTime: POLL_MS / 2,
    // The app default turns focus refetch off; the badge must not sit stale for
    // up to 20s after the user comes back to the tab.
    refetchOnWindowFocus: true,
  })
}

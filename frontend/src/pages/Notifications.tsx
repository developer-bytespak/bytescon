import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { notificationsApi } from '../services/api'
import { useToast } from '../components/Toast'
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui'
import { Bell, Check } from 'lucide-react'

interface Notification { id: string; type: string; title: string; body: string | null; linkPath: string | null; isRead: boolean; createdAt: string }
interface Resp { data: { items: Notification[]; total: number; unreadCount: number } }

export function NotificationsPage() {
  const qc = useQueryClient()
  const { toast } = useToast()
  const [showArchived, setShowArchived] = useState(false)
  const q = useQuery<Resp>({ queryKey: ['notifications', showArchived], queryFn: () => notificationsApi.list({ limit: 100, includeArchived: showArchived || undefined }) })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['notifications'] })
  const markRead = useMutation({ mutationFn: (id: string) => notificationsApi.markRead(id), onSuccess: invalidate })
  const markUnread = useMutation({ mutationFn: (id: string) => notificationsApi.markUnread(id), onSuccess: invalidate })
  const markAll = useMutation({ mutationFn: () => notificationsApi.markAllRead(), onSuccess: () => { invalidate(); toast('All caught up', 'success') } })
  const archive = useMutation({ mutationFn: (id: string) => notificationsApi.archive(id), onSuccess: invalidate })
  const restore = useMutation({ mutationFn: (id: string) => notificationsApi.restore(id), onSuccess: invalidate })

  const items = q.data?.data.items ?? []
  const unread = q.data?.data.unreadCount ?? 0

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader title="Notifications" subtitle={unread > 0 ? `${unread} unread` : 'All caught up'}>
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer mr-1"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        {unread > 0 && <button onClick={() => markAll.mutate()} disabled={markAll.isPending} className="btn-secondary text-xs flex items-center gap-1 disabled:opacity-60"><Check className="w-3.5 h-3.5" /> Mark all read</button>}
      </PageHeader>

      {q.isLoading ? (
        <div className="flex justify-center mt-12"><Spinner size="lg" /></div>
      ) : q.error ? (
        <ErrorBanner message="Could not load notifications. Please retry." />
      ) : items.length === 0 ? (
        <EmptyState message="No notifications yet." />
      ) : (
        <ul className="space-y-2">
          {items.map((n) => {
            const inner = (
              <div className={`card flex items-start gap-3 ${n.isRead ? 'opacity-60' : ''}`}>
                <Bell className={`w-4 h-4 mt-0.5 flex-shrink-0 ${n.isRead ? 'text-gray-600' : 'text-blue-400'}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200">{n.title}</p>
                  {n.body && <p className="text-xs text-gray-500 truncate">{n.body}</p>}
                  <p className="text-[10px] text-gray-600 mt-0.5">{new Date(n.createdAt).toLocaleString()}</p>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  {(n as any).isArchived ? (
                    <button onClick={(e) => { e.preventDefault(); restore.mutate(n.id) }} className="text-[11px] text-gray-500 hover:text-green-400">Restore</button>
                  ) : (
                    <>
                      <button onClick={(e) => { e.preventDefault(); (n.isRead ? markUnread : markRead).mutate(n.id) }} className="text-[11px] text-gray-500 hover:text-gray-300">{n.isRead ? 'Mark unread' : 'Mark read'}</button>
                      <button onClick={(e) => { e.preventDefault(); archive.mutate(n.id) }} className="text-[11px] text-gray-600 hover:text-red-400">Archive</button>
                    </>
                  )}
                </div>
              </div>
            )
            return <li key={n.id}>{n.linkPath ? <Link to={n.linkPath} onClick={() => !n.isRead && markRead.mutate(n.id)}>{inner}</Link> : inner}</li>
          })}
        </ul>
      )}
    </div>
  )
}

export default NotificationsPage

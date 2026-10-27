import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { notificationsApi } from '../services/api'
import { useToast } from '../components/Toast'
import { PageHeader, SkeletonRows, EmptyState, ErrorBanner } from '../components/ui'
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
        <label className="flex items-center gap-1.5 text-xs text-gray-500 cursor-pointer select-none mr-1"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        {unread > 0 && <button onClick={() => markAll.mutate()} disabled={markAll.isPending} className="btn-secondary text-xs flex items-center gap-1 disabled:opacity-60"><Check className="w-3.5 h-3.5" /> Mark all read</button>}
      </PageHeader>

      {q.isLoading ? (
        <div className="card !p-0"><span className="sr-only">Loading…</span><SkeletonRows rows={6} cols={2} /></div>
      ) : q.error ? (
        <ErrorBanner message="Could not load notifications. Please retry." />
      ) : items.length === 0 ? (
        <div className="card"><EmptyState message="No notifications yet." icon={<Bell />} /></div>
      ) : (
        <ul className="stagger space-y-2">
          {items.map((n) => {
            const inner = (
              <div
                className={`${n.linkPath ? 'card-interactive' : 'card'} !py-3.5 flex items-start gap-3`}
                style={n.isRead ? { background: 'var(--surface-2)', boxShadow: 'none' } : { borderColor: 'var(--accent-line)' }}
              >
                <span className={`tile tile-sm ${n.isRead ? 'tile-neutral' : 'tile-accent'} flex-shrink-0`}>
                  <Bell className="w-4 h-4" />
                </span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    {!n.isRead && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: 'var(--accent)' }} aria-hidden="true" />}
                    <p className={`text-sm min-w-0 break-words ${n.isRead ? 'text-gray-400 font-normal' : 'text-gray-100 font-semibold'}`}>{n.title}</p>
                  </div>
                  {n.body && <p className={`text-xs truncate mt-0.5 ${n.isRead ? 'text-gray-600' : 'text-gray-500'}`}>{n.body}</p>}
                  <p className="text-[11px] text-gray-600 mt-1 tabular-nums">{new Date(n.createdAt).toLocaleString()}</p>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  {(n as any).isArchived ? (
                    <button onClick={(e) => { e.preventDefault(); restore.mutate(n.id) }} className="btn-ghost btn-sm text-[11px] text-gray-500 hover:text-green-400">Restore</button>
                  ) : (
                    <>
                      <button onClick={(e) => { e.preventDefault(); (n.isRead ? markUnread : markRead).mutate(n.id) }} className="btn-ghost btn-sm text-[11px] text-gray-500 hover:text-gray-300">{n.isRead ? 'Mark unread' : 'Mark read'}</button>
                      <button onClick={(e) => { e.preventDefault(); archive.mutate(n.id) }} className="btn-ghost btn-sm text-[11px] text-gray-600 hover:text-red-400">Archive</button>
                    </>
                  )}
                </div>
              </div>
            )
            return <li key={n.id}>{n.linkPath ? <Link to={n.linkPath} onClick={() => !n.isRead && markRead.mutate(n.id)} className="block rounded-[14px]">{inner}</Link> : inner}</li>
          })}
        </ul>
      )}
    </div>
  )
}

export default NotificationsPage

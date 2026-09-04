import { useState, useEffect, useMemo } from 'react'
import { MessageSquare, Send, Loader, Reply, Trash2, CheckCircle2, Circle, User as UserIcon, Briefcase } from 'lucide-react'
import axios from 'axios'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

type AuthorType = 'CONSULTANT' | 'CLIENT'

interface Comment {
  id: string
  deliverableId: string
  authorType: AuthorType
  authorId: string
  authorName: string
  body: string
  parentId: string | null
  isResolved: boolean
  createdAt: string
  updatedAt: string
}

interface CommentNode extends Comment {
  replies: CommentNode[]
}

interface Props {
  deliverableId: string
  // Token comes from caller — supports both consultant and client auth contexts
  authToken: string
  // Identity check for delete button visibility
  currentAuthorId: string
  currentAuthorType: AuthorType
  brandingColor?: string
}

// Exported for unit tests
export function buildTree(flat: Comment[]): CommentNode[] {
  const byId = new Map<string, CommentNode>()
  flat.forEach(c => byId.set(c.id, { ...c, replies: [] }))
  const roots: CommentNode[] = []
  byId.forEach(node => {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.replies.push(node)
    } else {
      roots.push(node)
    }
  })
  return roots
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMin = Math.floor(diffMs / 60000)
  const diffHr = Math.floor(diffMin / 60)
  const diffDay = Math.floor(diffHr / 24)
  if (diffMin < 1) return 'just now'
  if (diffMin < 60) return `${diffMin}m ago`
  if (diffHr < 24) return `${diffHr}h ago`
  if (diffDay < 7) return `${diffDay}d ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

export function DeliverableThread({
  deliverableId,
  authToken,
  currentAuthorId,
  currentAuthorType,
  brandingColor = '#7b8fff',
}: Props) {
  const [comments, setComments] = useState<Comment[]>([])
  const [loading, setLoading] = useState(true)
  const [posting, setPosting] = useState(false)
  const [error, setError] = useState('')
  const [newBody, setNewBody] = useState('')
  const [replyingTo, setReplyingTo] = useState<string | null>(null)
  const [replyBody, setReplyBody] = useState('')

  const headers = { Authorization: `Bearer ${authToken}` }
  const tree = useMemo(() => buildTree(comments), [comments])

  const load = async () => {
    try {
      setLoading(true)
      const res = await axios.get(`${API_BASE}/api/client-deliverables/${deliverableId}/comments`, { headers })
      setComments(res.data.data?.comments || [])
      setError('')
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load comments')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [deliverableId])

  const post = async (body: string, parentId: string | null) => {
    if (!body.trim()) return
    setPosting(true)
    setError('')
    try {
      await axios.post(
        `${API_BASE}/api/client-deliverables/${deliverableId}/comments`,
        { body: body.trim(), parentId: parentId ?? undefined },
        { headers }
      )
      if (parentId) {
        setReplyingTo(null)
        setReplyBody('')
      } else {
        setNewBody('')
      }
      await load()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to post comment')
    } finally {
      setPosting(false)
    }
  }

  const toggleResolve = async (commentId: string, current: boolean) => {
    try {
      await axios.patch(
        `${API_BASE}/api/client-deliverables/${deliverableId}/comments/${commentId}/resolve`,
        { isResolved: !current },
        { headers }
      )
      await load()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to update')
    }
  }

  const deleteComment = async (commentId: string) => {
    if (!confirm('Delete this comment? Replies will also be removed.')) return
    try {
      await axios.delete(`${API_BASE}/api/client-deliverables/${deliverableId}/comments/${commentId}`, { headers })
      await load()
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to delete')
    }
  }

  const renderComment = (c: CommentNode, depth: number = 0): JSX.Element => {
    const isOwn = c.authorId === currentAuthorId && c.authorType === currentAuthorType
    const Icon = c.authorType === 'CONSULTANT' ? Briefcase : UserIcon
    return (
      <div key={c.id} className="space-y-2">
        <div
          className="rounded-lg p-3 border"
          style={{
            background: c.isResolved ? 'rgba(34,197,94,0.05)' : 'rgba(19,19,24,0.4)',
            borderColor: c.isResolved ? 'rgba(34,197,94,0.3)' : 'rgba(31,41,55,0.6)',
            marginLeft: `${Math.min(depth, 4) * 16}px`,
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <div
                className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0"
                style={{
                  background: c.authorType === 'CONSULTANT'
                    ? `${brandingColor}33`
                    : 'rgba(59,130,246,0.2)',
                }}
              >
                <Icon
                  className="w-3 h-3"
                  style={{ color: c.authorType === 'CONSULTANT' ? brandingColor : '#60a5fa' }}
                />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="text-sm font-medium text-gray-200">{c.authorName}</p>
                  <span
                    className="text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider"
                    style={{
                      background: c.authorType === 'CONSULTANT' ? `${brandingColor}26` : 'rgba(59,130,246,0.2)',
                      color: c.authorType === 'CONSULTANT' ? brandingColor : '#60a5fa',
                    }}
                  >
                    {c.authorType}
                  </span>
                  <span className="text-xs text-gray-500">{fmtTime(c.createdAt)}</span>
                  {c.isResolved && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-900/40 text-green-300 border border-green-700 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3" /> Resolved
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {!c.parentId && (
                <button
                  onClick={() => toggleResolve(c.id, c.isResolved)}
                  className="text-gray-500 hover:text-green-400 p-1 rounded transition-colors"
                  title={c.isResolved ? 'Mark unresolved' : 'Mark resolved'}
                >
                  {c.isResolved ? <CheckCircle2 className="w-4 h-4 text-green-400" /> : <Circle className="w-4 h-4" />}
                </button>
              )}
              {isOwn && (
                <button
                  onClick={() => deleteComment(c.id)}
                  className="text-gray-500 hover:text-red-400 p-1 rounded transition-colors"
                  title="Delete comment"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
          <p className="text-sm text-gray-300 mt-2 whitespace-pre-wrap break-words">{c.body}</p>
          <div className="mt-2">
            {replyingTo === c.id ? (
              <div className="space-y-2">
                <textarea
                  value={replyBody}
                  onChange={(e) => setReplyBody(e.target.value)}
                  placeholder="Write a reply..."
                  rows={2}
                  className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200 outline-none resize-none focus:border-gray-600"
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setReplyingTo(null); setReplyBody('') }}
                    className="text-xs text-gray-500 hover:text-gray-300 px-2 py-1"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => post(replyBody, c.id)}
                    disabled={!replyBody.trim() || posting}
                    className="text-xs px-3 py-1 rounded transition-colors disabled:opacity-50 flex items-center gap-1.5"
                    style={{ background: brandingColor, color: '#0b0f1a' }}
                  >
                    {posting ? <Loader className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    Reply
                  </button>
                </div>
              </div>
            ) : (
              !c.parentId && (
                <button
                  onClick={() => setReplyingTo(c.id)}
                  className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors"
                >
                  <Reply className="w-3 h-3" /> Reply
                </button>
              )
            )}
          </div>
        </div>
        {c.replies.length > 0 && (
          <div className="space-y-2">
            {c.replies.map(r => renderComment(r, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <MessageSquare className="w-4 h-4" style={{ color: brandingColor }} />
        <h3 className="text-sm font-semibold text-gray-200">
          Discussion
          {comments.length > 0 && (
            <span className="text-xs text-gray-500 font-normal ml-1">
              ({comments.length} comment{comments.length === 1 ? '' : 's'})
            </span>
          )}
        </h3>
      </div>

      {error && (
        <div className="bg-red-950/30 border border-red-800 rounded p-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader className="w-4 h-4 animate-spin text-gray-500" />
        </div>
      ) : tree.length === 0 ? (
        <p className="text-xs text-gray-500 text-center py-4">
          No comments yet. Start the discussion below.
        </p>
      ) : (
        <div className="space-y-2">
          {tree.map(c => renderComment(c, 0))}
        </div>
      )}

      {/* New comment form */}
      <div className="border-t border-gray-800 pt-3 space-y-2">
        <textarea
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
          placeholder="Add a comment to the discussion..."
          rows={2}
          maxLength={5000}
          className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none resize-none focus:border-gray-600"
        />
        <div className="flex justify-between items-center">
          <span className="text-xs text-gray-600">{newBody.length}/5000</span>
          <button
            onClick={() => post(newBody, null)}
            disabled={!newBody.trim() || posting}
            className="text-sm px-4 py-1.5 rounded font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
            style={{ background: brandingColor, color: '#0b0f1a' }}
          >
            {posting ? <Loader className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Post Comment
          </button>
        </div>
      </div>
    </div>
  )
}

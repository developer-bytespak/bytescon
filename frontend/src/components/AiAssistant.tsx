import { useState, useRef, useEffect } from 'react'
import { MessageCircle, Send, Loader, Minimize2 } from 'lucide-react'
import { assistantApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

const GREETING = `Hello. I'm the Bytesgov AI assistant. I can help you navigate the platform, understand your scores, set up clients, and more. What can I help you with?`

const QUICK_ACTIONS = [
  'How do I add a client?',
  'Why is my client scoring 0%?',
  'How do I sync from SAM.gov?',
  'Explain win probability scoring',
]

export function AiAssistant() {
  const { isAuthenticated } = useAuth()
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: GREETING },
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])

  // Don't render if not logged in (must come AFTER all hooks — React Rules of Hooks)
  if (!isAuthenticated) return null

  const sendMessage = async (text?: string) => {
    const msg = (text || input).trim()
    if (!msg || loading) return

    setInput('')
    setError('')
    const userMsg: Message = { role: 'user', content: msg }
    const updatedMessages = [...messages, userMsg]
    setMessages(updatedMessages)
    setLoading(true)

    try {
      // Send last 10 messages as history (excluding the greeting)
      const history = updatedMessages
        .slice(1) // skip greeting
        .slice(-10)
        .map(m => ({ role: m.role, content: m.content }))

      const res = await assistantApi.chat(msg, history.slice(0, -1)) // exclude current message from history
      setMessages(prev => [...prev, { role: 'assistant', content: res.data.reply }])
    } catch (err: any) {
      const errMsg = err?.response?.data?.error || 'Failed to get response. Please try again.'
      setError(errMsg)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  return (
    <>
      {/* Floating button */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          className="ai-fab fixed bottom-5 right-5 sm:bottom-6 sm:right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center transition-colors"
          aria-label="Open Bytesgov AI assistant"
          title="Bytesgov AI"
        >
          <MessageCircle className="w-6 h-6" />
        </button>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div
          role="dialog"
          aria-label="Bytesgov AI"
          className="ai-panel fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 flex flex-col overflow-hidden"
          style={{
            width: 'min(380px, calc(100vw - 2rem))',
            height: 'min(540px, calc(100vh - 2rem))',
            background: 'var(--surface)',
            borderRadius: 24,
            boxShadow: 'var(--shadow-3)',
          }}
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-5 pt-5 pb-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
            <span aria-hidden="true" style={{ fontSize: 20, lineHeight: 1, fontWeight: 800, letterSpacing: '-0.06em', color: 'var(--text)' }}>
              B<i style={{ display: 'inline-block', width: 5, height: 5, borderRadius: 999, background: 'var(--v3-blue)', marginLeft: 1 }} />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-semibold" style={{ color: 'var(--text)' }}>Bytesgov AI</p>
              <p className="text-[12px]" style={{ color: 'var(--text-muted)' }}>Platform assistant</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="btn-ghost btn-sm !px-2"
              aria-label="Minimize assistant"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : ''}`}>
                <div
                  className="max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed"
                  style={msg.role === 'assistant'
                    ? { background: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--text-2)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
                    : { background: 'var(--v3-dark)', color: 'var(--v3-canvas)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                  data-role={msg.role}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {/* Loading indicator */}
            {loading && (
              <div className="flex">
                <div className="rounded-2xl px-3.5 py-2.5 flex items-center gap-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
                  <Loader className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-muted)' }} />
                  <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Thinking...</span>
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-[13px] px-1" style={{ color: 'var(--danger-text)' }}>{error}</p>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick actions (only show on first message) */}
          {messages.length === 1 && !loading && (
            <div className="px-4 pb-3 flex flex-wrap gap-1.5">
              {QUICK_ACTIONS.map(q => (
                <button key={q} onClick={() => sendMessage(q)} className="v3-tag hover:!border-[color:var(--text)]">
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="flex-shrink-0 px-3 py-3 flex items-center gap-2" style={{ borderTop: '1px solid var(--line)' }}>
            <input
              ref={inputRef}
              type="text"
              className="input flex-1 !rounded-full"
              placeholder="Ask anything about the platform..."
              aria-label="Message Bytesgov AI"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || loading}
              aria-label="Send message"
              className="btn-primary !w-10 !h-10 !min-h-0 !p-0 !rounded-full flex items-center justify-center flex-shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

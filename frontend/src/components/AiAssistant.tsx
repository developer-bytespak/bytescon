import { useState, useRef, useEffect } from 'react'
import { MessageCircle, X, Send, Loader, Bot, User, Minimize2 } from 'lucide-react'
import { assistantApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../hooks/useBranding'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

function BrandMarkMini({ color }: { color: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill={color} />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill={color} opacity="0.5" />
    </svg>
  )
}

const GREETING = `Hey! I'm the Bytescon AI assistant. I can help you navigate the platform, understand your scores, set up clients, and more. What can I help you with?`

const QUICK_ACTIONS = [
  'How do I add a client?',
  'Why is my client scoring 0%?',
  'How do I sync from SAM.gov?',
  'Explain win probability scoring',
]

export function AiAssistant() {
  const { isAuthenticated, firm } = useAuth()
  const { branding } = useBranding(firm?.id)
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
          className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full flex items-center justify-center shadow-2xl transition-all hover:scale-110 active:scale-95"
          style={{
            background: `linear-gradient(135deg, ${branding.primaryColor} 0%, ${branding.secondaryColor} 100%)`,
            boxShadow: `0 4px 24px ${branding.secondaryColor}66`,
          }}
        >
          <MessageCircle className="w-6 h-6 text-gray-900" />
        </button>
      )}

      {/* Chat panel */}
      {isOpen && (
        <div
          className="fixed bottom-6 right-6 z-50 flex flex-col rounded-2xl overflow-hidden shadow-2xl"
          style={{
            width: '380px',
            height: '520px',
            background: '#0a1628',
            border: '1px solid rgba(91,116,255,0.2)',
            boxShadow: '0 8px 40px rgba(0,0,0,0.5), 0 0 60px rgba(91,116,255,0.08)',
          }}
        >
          {/* Header */}
          <div
            className="flex items-center gap-3 px-4 py-3 flex-shrink-0"
            style={{
              background: 'linear-gradient(135deg, rgba(91,116,255,0.12) 0%, rgba(91,116,255,0.04) 100%)',
              borderBottom: '1px solid rgba(91,116,255,0.15)',
            }}
          >
            <div className="w-8 h-8 rounded-full flex items-center justify-center"
              style={{ background: 'rgba(91,116,255,0.15)', border: '1px solid rgba(91,116,255,0.3)' }}>
              <BrandMarkMini color={branding.secondaryColor} />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-cyan-300">Bytescon AI</p>
              <p className="text-[10px] text-gray-500">Platform Assistant</p>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-gray-300 hover:bg-gray-800 transition-colors"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3" style={{ scrollbarWidth: 'thin' }}>
            {messages.map((msg, i) => (
              <div key={i} className={`flex gap-2 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}>
                {/* Avatar */}
                <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${
                  msg.role === 'assistant'
                    ? 'bg-amber-900/30 border border-amber-700/40'
                    : 'bg-blue-900/30 border border-blue-700/40'
                }`}>
                  {msg.role === 'assistant'
                    ? <Bot className="w-3.5 h-3.5 text-cyan-400" />
                    : <User className="w-3.5 h-3.5 text-blue-400" />
                  }
                </div>
                {/* Bubble */}
                <div
                  className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                    msg.role === 'assistant'
                      ? 'bg-gray-800/60 text-gray-300 border border-gray-700/40'
                      : 'bg-amber-900/20 text-amber-100 border border-amber-700/30'
                  }`}
                  style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                >
                  {msg.content}
                </div>
              </div>
            ))}

            {/* Loading indicator */}
            {loading && (
              <div className="flex gap-2">
                <div className="w-6 h-6 rounded-full bg-amber-900/30 border border-amber-700/40 flex items-center justify-center flex-shrink-0">
                  <Bot className="w-3.5 h-3.5 text-cyan-400" />
                </div>
                <div className="bg-gray-800/60 border border-gray-700/40 rounded-xl px-3 py-2 flex items-center gap-1.5">
                  <Loader className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
                  <span className="text-xs text-gray-500">Thinking...</span>
                </div>
              </div>
            )}

            {error && (
              <p className="text-xs text-red-400 px-2">{error}</p>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Quick actions (only show on first message) */}
          {messages.length === 1 && !loading && (
            <div className="px-4 pb-2 flex flex-wrap gap-1.5">
              {QUICK_ACTIONS.map(q => (
                <button
                  key={q}
                  onClick={() => sendMessage(q)}
                  className="text-[10px] px-2.5 py-1 rounded-full bg-gray-800/60 border border-gray-700/50 text-gray-400 hover:border-amber-700/40 hover:text-cyan-300 transition-colors"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div
            className="flex-shrink-0 px-3 py-3 flex items-center gap-2"
            style={{ borderTop: '1px solid rgba(91,116,255,0.1)' }}
          >
            <input
              ref={inputRef}
              type="text"
              className="flex-1 bg-gray-800/60 border border-gray-700/50 rounded-xl px-3.5 py-2 text-sm text-gray-200 placeholder-gray-600 focus:outline-none focus:border-amber-700/50 transition-colors"
              placeholder="Ask anything about the platform..."
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={loading}
            />
            <button
              onClick={() => sendMessage()}
              disabled={!input.trim() || loading}
              className="w-9 h-9 rounded-xl flex items-center justify-center transition-all disabled:opacity-30"
              style={{
                background: input.trim() ? `linear-gradient(135deg, ${branding.primaryColor}, ${branding.secondaryColor})` : 'transparent',
                border: input.trim() ? 'none' : '1px solid rgba(107,114,128,0.3)',
              }}
            >
              <Send className={`w-4 h-4 ${input.trim() ? 'text-gray-900' : 'text-gray-600'}`} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}

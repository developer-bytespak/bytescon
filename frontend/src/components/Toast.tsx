import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, XCircle, AlertTriangle, Info, X, ArrowRight } from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'

type ToastType = 'success' | 'error' | 'warning' | 'info'

/** Optional extras: a second line, and a link to where the next step is done. */
export interface ToastOptions {
  detail?: string
  action?: { label: string; to: string }
}

interface Toast extends ToastOptions {
  id: string
  message: string
  type: ToastType
}

interface ToastContextType {
  toast: (message: string, type?: ToastType, options?: ToastOptions) => void
}

const ToastContext = createContext<ToastContextType>({ toast: () => {} })

export function useToast() {
  return useContext(ToastContext)
}

const icons: Record<ToastType, any> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
}

// Neutral surface + a tinted icon tile per type, so toasts read the same in
// light and dark mode.
const tones: Record<ToastType, string> = {
  success: 'tile-success',
  error: 'tile-danger',
  warning: 'tile-gold',
  info: 'tile-accent',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((message: string, type: ToastType = 'info', options: ToastOptions = {}) => {
    const id = Math.random().toString(36).substring(2)
    setToasts((prev) => [...prev, { id, message, type, ...options }])
    // A toast with a next step stays long enough to read and click.
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, options.detail || options.action ? 12000 : 5000)
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}

      {/* Toast Container */}
      <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-[120] flex flex-col items-end gap-2 sm:max-w-sm pointer-events-none" aria-live="polite">
        <AnimatePresence initial={false}>
          {toasts.map((t) => {
            const Icon = icons[t.type]
            return (
              <motion.div
                key={t.id}
                layout
                role={t.type === 'error' ? 'alert' : 'status'}
                initial={{ opacity: 0, x: 32, scale: 0.98 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 32, transition: { duration: 0.16 } }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-auto w-full flex items-start gap-3 pl-3 pr-2 py-3 rounded-xl"
                style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-3)', color: 'var(--text)' }}
              >
                <span className={`tile tile-sm ${tones[t.type]}`}><Icon /></span>
                <div className="flex-1 pt-1 min-w-0">
                  <p className="text-sm">{t.message}</p>
                  {t.detail && <p className="text-xs mt-1" style={{ color: 'var(--text-2)' }}>{t.detail}</p>}
                  {t.action && (
                    <Link to={t.action.to} onClick={() => removeToast(t.id)} className="inline-flex items-center gap-1 text-xs font-medium mt-1.5" style={{ color: 'var(--accent)' }}>
                      {t.action.label} <ArrowRight className="w-3 h-3" aria-hidden="true" />
                    </Link>
                  )}
                </div>
                <button
                  onClick={() => removeToast(t.id)}
                  className="p-1 rounded-md transition-colors hover:bg-ink/5"
                  style={{ color: 'var(--text-faint)' }}
                  aria-label="Dismiss notification"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  )
}

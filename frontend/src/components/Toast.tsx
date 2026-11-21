import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'
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

// White floating surface + a small icon coloured by state (green, red, amber);
// information stays neutral. Reads the same in light and dark mode.
const tones: Record<ToastType, { background: string; color: string }> = {
  success: { background: 'var(--success-bg)', color: 'var(--success)' },
  error: { background: 'var(--danger-bg)', color: 'var(--danger)' },
  warning: { background: 'var(--warning-bg)', color: 'var(--warning)' },
  info: { background: 'var(--surface-3)', color: 'var(--text-2)' },
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
                className="pointer-events-auto w-full flex items-start gap-3 pl-3.5 pr-2 py-3.5 rounded-2xl"
                style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-3)', color: 'var(--text)' }}
              >
                <span className="grid place-items-center w-8 h-8 rounded-full flex-shrink-0" style={tones[t.type]} aria-hidden="true"><Icon className="w-4 h-4" /></span>
                <div className="flex-1 pt-1.5 min-w-0">
                  <p className="text-sm font-medium">{t.message}</p>
                  {t.detail && <p className="text-[13px] mt-1" style={{ color: 'var(--text-muted)' }}>{t.detail}</p>}
                  {t.action && (
                    <Link to={t.action.to} onClick={() => removeToast(t.id)} className="inline-flex items-center gap-1 text-[13px] font-semibold underline underline-offset-2 mt-2" style={{ color: 'var(--text)' }}>
                      {t.action.label}
                    </Link>
                  )}
                </div>
                <button
                  onClick={() => removeToast(t.id)}
                  className="p-1.5 rounded-full transition-colors hover:bg-ink/5"
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

import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface Toast {
  id: string
  message: string
  type: ToastType
}

interface ToastContextType {
  toast: (message: string, type?: ToastType) => void
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

const styles: Record<ToastType, string> = {
  success: 'bg-green-900/90 border-green-700 text-green-200',
  error: 'bg-red-900/90 border-red-700 text-red-200',
  warning: 'bg-yellow-900/90 border-yellow-700 text-yellow-200',
  info: 'bg-blue-900/90 border-blue-700 text-blue-200',
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const addToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = Math.random().toString(36).substring(2)
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, 5000)
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ toast: addToast }}>
      {children}

      {/* Toast Container */}
      <div className="fixed bottom-4 right-4 z-50 space-y-2 max-w-sm">
        {toasts.map((t) => {
          const Icon = icons[t.type]
          return (
            <div
              key={t.id}
              className={`flex items-start gap-2 px-4 py-3 rounded-lg border shadow-lg animate-slide-in ${styles[t.type]}`}
            >
              <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p className="text-sm flex-1">{t.message}</p>
              <button
                onClick={() => removeToast(t.id)}
                className="p-0.5 hover:opacity-70"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

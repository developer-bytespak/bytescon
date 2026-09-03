import { useEffect, useState } from 'react'
import { AlertTriangle, Loader, X } from 'lucide-react'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../hooks/useBranding'

interface Props {
  open: boolean
  variant: 'archive' | 'delete'
  entityType: string
  entityName: string
  onConfirm: () => void | Promise<void>
  onCancel: () => void
  loading?: boolean
  error?: string | null
  // Optional copy overrides for non-archive semantics (e.g. "Close", "Void").
  title?: string
  confirmLabel?: string
  body?: string
}

/**
 * Standard destructive-action confirmation modal (F4 shared primitive).
 * - 'archive': title "Archive [entityType]?", Cancel + Archive.
 * - 'delete':  requires typing the exact entity name, then a red
 *              "Delete permanently" button. Used only where hard-delete is
 *              explicitly permitted.
 */
export function ConfirmModal({
  open,
  variant,
  entityType,
  entityName,
  onConfirm,
  onCancel,
  loading = false,
  error,
  title,
  confirmLabel,
  body,
}: Props) {
  const { firm } = useAuth()
  const { branding } = useBranding(firm?.id)
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!open) setTyped('')
  }, [open])

  if (!open) return null

  const isDelete = variant === 'delete'
  const typedMatches = typed.trim() === entityName.trim()
  const canConfirm = !loading && (!isDelete || typedMatches)
  const heading = title ?? (isDelete ? `Delete ${entityType} permanently?` : `Archive ${entityType}?`)
  const cta = confirmLabel ?? (isDelete ? 'Delete permanently' : 'Archive')

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)' }}
      onClick={loading ? undefined : onCancel}
    >
      <div
        className="rounded-xl p-6 w-full max-w-md space-y-4 bg-gray-900 border border-gray-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className="p-2.5 rounded-lg"
              style={{
                background: isDelete ? 'rgba(220,38,38,0.10)' : `${branding.secondaryColor}1a`,
                border: isDelete ? '1px solid rgba(220,38,38,0.3)' : `1px solid ${branding.secondaryColor}40`,
              }}
            >
              <AlertTriangle className="w-5 h-5" style={{ color: isDelete ? '#f87171' : branding.secondaryColor }} />
            </div>
            <h2 className="text-lg font-semibold text-gray-100">{heading}</h2>
          </div>
          <button onClick={onCancel} disabled={loading} className="text-gray-500 hover:text-gray-300 disabled:opacity-50">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-gray-400">
          {body ?? (
            <>
              {isDelete ? 'This permanently deletes ' : 'This archives '}
              <span className="text-gray-100 font-medium">{entityName}</span>
              {isDelete ? '. This cannot be undone.' : '. You can restore it later from “Show archived”.'}
            </>
          )}
        </p>

        {isDelete && (
          <div className="space-y-1.5">
            <label className="text-xs text-gray-500">
              Type <span className="font-mono text-gray-300">{entityName}</span> to confirm
            </label>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-red-500"
              placeholder={entityName}
            />
          </div>
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            onClick={onCancel}
            disabled={loading}
            className="bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 text-sm px-4 py-2 rounded-lg disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
            className={`text-sm px-4 py-2 rounded-lg border flex items-center gap-2 disabled:opacity-40 transition-colors ${
              isDelete
                ? 'bg-red-900/40 hover:bg-red-900/60 text-red-200 border-red-700'
                : 'bg-amber-900/30 hover:bg-amber-900/50 text-amber-200 border-amber-700'
            }`}
          >
            {loading && <Loader className="w-4 h-4 animate-spin" />}
            {cta}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ConfirmModal

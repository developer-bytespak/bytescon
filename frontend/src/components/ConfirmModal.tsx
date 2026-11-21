import { useEffect, useState } from 'react'
import { AlertTriangle, Loader, X } from 'lucide-react'

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
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(17,17,17,0.4)' }}
      onClick={loading ? undefined : onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        className="modal-panel p-7 w-full max-w-md space-y-5"
        style={{ background: 'var(--surface)', boxShadow: 'var(--shadow-3)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <span
              className="grid place-items-center w-10 h-10 rounded-full flex-shrink-0"
              style={isDelete ? { background: 'var(--danger-bg)', color: 'var(--danger)' } : { background: 'var(--surface-3)', color: 'var(--text-2)' }}
              aria-hidden="true"
            >
              <AlertTriangle className="w-5 h-5" />
            </span>
            <h2 id="confirm-modal-title" className="text-[20px] leading-[28px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--text)' }}>{heading}</h2>
          </div>
          <button onClick={onCancel} disabled={loading} aria-label="Close" className="btn-ghost btn-sm !px-2 flex-shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-[15px] leading-[22px]" style={{ color: 'var(--text-muted)' }}>
          {body ?? (
            <>
              {isDelete ? 'This permanently deletes ' : 'This archives '}
              <span className="font-semibold" style={{ color: 'var(--text)' }}>{entityName}</span>
              {isDelete ? '. This cannot be undone.' : '. You can restore it later from “Show archived”.'}
            </>
          )}
        </p>

        {isDelete && (
          <div className="space-y-1.5">
            <label className="label" htmlFor="confirm-modal-typed">
              Type <span className="font-semibold" style={{ color: 'var(--text)' }}>{entityName}</span> to confirm
            </label>
            <input
              id="confirm-modal-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="input w-full"
              placeholder={entityName}
            />
          </div>
        )}

        {error && <p role="alert" className="text-sm" style={{ color: 'var(--danger-text)' }}>{error}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <button onClick={onCancel} disabled={loading} className="btn-secondary">
            Cancel
          </button>
          <button
            onClick={() => void onConfirm()}
            disabled={!canConfirm}
            className={`${isDelete ? 'btn-danger' : 'btn-primary'} flex items-center gap-2`}
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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader, Search, X } from 'lucide-react'

export interface SearchOption {
  id: string
  label: string
  hint?: string | null
}

interface Props {
  value: string
  onChange: (id: string) => void
  /** Server-side search. Called with the trimmed term; must be cancellable-safe. */
  search: (term: string) => Promise<SearchOption[]>
  /** Resolves the label for an already-selected id (e.g. on edit). */
  resolve?: (id: string) => Promise<SearchOption | null>
  placeholder?: string
  label?: string
  emptyMessage?: string
  disabled?: boolean
}

const DEBOUNCE_MS = 180

/**
 * Type-to-search picker for lists too large to render as a <select>.
 *
 * Searching happens on the SERVER, so a firm with thousands of opportunities
 * never ships them all to the browser to be filtered client-side. Results
 * narrow from the first character.
 *
 * Out-of-order responses are dropped rather than rendered: typing "cy" then
 * "cyber" can resolve in either order, and a slow "cy" landing last would
 * otherwise replace the better list with a staler one.
 */
export function SearchSelect({
  value, onChange, search, resolve,
  placeholder = 'Type to search…',
  label, emptyMessage = 'No matches.', disabled,
}: Props) {
  const [term, setTerm] = useState('')
  const [options, setOptions] = useState<SearchOption[]>([])
  const [selected, setSelected] = useState<SearchOption | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [highlight, setHighlight] = useState(0)

  const boxRef = useRef<HTMLDivElement>(null)
  // Monotonic id so only the newest in-flight search may write results.
  const queryId = useRef(0)

  // Show the label of a value chosen elsewhere (edit form, restored draft).
  useEffect(() => {
    if (!value) { setSelected(null); return }
    if (selected?.id === value) return
    if (!resolve) return
    let alive = true
    void resolve(value).then((opt) => { if (alive && opt) setSelected(opt) }).catch(() => {})
    return () => { alive = false }
  }, [value, resolve, selected?.id])

  useEffect(() => {
    if (!open) return
    const id = ++queryId.current
    setLoading(true)
    const timer = setTimeout(() => {
      void search(term.trim())
        .then((rows) => { if (queryId.current === id) { setOptions(rows); setHighlight(0) } })
        .catch(() => { if (queryId.current === id) setOptions([]) })
        .finally(() => { if (queryId.current === id) setLoading(false) })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [term, open, search])

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open])

  const choose = useCallback((opt: SearchOption) => {
    setSelected(opt)
    onChange(opt.id)
    setOpen(false)
    setTerm('')
  }, [onChange])

  const clear = useCallback(() => {
    setSelected(null)
    onChange('')
    setTerm('')
  }, [onChange])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, options.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)) }
    else if (e.key === 'Enter' && options[highlight]) { e.preventDefault(); choose(options[highlight]) }
    else if (e.key === 'Escape') { setOpen(false) }
  }

  return (
    <div ref={boxRef} className="relative">
      {label && <label className="block text-[11px] text-gray-500 mb-1">{label}</label>}

      {selected && !open ? (
        <div className="flex items-center gap-2 bg-gray-800 border border-gray-700 rounded px-3 py-2">
          <button type="button" disabled={disabled} onClick={() => { setOpen(true); setTerm('') }}
            className="flex-1 min-w-0 text-left">
            <span className="block text-sm text-gray-200 truncate">{selected.label}</span>
            {selected.hint && <span className="block text-[11px] text-gray-500 truncate">{selected.hint}</span>}
          </button>
          <button type="button" onClick={clear} aria-label="Clear selection"
            className="text-gray-500 hover:text-gray-300 flex-shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-gray-600 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="text" role="combobox" aria-expanded={open} aria-label={label ?? placeholder}
            disabled={disabled} value={term} placeholder={placeholder}
            onFocus={() => setOpen(true)}
            onChange={(e) => { setTerm(e.target.value); setOpen(true) }}
            onKeyDown={onKeyDown}
            className="w-full bg-gray-800 border border-gray-700 rounded pl-8 pr-8 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
          />
          {loading && <Loader className="w-3.5 h-3.5 text-gray-500 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />}
        </div>
      )}

      {open && (
        <ul role="listbox"
          className="absolute z-20 mt-1 w-full max-h-64 overflow-y-auto bg-gray-900 border border-gray-700 rounded-lg shadow-xl">
          {options.length === 0 && !loading && (
            <li className="px-3 py-2 text-[12px] text-gray-500">{emptyMessage}</li>
          )}
          {options.map((opt, i) => (
            <li key={opt.id} role="option" aria-selected={i === highlight}>
              <button type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => choose(opt)}
                className={`w-full text-left px-3 py-2 ${i === highlight ? 'bg-gray-800' : ''}`}>
                <span className="block text-sm text-gray-200 truncate">{opt.label}</span>
                {opt.hint && <span className="block text-[11px] text-gray-500 truncate">{opt.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

import { useState, useRef, useEffect } from 'react'
import { clientsApi } from '../services/api'
import { Search, X, Plus } from 'lucide-react'

interface NaicsPickerProps {
  selected: string[]
  onChange: (codes: string[]) => void
  label?: string
}

interface NaicsResult {
  code: string
  description: string | null
}

// Top-level NAICS categories for quick browsing
const CATEGORIES = [
  { prefix: '23', label: 'Construction' },
  { prefix: '33', label: 'Manufacturing' },
  { prefix: '42', label: 'Wholesale Trade' },
  { prefix: '48', label: 'Transportation' },
  { prefix: '51', label: 'Information / IT' },
  { prefix: '52', label: 'Finance & Insurance' },
  { prefix: '54', label: 'Professional Services' },
  { prefix: '56', label: 'Admin & Support' },
  { prefix: '61', label: 'Education' },
  { prefix: '62', label: 'Health Care' },
  { prefix: '81', label: 'Other Services' },
  { prefix: '92', label: 'Public Admin' },
]

export function NaicsPicker({ selected, onChange, label }: NaicsPickerProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<NaicsResult[]>([])
  const [loading, setLoading] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>()
  const containerRef = useRef<HTMLDivElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const doSearch = (q: string) => {
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    clientsApi.searchNaics(q).then((res: any) => {
      setResults(res.data || [])
    }).catch(() => {
      setResults([])
    }).finally(() => setLoading(false))
  }

  const handleInputChange = (val: string) => {
    setQuery(val)
    setShowDropdown(true)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => doSearch(val), 300)
  }

  const handleCategoryClick = (prefix: string) => {
    setQuery(prefix)
    setShowDropdown(true)
    doSearch(prefix)
  }

  const addCode = (code: string) => {
    if (!selected.includes(code)) {
      onChange([...selected, code])
    }
    setQuery('')
    setResults([])
    setShowDropdown(false)
  }

  const removeCode = (code: string) => {
    onChange(selected.filter(c => c !== code))
  }

  return (
    <div ref={containerRef} className="space-y-2">
      {label && <label className="label">{label}</label>}

      {/* Selected codes as chips */}
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {selected.map(code => (
            <span key={code} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-mono bg-amber-900/30 border border-amber-700/40 text-amber-300">
              {code}
              <button type="button" onClick={() => removeCode(code)} className="hover:text-red-400 transition-colors">
                <X className="w-3 h-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
        <input
          type="text"
          className="input pl-9 text-sm"
          placeholder="Search by code (e.g. 541614) or keyword (e.g. consulting)..."
          value={query}
          onChange={(e) => handleInputChange(e.target.value)}
          onFocus={() => { if (query.length >= 2) setShowDropdown(true) }}
        />

        {/* Dropdown results */}
        {showDropdown && (query.length >= 2 || results.length > 0) && (
          <div className="absolute z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 shadow-xl">
            {loading ? (
              <p className="px-3 py-2 text-xs text-gray-500">Searching...</p>
            ) : results.length === 0 ? (
              <>
                <p className="px-3 py-2 text-xs text-gray-500">No match for "{query}" in lookup database</p>
                {/^\d{2,6}$/.test(query.trim()) && !selected.includes(query.trim()) && (
                  <button
                    type="button"
                    onClick={() => addCode(query.trim())}
                    className="w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-gray-800 transition-colors border-t border-gray-800"
                  >
                    <span className="font-mono text-amber-400 text-xs w-16 flex-shrink-0">{query.trim()}</span>
                    <span className="text-gray-400 text-xs flex-1">Add this code anyway</span>
                    <Plus className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  </button>
                )}
              </>
            ) : (
              results.map(r => {
                const isSelected = selected.includes(r.code)
                return (
                  <button
                    key={r.code}
                    type="button"
                    onClick={() => !isSelected && addCode(r.code)}
                    disabled={isSelected}
                    className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm transition-colors border-b border-gray-800 last:border-0 ${
                      isSelected
                        ? 'opacity-40 cursor-not-allowed'
                        : 'hover:bg-gray-800 cursor-pointer'
                    }`}
                  >
                    <span className="font-mono text-amber-400 text-xs w-16 flex-shrink-0">{r.code}</span>
                    <span className="text-gray-300 text-xs truncate flex-1">{r.description || 'No description'}</span>
                    {!isSelected && <Plus className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />}
                  </button>
                )
              })
            )}
          </div>
        )}
      </div>

      {/* Category quick-filters */}
      <div className="flex flex-wrap gap-1.5">
        {CATEGORIES.map(cat => (
          <button
            key={cat.prefix}
            type="button"
            onClick={() => handleCategoryClick(cat.prefix)}
            className="text-[10px] px-2 py-1 rounded-md bg-gray-800/60 border border-gray-700/50 text-gray-400 hover:border-amber-700/40 hover:text-amber-300 transition-colors"
          >
            {cat.prefix} — {cat.label}
          </button>
        ))}
      </div>
    </div>
  )
}

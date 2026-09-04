// =============================================================
// Command palette (Ctrl/Cmd+K) — jump to any page, hub tab, pinned or
// recently viewed opportunity. Lets the sidebar stay short without hiding
// anything.
// =============================================================
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, CornerDownLeft, Star, Clock } from 'lucide-react'
import { paletteEntries, type PaletteEntry } from '../navigation'
import { useAuth } from '../hooks/useAuth'
import { useCanModerate } from '../hooks/useCanModerate'
import { useFavorites } from '../hooks/useFavorites'
import { useRecentlyViewed } from '../hooks/useRecentlyViewed'

interface Row extends PaletteEntry { kind: 'page' | 'pinned' | 'recent' }

export function useCommandPalette() {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return { open, setOpen }
}

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const canModerate = useCanModerate()
  const { favorites } = useFavorites()
  const { items: recent } = useRecentlyViewed()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const rows = useMemo<Row[]>(() => {
    const pages: Row[] = paletteEntries()
      .filter((e) => (!e.adminOnly || user?.role === 'ADMIN') && (!e.platformAdminOnly || canModerate))
      .map((e) => ({ ...e, kind: 'page' }))
    const pinned: Row[] = favorites.map((f) => ({ label: f.title, to: `/opportunities/${f.id}`, section: 'Pinned', keywords: 'opportunity', kind: 'pinned' }))
    const seen = new Set(favorites.map((f) => f.id))
    const recents: Row[] = recent.filter((r) => !seen.has(r.id)).map((r) => ({ label: r.title, to: `/opportunities/${r.id}`, section: 'Recent', keywords: 'opportunity', kind: 'recent' }))
    return [...pages, ...pinned, ...recents]
  }, [user?.role, canModerate, favorites, recent])

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows.slice(0, 12)
    const terms = q.split(/\s+/)
    // Label matches outrank keyword matches, so "receiv" lands on
    // "Finance › Receivables" rather than the Finance hub itself.
    const scored = rows.flatMap((r) => {
      const label = r.label.toLowerCase()
      const hay = `${label} ${r.section} ${r.keywords}`.toLowerCase()
      if (!terms.every((t) => hay.includes(t))) return []
      const score = terms.every((t) => label.includes(t)) ? (label.startsWith(q) ? 3 : 2) : 1
      return [{ r, score }]
    })
    return scored.sort((a, b) => b.score - a.score).map((x) => x.r).slice(0, 12)
  }, [rows, query])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
      window.setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open])

  useEffect(() => { setIndex(0) }, [query])

  if (!open) return null

  const go = (row: Row) => { onClose(); navigate(row.to) }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, results.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[index]) go(results[index]) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4">
      <button type="button" className="fixed inset-0 bg-black/60 backdrop-blur-sm cursor-default" aria-label="Close search" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to"
        className="relative w-full max-w-lg rounded-2xl overflow-hidden shadow-2xl"
        style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)' }}
      >
        <div className="flex items-center gap-3 px-4" style={{ borderBottom: '1px solid var(--line)' }}>
          <Search className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Go to a page, pinned or recent opportunity…"
            aria-label="Search pages"
            className="w-full bg-transparent py-3.5 text-sm outline-none"
            style={{ color: 'var(--text)' }}
          />
          <kbd className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ color: 'var(--text-faint)', border: '1px solid var(--line-strong)' }}>esc</kbd>
        </div>
        <ul role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto py-2">
          {results.length === 0 && (
            <li className="px-4 py-6 text-sm text-center" style={{ color: 'var(--text-faint)' }}>Nothing matches “{query}”.</li>
          )}
          {results.map((r, i) => (
            <li key={`${r.kind}-${r.to}`} role="option" aria-selected={i === index}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => go(r)}
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors"
                style={{ background: i === index ? 'var(--accent-soft)' : 'transparent', color: 'var(--text)' }}
              >
                {r.kind === 'pinned' ? <Star className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--gold)' }} />
                  : r.kind === 'recent' ? <Clock className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />
                  : <span className="w-3.5 h-3.5 flex-shrink-0" />}
                <span className="truncate flex-1">{r.label}</span>
                <span className="text-[11px] flex-shrink-0" style={{ color: 'var(--text-faint)' }}>{r.section}</span>
                {i === index && <CornerDownLeft className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-faint)' }} />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

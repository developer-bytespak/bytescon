import { useState, useCallback } from 'react'

export interface RecentItem {
  id: string
  title: string
  agency: string
  deadline?: string
  viewedAt: number
}

const KEY = 'bytescon_recently_viewed'
const MAX = 8

function load(): RecentItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

function save(items: RecentItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items))
}

export function useRecentlyViewed() {
  const [items, setItems] = useState<RecentItem[]>(load)

  const addView = useCallback((item: Omit<RecentItem, 'viewedAt'>) => {
    setItems((prev) => {
      const filtered = prev.filter((i) => i.id !== item.id)
      const next = [{ ...item, viewedAt: Date.now() }, ...filtered].slice(0, MAX)
      save(next)
      return next
    })
  }, [])

  const clearHistory = useCallback(() => {
    save([])
    setItems([])
  }, [])

  return { items, addView, clearHistory }
}

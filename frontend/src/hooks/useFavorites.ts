import { useState, useCallback } from 'react'

export interface FavoriteItem {
  id: string
  title: string
  agency: string
  deadline?: string
  naicsCode?: string
  savedAt: number
}

const KEY = 'bytescon_favorites'

function load(): FavoriteItem[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]')
  } catch {
    return []
  }
}

function save(items: FavoriteItem[]) {
  localStorage.setItem(KEY, JSON.stringify(items))
}

export function useFavorites() {
  const [favorites, setFavorites] = useState<FavoriteItem[]>(load)

  const isFavorite = useCallback(
    (id: string) => favorites.some((f) => f.id === id),
    [favorites]
  )

  const toggleFavorite = useCallback((item: Omit<FavoriteItem, 'savedAt'>) => {
    setFavorites((prev) => {
      const exists = prev.some((f) => f.id === item.id)
      const next = exists
        ? prev.filter((f) => f.id !== item.id)
        : [{ ...item, savedAt: Date.now() }, ...prev]
      save(next)
      return next
    })
  }, [])

  const removeFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = prev.filter((f) => f.id !== id)
      save(next)
      return next
    })
  }, [])

  return { favorites, isFavorite, toggleFavorite, removeFavorite }
}

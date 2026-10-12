import { useState, useCallback, useEffect } from 'react'

export type Theme = 'light' | 'dark'

const THEME_COLOR: Record<Theme, string> = { light: '#f6f5f2', dark: '#0b0b0f' }

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme])
}

// The app always opens in light mode; the top-bar toggle switches to dark
// for the current session only.
export function useTheme() {
  const [theme, setTheme] = useState<Theme>('light')

  useEffect(() => {
    apply(theme)
  }, [theme])

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), [])

  return { theme, toggle }
}

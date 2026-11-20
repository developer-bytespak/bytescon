// The new design (styles/ui-v2.css) is switched on per page while it is
// being piloted: a redesigned page calls this, and the whole screen (shell
// included) takes the v2 tokens until the user leaves that page.
import { useEffect } from 'react'

export function useUiV2() {
  useEffect(() => {
    const root = document.documentElement
    const before = root.dataset.ui
    root.dataset.ui = 'v2'
    return () => {
      if (before) root.dataset.ui = before
      else delete root.dataset.ui
    }
  }, [])
}

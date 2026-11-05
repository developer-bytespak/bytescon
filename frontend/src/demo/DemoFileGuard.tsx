import { useEffect } from 'react'
import { FILE_ACTION, isDemoSite } from './demoMode'

// The demo can't upload or download files, and the server refuses them whatever
// the screen shows. This takes the controls away so nobody hits that refusal.
// It works by looking at the page, not screen by screen, so new screens are
// covered too.
const MAX_CONTROL_LABEL = 60

export function shouldHide(element: Element): boolean {
  if (element.matches('input[type="file"], [data-demo-hide]')) return true
  if (!element.matches('button, a, [role="button"], [role="menuitem"], label')) return false
  if (element.closest('[data-demo-keep]')) return false
  if (element.hasAttribute('download')) return true
  const labels = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title')]
  // A long label is a card or row that happens to mention a file, not a file control.
  // Each is read alone: a short "CSV" button with a long tooltip is still a control.
  return labels.some((label) => {
    const words = label?.trim() ?? ''
    return words.length <= MAX_CONTROL_LABEL && FILE_ACTION.test(words)
  })
}

function sweep(root: ParentNode): void {
  root.querySelectorAll('input[type="file"], [data-demo-hide], button, a, [role="button"], [role="menuitem"], label').forEach((element) => {
    if (shouldHide(element)) (element as HTMLElement).style.display = 'none'
  })
}

export function DemoFileGuard() {
  useEffect(() => {
    if (!isDemoSite) return
    sweep(document)
    let scheduled = false
    const observer = new MutationObserver(() => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        sweep(document)
      })
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => observer.disconnect()
  }, [])
  return null
}

// The demo site is its own build, so these checks are fixed when it's built.
export const isDemoSite = import.meta.env.VITE_APP_ENV === 'demo'

/** Words on a button or link that mean a file is moving in or out. */
const ENDED_KEY = 'bytescon_demo_ended'

/** Kept across the redirect to the login page, so it can say why they're there. */
export function rememberDemoEnded(message: string): void {
  try {
    sessionStorage.setItem(ENDED_KEY, message)
  } catch {
    // They reach the login page anyway, and signing in shows the same message.
  }
}

export function takeDemoEnded(): string {
  try {
    const message = sessionStorage.getItem(ENDED_KEY) ?? ''
    sessionStorage.removeItem(ENDED_KEY)
    return message
  } catch {
    return ''
  }
}

export const FILE_ACTION = /\b(upload|download|export|attach|import|csv|pdf)\b/i

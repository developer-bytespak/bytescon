const TUTORIAL_PREFIX = 'bytescon_tutorial_seen_'

export const TUTORIAL_KEYS = {
  dashboard:     'dashboard',
  opportunities: 'opportunities',
  clients:       'clients',
  decisions:     'decisions',
  analytics:     'analytics',
  billing:       'billing',
} as const

export type TutorialKey = (typeof TUTORIAL_KEYS)[keyof typeof TUTORIAL_KEYS]

export function useTutorial() {
  function hasSeen(key: TutorialKey): boolean {
    return localStorage.getItem(TUTORIAL_PREFIX + key) === '1'
  }

  function markSeen(key: TutorialKey): void {
    localStorage.setItem(TUTORIAL_PREFIX + key, '1')
  }

  function resetAll(): void {
    Object.values(TUTORIAL_KEYS).forEach((k) => {
      localStorage.removeItem(TUTORIAL_PREFIX + k)
    })
  }

  return { hasSeen, markSeen, resetAll }
}

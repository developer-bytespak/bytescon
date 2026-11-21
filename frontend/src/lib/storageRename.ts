// The app was renamed from Bytescon to Bytesgov. What the browser saved under
// the old names (sign-in, favourites, sidebar, tours seen…) moves to the new
// ones the first time the renamed app loads, so nobody is signed out or loses
// a setting. Imported first in main.tsx, before anything reads storage.
const OLD = 'bytescon'
const NEW = 'bytesgov'

export function moveRenamedKeys(store: Storage): void {
  const keys: string[] = []
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i)
    if (key && key.startsWith(OLD)) keys.push(key)
  }
  for (const key of keys) {
    const renamed = NEW + key.slice(OLD.length)
    const value = store.getItem(key)
    // A value already saved under the new name wins.
    if (value !== null && store.getItem(renamed) === null) store.setItem(renamed, value)
    store.removeItem(key)
  }
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    if (typeof window !== 'undefined' && window[name]) moveRenamedKeys(window[name])
  } catch {
    // Storage can be blocked (private mode, site data off); nothing to move then.
  }
}

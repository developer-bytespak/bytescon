// Single source of truth for reading the consultant session token from storage.
//
// The session is persisted by useAuth under 'bytescon_auth' as JSON { token, ... }
// and the axios request interceptor reads it from there. Components that make
// raw fetch() calls must use this helper too — a legacy 'auth_token' key that
// the login flow never writes was previously read, so those requests sent
// `Bearer null` and were effectively unauthenticated (Section 4 auth review).

export function getStoredAuthToken(): string | null {
  try {
    const raw = localStorage.getItem('bytescon_auth')
    if (!raw) return null
    return JSON.parse(raw)?.token ?? null
  } catch {
    return null
  }
}

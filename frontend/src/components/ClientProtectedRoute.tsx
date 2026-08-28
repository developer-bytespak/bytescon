import { Navigate, Outlet } from 'react-router-dom'

/**
 * Route guard for the client portal. The client portal uses a SEPARATE
 * identity (a client token stored under `bytescon_client_auth`) from the
 * consultant session that `ProtectedRoute` / `useAuth` guard. Guarding the
 * portal with the consultant `ProtectedRoute` checked the wrong identity;
 * this checks the client token and sends unauthenticated visitors to the
 * client login. (The API independently enforces `authenticateClientJWT`.)
 */
export function ClientProtectedRoute() {
  let token = ''
  try {
    const raw = localStorage.getItem('bytescon_client_auth')
    token = raw ? (JSON.parse(raw).token ?? '') : ''
  } catch {
    token = ''
  }

  if (!token) {
    return <Navigate to="/client-login" replace />
  }

  return <Outlet />
}

import { Navigate, Outlet } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

interface ProtectedRouteProps {
  roles?: string[]
}

export function ProtectedRoute({ roles }: ProtectedRouteProps) {
  const { isAuthenticated, user } = useAuth()

  if (!isAuthenticated) {
    return <Navigate to="/welcome" replace />
  }

  if (roles && (!user || !roles.includes(user.role))) {
    return <Navigate to="/" replace />
  }

  return <Outlet />
}

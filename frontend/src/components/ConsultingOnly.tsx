// Pages about managing clients. A contractor account bids for its own company
// and has no clients, so it is sent to the dashboard instead.
import { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useIsContractor } from '../hooks/useAuth'

export function ConsultingOnly({ children }: { children: ReactNode }) {
  return useIsContractor() ? <Navigate to="/dashboard" replace /> : <>{children}</>
}

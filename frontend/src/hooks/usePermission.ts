// Whether the signed-in user holds a permission (services/rbac/permissions.ts
// on the server). Admins hold every one. While the list is loading the answer
// is false, so a control never flashes and then disappears; the server checks
// again on every action anyway.
import { useQuery } from '@tanstack/react-query'
import { rbacApi } from '../services/integrationsApi'

export function usePermission(permission: string): boolean {
  const { data } = useQuery({ queryKey: ['rbac-me'], queryFn: () => rbacApi.me(), staleTime: 5 * 60 * 1000 })
  return !!data?.permissions?.includes(permission)
}

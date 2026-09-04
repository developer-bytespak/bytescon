import { useQuery } from '@tanstack/react-query'
import { clientDocumentsApi } from '../services/api'

/** Whether the signed-in user is a platform admin (template moderator). */
export function useCanModerate(): boolean {
  const { data } = useQuery({
    queryKey: ['can-moderate-templates'],
    queryFn: () => clientDocumentsApi.canModerateTemplates(),
    staleTime: 5 * 60 * 1000,
  })
  return !!data?.data?.canModerate
}

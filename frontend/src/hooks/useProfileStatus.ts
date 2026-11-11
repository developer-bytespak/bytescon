// Completeness of the company profiles the account keeps: a contractor's own
// company, or each client of a consulting firm. Feeds the "Complete your
// profile" card and the My Company page. Refetched on every page change so
// the card updates as soon as a profile is saved elsewhere.
import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { profileApi, type ProfileFieldHome } from '../services/api'
import { useAuth } from './useAuth'

export const PROFILE_STATUS_KEY = ['profile-status'] as const

export function useProfileStatus() {
  const { isAuthenticated } = useAuth()
  const { pathname } = useLocation()
  const query = useQuery({
    queryKey: PROFILE_STATUS_KEY,
    queryFn: profileApi.status,
    enabled: isAuthenticated,
    staleTime: 15_000,
  })
  const { refetch } = query
  useEffect(() => {
    if (isAuthenticated) void refetch()
  }, [pathname, isAuthenticated, refetch])
  return query
}

/** Where to go to fill a missing field. */
export function fieldHref(where: ProfileFieldHome, profile: { clientCompanyId: string | null; isSelf: boolean }): string {
  if (where === 'REGISTRATION') return '/registration'
  if (where === 'PAST_PERFORMANCE') return '/library/past-performance'
  return profileHref(profile)
}

/** The page where this profile is edited. */
export function profileHref(profile: { clientCompanyId: string | null; isSelf: boolean }): string {
  if (profile.isSelf) return '/my-company'
  return profile.clientCompanyId ? `/clients/${profile.clientCompanyId}` : '/clients'
}

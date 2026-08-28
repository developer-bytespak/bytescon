/**
 * GB-106 React hook. Fetches the tenant's onboarding plan and exposes a
 * progress-update mutation. Transport-agnostic, pass in a fetcher so it works
 * with the host's existing api client (e.g. agencyApi pattern from GB-105).
 */

import { useCallback, useEffect, useState } from 'react';

// Mirror of the backend ScoredProgram / OnboardingPlan shapes (kept local to
// avoid a cross-package import, update in lockstep with onboarding.types.ts).
export interface OnboardingProgramView {
  code: string;
  name: string;
  shortName: string;
  tier: number;
  category: string;
  administeringAgency: string;
  description: string;
  officialUrl: string;
  prerequisites: string[];
  keyRequirements: string[];
  registrationModel: string;
  verificationStatus: string;
  sourceUrls: string[];
  notes: string | null;
}

export interface ScoredProgramView {
  program: OnboardingProgramView;
  relevanceScore: number;
  fitClass: string;
  gate: {
    canStart: boolean;
    windowOpen: boolean;
    prerequisitesMet: boolean;
    missingPrerequisites: string[];
    blockingReason: string | null;
  };
  progressStatus: string;
  requiresVerification: boolean;
}

export interface OnboardingPlanView {
  tenantId: string;
  generatedAt: string;
  programs: ScoredProgramView[];
  unverifiedProgramCodes: string[];
  recommendedNextCode: string | null;
}

export interface OnboardingApi {
  getPlan: () => Promise<OnboardingPlanView>;
  updateProgress: (programCode: string, status: string, notes?: string) => Promise<OnboardingPlanView>;
}

export interface UseOnboardingResult {
  plan: OnboardingPlanView | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setProgress: (programCode: string, status: string, notes?: string) => Promise<void>;
}

export function useOnboarding(api: OnboardingApi): UseOnboardingResult {
  const [plan, setPlan] = useState<OnboardingPlanView | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPlan(await api.getPlan());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load onboarding plan');
    } finally {
      setLoading(false);
    }
  }, [api]);

  const setProgress = useCallback(
    async (programCode: string, status: string, notes?: string) => {
      setError(null);
      try {
        setPlan(await api.updateProgress(programCode, status, notes));
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to update progress');
      }
    },
    [api]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { plan, loading, error, refresh, setProgress };
}

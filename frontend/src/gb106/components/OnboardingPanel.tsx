/**
 * GB-106 onboarding panel. Top-level, flag-gated section. Composes the hook and
 * the cards, grouped by tier so the sequential nature of federal entry is
 * visible. Mirrors the GB-105 AgencyView integration pattern: import the panel
 * into the host page behind a feature flag, no existing files rewritten.
 *
 * Suggested flag (frontend .env): VITE_PLATFORM_ONBOARDING_ENABLED=true
 */

import React from 'react';
import { OnboardingApi, useOnboarding } from '../hooks/useOnboarding';
import { OnboardingProgramCard } from './OnboardingProgramCard';
import './onboarding.css';

const TIER_HEADINGS: Array<{ tier: number; label: string; blurb: string }> = [
  {
    tier: 0,
    label: 'Tier 0, Foundational Registrations',
    blurb: 'Required before anything else. SAM.gov issues the UEI and triggers CAGE assignment.',
  },
  {
    tier: 1,
    label: 'Tier 1, Certification',
    blurb: 'SDVOSB certification unlocks set-aside and sole-source advantages government-wide.',
  },
  {
    tier: 2,
    label: 'Tier 2, Contract Vehicles and Platforms',
    blurb: 'Pursue after the prerequisites are complete. Ranked by fit to your business.',
  },
];

export interface OnboardingPanelProps {
  api: OnboardingApi;
  /** Pass false to render nothing, lets the host gate on a feature flag inline. */
  enabled?: boolean;
  editable?: boolean;
}

export const OnboardingPanel: React.FC<OnboardingPanelProps> = ({ api, enabled = true, editable = false }) => {
  const { plan, loading, error, setProgress } = useOnboarding(api);

  if (!enabled) return null;
  if (loading) return <div className="gb106-panel gb106-muted">Loading onboarding plan…</div>;
  if (error) return <div className="gb106-panel gb106-error">{error}</div>;
  if (!plan) return null;

  return (
    <section className="gb106-panel" aria-label="Platform and vehicle onboarding">
      <header className="gb106-panel-head">
        <h2>Platform and Vehicle Onboarding</h2>
        <p className="gb106-muted">
          Sequenced path onto federal platforms, vehicles, and agencies. {plan.unverifiedProgramCodes.length > 0 && (
            <span className="gb106-verify-note">
              {plan.unverifiedProgramCodes.length} item(s) need timing verification before action.
            </span>
          )}
        </p>
      </header>

      {TIER_HEADINGS.map(({ tier, label, blurb }) => {
        const items = plan.programs.filter((p) => p.program.tier === tier);
        if (items.length === 0) return null;
        return (
          <div key={tier} className="gb106-tier-group">
            <div className="gb106-tier-head">
              <h3>{label}</h3>
              <p className="gb106-muted">{blurb}</p>
            </div>
            <div className="gb106-grid">
              {items.map((item) => (
                <OnboardingProgramCard
                  key={item.program.code}
                  item={item}
                  isRecommended={plan.recommendedNextCode === item.program.code}
                  onStatusChange={editable ? (code, status) => void setProgress(code, status) : undefined}
                />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
};

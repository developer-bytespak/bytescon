/**
 * GB-106 program card. Renders one program: relevance, fit, gating, key
 * requirements, source link, and a verification warning when applicable.
 */

import React from 'react';
import type { ScoredProgramView } from '../hooks/useOnboarding';

const TIER_LABEL: Record<number, string> = {
  0: 'Foundational',
  1: 'Certification',
  2: 'Contract Vehicle',
};

const STATUS_OPTIONS = ['NOT_STARTED', 'IN_PROGRESS', 'SUBMITTED', 'COMPLETE', 'NOT_APPLICABLE'];

export interface OnboardingProgramCardProps {
  item: ScoredProgramView;
  isRecommended: boolean;
  onStatusChange?: (programCode: string, status: string) => void;
}

export const OnboardingProgramCard: React.FC<OnboardingProgramCardProps> = ({
  item,
  isRecommended,
  onStatusChange,
}) => {
  const { program, relevanceScore, fitClass, gate, progressStatus, requiresVerification } = item;

  return (
    <div className={`gb106-card gb106-fit-${fitClass.toLowerCase()}`} data-code={program.code}>
      <div className="gb106-card-head">
        <div>
          <span className="gb106-tier">{TIER_LABEL[program.tier] ?? `Tier ${program.tier}`}</span>
          <h3 className="gb106-card-title">{program.shortName}</h3>
          <p className="gb106-card-agency">{program.administeringAgency}</p>
        </div>
        <div className="gb106-card-score" title="Relevance to this business">
          <span className="gb106-score-num">{relevanceScore}</span>
          <span className="gb106-score-label">{fitClass}</span>
        </div>
      </div>

      {isRecommended && <div className="gb106-badge gb106-badge-next">Recommended next step</div>}

      {requiresVerification && (
        <div className="gb106-badge gb106-badge-verify" role="status">
          Needs verification, confirm timing with the source before acting
        </div>
      )}

      <p className="gb106-card-desc">{program.description}</p>

      <div className={`gb106-gate ${gate.canStart ? 'gb106-gate-open' : 'gb106-gate-blocked'}`}>
        {gate.canStart ? 'Actionable now' : gate.blockingReason ?? 'Not actionable'}
      </div>

      {program.keyRequirements.length > 0 && (
        <ul className="gb106-reqs">
          {program.keyRequirements.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}

      {program.notes && <p className="gb106-card-notes">{program.notes}</p>}

      <div className="gb106-card-foot">
        <a className="gb106-source-link" href={program.officialUrl} target="_blank" rel="noopener noreferrer">
          Official source
        </a>
        {onStatusChange && (
          <label className="gb106-status-select">
            Status
            <select
              value={progressStatus}
              onChange={(e) => onStatusChange(program.code, e.target.value)}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
    </div>
  );
};

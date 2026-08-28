// =============================================================
// Deadline Prioritization Engine
// FR-10: Color classification based on days until deadline
// =============================================================
import { DeadlineClassification, DeadlinePriority } from '../types';

/**
 * Classifies an opportunity deadline into RED/YELLOW/GREEN priority.
 *
 * RED    → ≤  7 days (critical - immediate action required)
 * YELLOW → ≤ 20 days (elevated - prepare submission)
 * GREEN  → >  20 days (monitoring - normal workflow)
 */
export function classifyDeadline(responseDeadline: Date): DeadlineClassification {
  const now = new Date();
  const msPerDay = 1000 * 60 * 60 * 24;
  const daysUntilDeadline = Math.ceil(
    (responseDeadline.getTime() - now.getTime()) / msPerDay
  );

  let priority: DeadlinePriority;
  let label: string;

  if (daysUntilDeadline <= 0) {
    priority = 'RED';
    label = 'EXPIRED';
  } else if (daysUntilDeadline <= 7) {
    priority = 'RED';
    label = `${daysUntilDeadline}d - CRITICAL`;
  } else if (daysUntilDeadline <= 20) {
    priority = 'YELLOW';
    label = `${daysUntilDeadline}d - ELEVATED`;
  } else {
    priority = 'GREEN';
    label = `${daysUntilDeadline}d - NORMAL`;
  }

  return { priority, daysUntilDeadline, label };
}

/**
 * Sorts opportunities by deadline priority then by absolute deadline.
 * RED first, then YELLOW, then GREEN.
 */
export function sortByDeadlinePriority<T extends { responseDeadline: Date }>(
  opportunities: T[]
): T[] {
  const priorityOrder: Record<DeadlinePriority, number> = {
    RED: 0,
    YELLOW: 1,
    GREEN: 2,
  };

  return [...opportunities].sort((a, b) => {
    const pA = classifyDeadline(a.responseDeadline).priority;
    const pB = classifyDeadline(b.responseDeadline).priority;

    if (priorityOrder[pA] !== priorityOrder[pB]) {
      return priorityOrder[pA] - priorityOrder[pB];
    }

    // Within same priority, sort by actual deadline ASC
    return a.responseDeadline.getTime() - b.responseDeadline.getTime();
  });
}

/**
 * Filters opportunities that fall within a deadline window.
 */
export function filterByDeadlineWindow<T extends { responseDeadline: Date }>(
  opportunities: T[],
  maxDays: number
): T[] {
  return opportunities.filter((opp) => {
    const { daysUntilDeadline } = classifyDeadline(opp.responseDeadline);
    return daysUntilDeadline > 0 && daysUntilDeadline <= maxDays;
  });
}

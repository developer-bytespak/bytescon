// =============================================================
// Incumbent Detector
// Pattern-based signal extraction from opportunity title/description
// Enhances incumbentProbability when USAspending data is absent
// =============================================================

const STRONG_PATTERNS: RegExp[] = [
  /\brecompete\b/i,
  /\bfollow[- ]on\b/i,
  /\bbridge contract\b/i,
  /\btransition (period|plan|support|phase)\b/i,
];

const SOFT_PATTERNS: RegExp[] = [
  /\bcurrent contractor\b/i,
  /\bincumbent\b/i,
  /\bbase period plus \d+ option/i,
  /\boption (period|year)s?\b/i,
  /\bcontinuation of (effort|services|work|support)\b/i,
  /\bexisting contract\b/i,
  /\bcontract extension\b/i,
  /\bre-?competi/i,
  /\bprevious contract\b/i,
];

export interface IncumbentDetectionResult {
  detected: boolean;
  strong: boolean;
  confidence: number;
  signals: string[];
  inferredProbability: number;
}

export function detectIncumbent(text: string): IncumbentDetectionResult {
  if (!text || text.trim().length === 0) {
    return { detected: false, strong: false, confidence: 0, signals: [], inferredProbability: 0.3 };
  }

  const signals: string[] = [];
  let strongHits = 0;
  let softHits = 0;

  for (const pattern of STRONG_PATTERNS) {
    const match = text.match(pattern);
    if (match) { strongHits++; signals.push(match[0].toLowerCase()); }
  }
  for (const pattern of SOFT_PATTERNS) {
    const match = text.match(pattern);
    if (match) { softHits++; signals.push(match[0].toLowerCase()); }
  }

  const detected = strongHits > 0 || softHits >= 2;
  const strong = strongHits > 0 || softHits >= 3;
  const confidence = Math.min(1.0, strongHits * 0.35 + softHits * 0.15);

  let inferredProbability: number;
  if (!detected) {
    inferredProbability = 0.25;
  } else if (strong) {
    inferredProbability = Math.min(0.90, 0.65 + confidence * 0.25);
  } else {
    inferredProbability = Math.min(0.70, 0.40 + confidence * 0.25);
  }

  return {
    detected,
    strong,
    confidence,
    signals: [...new Set(signals)],
    inferredProbability,
  };
}

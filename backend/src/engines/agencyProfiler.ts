// =============================================================
// Agency Award Profiler
// Caches per-agency set-aside rates from USAspending
// agencyHistoryScore: how favorable is this agency for the client type?
// =============================================================
import axios from 'axios';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const STALE_HOURS = 168; // weekly

export async function refreshAgencyProfile(agencyName: string): Promise<void> {
  if (!agencyName) return;

  const existing = await prisma.agencyAwardProfile.findUnique({
    where: { agencyName },
    select: { lastRefreshedAt: true },
  });
  if (existing) {
    const ageHours = (Date.now() - existing.lastRefreshedAt.getTime()) / 3600000;
    if (ageHours < STALE_HOURS) return;
  }

  try {
    const today = new Date().toISOString().split('T')[0];
    const response = await axios.post(USASPENDING_URL, {
      filters: {
        agencies: [{ type: 'awarding', tier: 'toptier', name: agencyName }],
        time_period: [{ start_date: '2021-01-01', end_date: today }],
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: ['award_amount', 'type_of_set_aside', 'naics_code'],
      sort: 'award_amount', order: 'desc', limit: 100, page: 1,
    }, { timeout: 12000 });

    const results: any[] = response.data?.results ?? [];
    if (results.length === 0) return;

    // Audit fix #26: canonical set-aside classification. USAspending
    // returns the field in dozens of formats — "SDVOSBC", "SDVOSB Set-Aside",
    // "VOSB - SDVOSB", "8(A) SOLE SOURCE", "HZC", "WOMEN OWNED SMALL BUSINESS".
    // Centralized normalizer maps all variants to a single canonical token.
    const sbCount = results.filter((r: any) => classifySetAside(r.type_of_set_aside) !== 'NONE').length;
    const sdvosbCount = results.filter((r: any) => classifySetAside(r.type_of_set_aside) === 'SDVOSB').length;
    const wosbCount = results.filter((r: any) => classifySetAside(r.type_of_set_aside) === 'WOSB').length;
    const hubzoneCount = results.filter((r: any) => classifySetAside(r.type_of_set_aside) === 'HUBZONE').length;

    const awardValues = results.map((r: any) => r.award_amount).filter((v: any) => typeof v === 'number' && v > 0);
    const avgAwardValue = awardValues.length > 0
      ? awardValues.reduce((a: number, b: number) => a + b, 0) / awardValues.length : null;

    const naicsArr = [...new Set(results.map((r: any) => r.naics_code).filter(Boolean))] as string[];

    await prisma.agencyAwardProfile.upsert({
      where: { agencyName },
      create: {
        agencyName, avgAwardValue,
        smallBizRate: sbCount / results.length,
        sdvosbRate: sdvosbCount / results.length,
        womenOwnedRate: wosbCount / results.length,
        hubzoneRate: hubzoneCount / results.length,
        totalAwards: results.length,
        typicalNaics: naicsArr.slice(0, 10),
        lastRefreshedAt: new Date(),
      },
      update: {
        avgAwardValue,
        smallBizRate: sbCount / results.length,
        sdvosbRate: sdvosbCount / results.length,
        womenOwnedRate: wosbCount / results.length,
        hubzoneRate: hubzoneCount / results.length,
        totalAwards: results.length,
        typicalNaics: naicsArr.slice(0, 10),
        lastRefreshedAt: new Date(),
      },
    });

    logger.debug('Agency profile refreshed', { agencyName, totalAwards: results.length });
  } catch (err) {
    logger.debug('Agency profile refresh skipped', { agencyName, error: (err as Error).message });
  }
}

/**
 * 0-1 score: how historically favorable this agency is for the given client type.
 *
 * Audit fix (2026-05-17, audit finding #13): the previous additive formula
 * could sum to >1.0 for any client holding multiple certifications (e.g. a
 * SDVOSB + WOSB + HUBZone client at an agency with 0.5 rates everywhere
 * produced 2.5 → clamped to 0.95). The output was dominated by the clamp,
 * not by the actual rates, so the score lost discriminating power.
 *
 * Now: weighted AVERAGE over the components that actually apply to the
 * client. Each component contributes proportionally to its weight; the
 * output is always in [0,1] without clamping doing the work.
 */
export async function getAgencyHistoryScore(
  agencyName: string,
  clientProfile: { sdvosb: boolean; wosb: boolean; hubzone: boolean; smallBusiness: boolean }
): Promise<number> {
  try {
    const profile = await prisma.agencyAwardProfile.findUnique({
      where: { agencyName },
      select: { sdvosbRate: true, womenOwnedRate: true, hubzoneRate: true, smallBizRate: true },
    });
    if (!profile) return 0.5;

    // Base component: general small-biz spend share, weight 0.6 (always
    // applies — every small-biz client benefits from agencies that direct
    // any meaningful spend to small business).
    let weightedSum = profile.smallBizRate * 0.6;
    let totalWeight = 0.6;

    // Set-aside boosts contribute only when the client holds that cert.
    // Weight 0.8 each — slightly more than the general small-biz signal
    // because matching set-aside dollars are more directly addressable.
    if (clientProfile.sdvosb) {
      weightedSum += profile.sdvosbRate * 0.8;
      totalWeight += 0.8;
    }
    if (clientProfile.wosb) {
      weightedSum += profile.womenOwnedRate * 0.8;
      totalWeight += 0.8;
    }
    if (clientProfile.hubzone) {
      weightedSum += profile.hubzoneRate * 0.8;
      totalWeight += 0.8;
    }

    const avg = weightedSum / totalWeight;
    // Floor at 0.05 to avoid catastrophic zeros propagating downstream
    // (every agency directs SOME work to small biz); no upper clamp
    // because the weighted average is mathematically bounded by max(rates).
    return Math.max(0.05, Math.min(0.95, avg));
  } catch (err) {
    // P1-2: a DB/query error is a real failure, not a neutral agency. Surface it
    // (the scoring job then retries; the probability compute treats the run as
    // FAILED) instead of fabricating a plausible 0.5 constant. A genuine
    // no-data case is handled above (`if (!profile) return 0.5`).
    logger.error('getAgencyHistoryScore failed', {
      agencyName,
      error: (err as Error).message,
    });
    throw new Error(
      `Agency history score unavailable for "${agencyName}": ${(err as Error).message}`
    );
  }
}

/**
 * Canonical set-aside classifier. USAspending's `type_of_set_aside` field
 * comes back in many shapes — "SDVOSBC", "SDVOSB Set-Aside",
 * "SERVICE-DISABLED VETERAN-OWNED SMALL BUSINESS", "VOSB - SDVOSB",
 * "8(A) COMPETED", "HZC", "WOMEN OWNED SMALL BUSINESS", "EDWOSB", etc.
 * Map all variants to one of: SDVOSB | WOSB | HUBZONE | EIGHT_A | SB | NONE.
 *
 * Order matters: SDVOSB checked before VOSB so the more specific cert
 * wins ("VOSB - SDVOSB" → SDVOSB, not VOSB).
 */
export function classifySetAside(raw: string | null | undefined):
  'SDVOSB' | 'WOSB' | 'HUBZONE' | 'EIGHT_A' | 'SB' | 'NONE' {
  const s = (raw ?? '').toUpperCase().trim();
  if (!s || s === 'NONE' || s === 'NO SET ASIDE USED' || s === 'NSA') return 'NONE';

  // SDVOSB before VOSB — "VOSB - SDVOSB" is a SDVOSB.
  if (/\bSDVOSBC?\b/.test(s) || s.includes('SERVICE-DISABLED VETERAN') || s.includes('SDVOSB')) return 'SDVOSB';
  // 8(a) before WOSB — "8(A) COMPETED" etc.
  if (/\b8\s*\(?\s*A\s*\)?/.test(s) || s.includes('8A') || s.includes('EIGHT A')) return 'EIGHT_A';
  // HUBZone variants
  if (s.includes('HUBZONE') || s.includes('HUB ZONE') || /\bHZC?\b/.test(s)) return 'HUBZONE';
  // WOSB / EDWOSB
  if (s.includes('WOSB') || s.includes('EDWOSB') || s.includes('WOMEN OWNED') || s.includes('WOMAN OWNED')) return 'WOSB';
  // Any remaining "small business" set-aside that didn't match a specific cert.
  if (s.includes('SMALL BUSINESS') || s === 'SBA' || s === 'SBSA') return 'SB';

  // Fallback — non-empty value we don't recognize. Treat as a generic
  // set-aside (SB) rather than NONE so the small-biz rate isn't silently
  // under-counted by parser drift.
  return 'SB';
}

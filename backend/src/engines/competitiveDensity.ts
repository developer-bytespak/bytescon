// =============================================================
// Competitive Density Engine
// Caches NAICS-level bidder density from USAspending
// Score: below-average competition = higher score
// =============================================================
import axios from 'axios';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
const STALE_HOURS = 72;

export async function refreshNaicsDensity(naicsCode: string): Promise<void> {
  if (!naicsCode) return;

  const existing = await prisma.naicsCompetitiveDensity.findUnique({
    where: { naicsCode },
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
        naics_codes: [naicsCode],
        time_period: [{ start_date: '2021-01-01', end_date: today }],
        award_type_codes: ['A', 'B', 'C', 'D'],
      },
      fields: ['number_of_offers_received', 'award_amount', 'type_of_set_aside'],
      sort: 'award_amount', order: 'desc', limit: 100, page: 1,
    }, { timeout: 12000 });

    const results: any[] = response.data?.results ?? [];
    if (results.length === 0) return;

    const bidderCounts = results
      .map((r: any) => r.number_of_offers_received)
      .filter((n: any) => typeof n === 'number' && n > 0);

    const avgBidders = bidderCounts.length > 0
      ? bidderCounts.reduce((a: number, b: number) => a + b, 0) / bidderCounts.length
      : 5.0;

    const sorted = [...bidderCounts].sort((a: number, b: number) => a - b);
    const medianBidders = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : null;

    const awardValues = results.map((r: any) => r.award_amount).filter((v: any) => typeof v === 'number' && v > 0);
    const avgAwardValue = awardValues.length > 0
      ? awardValues.reduce((a: number, b: number) => a + b, 0) / awardValues.length : null;

    const sbCount = results.filter(
      (r: any) => !['', 'NONE', 'NO SET ASIDE USED'].includes((r.type_of_set_aside ?? '').toUpperCase())
    ).length;
    const sdvosbCount = results.filter(
      (r: any) => (r.type_of_set_aside ?? '').toUpperCase().includes('SDVOSB') ||
                  (r.type_of_set_aside ?? '').toUpperCase().includes('VOSB')
    ).length;

    await prisma.naicsCompetitiveDensity.upsert({
      where: { naicsCode },
      create: {
        naicsCode, avgBidders, medianBidders, avgAwardValue,
        smallBizRate: sbCount / results.length,
        sdvosbRate: sdvosbCount / results.length,
        totalContracts: results.length,
        lastRefreshedAt: new Date(),
      },
      update: {
        avgBidders, medianBidders, avgAwardValue,
        smallBizRate: sbCount / results.length,
        sdvosbRate: sdvosbCount / results.length,
        totalContracts: results.length,
        lastRefreshedAt: new Date(),
      },
    });

    logger.debug('NAICS density refreshed', { naicsCode, avgBidders: avgBidders.toFixed(1), totalContracts: results.length });
  } catch (err) {
    logger.debug('NAICS density refresh skipped', { naicsCode, error: (err as Error).message });
  }
}

/**
 * 0-1 score. Below NAICS avg competition => score > 0.5 (easier than normal).
 */
export async function getDensityScore(
  naicsCode: string,
  offersReceived: number | null
): Promise<{ score: number; densityRatio: number | null }> {
  try {
    if (!offersReceived) return { score: 0.5, densityRatio: null };

    const density = await prisma.naicsCompetitiveDensity.findUnique({
      where: { naicsCode },
      select: { avgBidders: true },
    });
    if (!density) return { score: 0.5, densityRatio: null };

    const densityRatio = offersReceived / density.avgBidders;
    // ratio < 1 => less crowded => score > 0.5
    const score = Math.max(0.05, Math.min(0.95, 0.75 - (densityRatio - 0.5) * 0.35));
    return { score, densityRatio };
  } catch (err) {
    // P1-2: surface a real DB/query error instead of fabricating a neutral 0.5.
    // Genuine no-data cases (no offers, no density row) are handled above.
    logger.error('getDensityScore failed', {
      naicsCode,
      error: (err as Error).message,
    });
    throw new Error(
      `Competitive density unavailable for NAICS ${naicsCode}: ${(err as Error).message}`
    );
  }
}

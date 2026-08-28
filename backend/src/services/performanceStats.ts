// =============================================================
// Performance Stats Service
// =============================================================
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { NotFoundError } from '../utils/errors';

export async function recalculateClientStats(
  clientCompanyId: string,
  consultingFirmId: string
): Promise<void> {
  try {
    const submissions = await prisma.submissionRecord.findMany({
      where: { clientCompanyId, consultingFirmId },
      select: {
        wasOnTime: true,
        penaltyAmount: true,
      },
    });

    const totalSubmissions = submissions.length;
    const submissionsOnTime = submissions.filter((s) => s.wasOnTime).length;
    const submissionsLate = totalSubmissions - submissionsOnTime;
    const completionRate = totalSubmissions > 0 ? submissionsOnTime / totalSubmissions : 0;
    const totalPenalties = submissions.reduce((sum, s) => sum + Number(s.penaltyAmount || 0), 0);

    const opportunityCount = await prisma.opportunity.count({
      where: { consultingFirmId },
    });

    await prisma.performanceStats.upsert({
      where: { clientCompanyId },
      update: {
        totalOpportunities: opportunityCount,
        totalSubmitted: totalSubmissions,
        submissionsOnTime,
        submissionsLate,
        completionRate,
        totalPenalties,
        lastCalculatedAt: new Date(),
        updatedAt: new Date(),
      },
      create: {
        clientCompanyId,
        totalOpportunities: opportunityCount,
        totalSubmitted: totalSubmissions,
        submissionsOnTime,
        submissionsLate,
        completionRate,
        totalPenalties,
      },
    });

    logger.info('Client performance stats updated', {
      clientCompanyId,
      completionRate: (completionRate * 100).toFixed(1) + '%',
      totalSubmissions,
    });
  } catch (err) {
    logger.error('Failed to recalculate client stats', { clientCompanyId, error: err });
    throw err;
  }
}

export async function getFirmMetrics(consultingFirmId: string) {
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    include: {
      clientCompanies: {
        include: { performanceStats: true },
      },
    },
  });

  if (!firm) throw new NotFoundError('ConsultingFirm');

  const clients = firm.clientCompanies;
  const totalClients = clients.length;

  const stats = clients
    .map((c) => c.performanceStats)
    .filter((s): s is NonNullable<typeof s> => s !== null);

  const totalSubmissions = stats.reduce((sum, s) => sum + s.totalSubmitted, 0);
  const totalOnTime = stats.reduce((sum, s) => sum + s.submissionsOnTime, 0);
  const aggregateCompletionRate = totalSubmissions > 0 ? totalOnTime / totalSubmissions : 0;
  const totalPenaltiesGenerated = stats.reduce((sum, s) => sum + Number(s.totalPenalties), 0);

  return {
    totalClients,
    totalSubmissions,
    aggregateCompletionRate,
    totalPenaltiesGenerated,
    clientBreakdown: clients.map((c) => ({
      id: c.id,
      name: c.name,
      completionRate: c.performanceStats?.completionRate || 0,
      totalPenalties: c.performanceStats?.totalPenalties || 0,
    })),
  };
}
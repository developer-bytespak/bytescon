// =============================================================
// Prisma Client Singleton
// =============================================================
import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  global.__prisma ||
  new PrismaClient({
    log: [
      { level: 'query', emit: 'event' },
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
    ],
    // Interactive-transaction budget. Prisma's 5s default assumes a
    // same-datacenter database; against a remote Postgres (e.g. Neon from a
    // dev machine at ~200ms RTT) a multi-statement transaction exceeds it on
    // latency alone. Overridable via env; generous defaults are harmless when
    // the DB is close.
    transactionOptions: {
      maxWait: Number(process.env.PRISMA_TX_MAX_WAIT_MS || 15000),
      timeout: Number(process.env.PRISMA_TX_TIMEOUT_MS || 60000),
    },
  });

if (process.env.NODE_ENV !== 'production') {
  global.__prisma = prisma;

  // Log slow queries in development.
  // reason: Prisma 5.22's PrismaClient generic type does not expose $on('query')
  // unless the client is constructed with a literal log config in scope. The
  // re-exported `prisma` above carries the wider PrismaClient type, so the
  // typed event signature is unreachable here. Cast is intentional and bounded
  // to event-emitter calls only.
  (prisma as any).$on('query', (e: any) => {
    if (e.duration > 500) {
      logger.warn('Slow query detected', { duration: e.duration, query: e.query });
    }
  });
}

// reason: see slow-query block above — same Prisma 5.22 type-vs-runtime gap
// for the 'error' event channel. Behavior is correct; only the type is loose.
(prisma as any).$on('error', (e: any) => {
  logger.error('Prisma error', { message: e.message });
});

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
  logger.info('Database connected');
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database disconnected');
}

/**
 * GB-106 standalone seed script. Idempotently upserts the verified program
 * catalog into the database. Safe to re-run, it never fabricates data, it only
 * writes the static verified seed (see onboarding.seed.ts and DATA_SOURCES.md).
 *
 * Run (PowerShell, from repo root after integration):
 *   npx ts-node src/gb106/scripts/seed.gb106.ts
 * or inside the backend container:
 *   docker compose exec backend node dist/gb106/scripts/seed.gb106.js
 *
 * Expects a PrismaClient at the host's usual import path. Adjust the import
 * below to match the project (commonly '../../prisma/client' or '@prisma/client').
 */

/* eslint-disable no-console */
import { PrismaClient } from '@prisma/client';
import { OnboardingService } from '../services/onboarding.service';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    // The PrismaClient is cast to the structural surface the service expects.
    const service = new OnboardingService(prisma as unknown as never);
    const count = await service.seedPrograms();
    console.log(`[gb106] seed complete: ${count} programs upserted`);
  } catch (err) {
    console.error('[gb106] seed failed', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();

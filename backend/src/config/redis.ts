// =============================================================
// Redis Client
// =============================================================
import { Redis } from 'ioredis';
import { config } from './config';
import { logger } from '../utils/logger';

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: null, // Required by BullMQ
  enableReadyCheck: false,
  lazyConnect: true,
});

redis.on('connect', () => logger.info('Redis connected'));
redis.on('error', (err) => logger.error('Redis error', { error: err.message }));
redis.on('close', () => logger.warn('Redis connection closed'));

export async function connectRedis(): Promise<void> {
  if (redis.status === 'ready') return
  // BullMQ workers imported above may have already initiated a connect()
  // before bootstrap reaches us — wait for that in-flight connect to settle
  // instead of throwing.
  if (redis.status === 'connecting' || redis.status === 'connect') {
    await new Promise<void>((resolve) => redis.once('ready', resolve))
    return
  }
  try {
    await redis.connect()
  } catch (e: any) {
    if (String(e?.message || '').includes('already connecting/connected')) {
      await new Promise<void>((resolve) => redis.once('ready', resolve))
      return
    }
    throw e
  }
}


export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.info('Redis disconnected');
}

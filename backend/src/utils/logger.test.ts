// Production errors must reach the host's log. Render wipes local files on every
// restart, so a logger that only writes files leaves nothing to read in an incident.
import { describe, it, expect, vi, afterEach } from 'vitest'
import winston from 'winston'

async function loadLogger(nodeEnv: string) {
  vi.stubEnv('NODE_ENV', nodeEnv)
  vi.resetModules()
  return (await import('./logger')).logger
}

afterEach(() => vi.unstubAllEnvs())

describe('logger', () => {
  it.each(['production', 'development'])('writes to the console in %s', async (nodeEnv) => {
    const logger = await loadLogger(nodeEnv)
    expect(logger.transports.some((t) => t instanceof winston.transports.Console)).toBe(true)
  })

  it('writes one JSON object per line in production, so the host can read it', async () => {
    const logger = await loadLogger('production')
    const consoleTransport = logger.transports.find((t) => t instanceof winston.transports.Console)!
    const info = consoleTransport.format!.transform({ level: 'warn', message: 'hello', flavour: 'staging' } as never) as Record<symbol, string>
    expect(JSON.parse(info[Symbol.for('message')])).toMatchObject({ level: 'warn', message: 'hello', flavour: 'staging' })
  })
})

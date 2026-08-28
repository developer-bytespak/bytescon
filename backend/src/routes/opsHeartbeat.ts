// =============================================================
// Ops heartbeat — how work OUTSIDE the backend process reports
// into the dead-man's switch. The nightly backup is a host shell
// script with no MTA and no BullMQ: it POSTs its outcome here and
// the ops watchdog alerts when those reports stop coming.
//
//   POST /api/ops/heartbeat/:jobName   { status?: 'success'|'failure', error? }
//   GET  /api/ops/status               heartbeat rows (newest sweep visibility)
//
// Auth: X-Ops-Token shared secret (OPS_HEARTBEAT_TOKEN). Endpoint
// answers 503 until the token is configured — fail closed, and the
// nightly-backup staleness alert doubles as the setup reminder.
// =============================================================

import { Router, Request, Response } from 'express'
import crypto from 'crypto'
import express from 'express'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { recordJobSuccess, recordJobFailure, EXPECTED_JOBS } from '../services/jobHealth'
import { sendOpsAlert } from '../services/alertService'

const router = Router()
router.use(express.json({ limit: '16kb' }))

const JOB_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function tokenOk(req: Request, res: Response): boolean {
  const expected = process.env.OPS_HEARTBEAT_TOKEN?.trim()
  if (!expected) {
    res.status(503).json({ success: false, error: 'Ops heartbeat not configured', code: 'OPS_TOKEN_NOT_CONFIGURED' })
    return false
  }
  const provided = String(req.headers['x-ops-token'] ?? '')
  // hash both sides so timingSafeEqual gets equal-length buffers
  const a = crypto.createHash('sha256').update(provided).digest()
  const b = crypto.createHash('sha256').update(expected).digest()
  if (!crypto.timingSafeEqual(a, b)) {
    logger.warn('Ops heartbeat rejected — bad token', { ip: req.ip, path: req.path })
    res.status(401).json({ success: false, error: 'Invalid ops token', code: 'UNAUTHORIZED' })
    return false
  }
  return true
}

router.post('/heartbeat/:jobName', async (req: Request, res: Response) => {
  if (!tokenOk(req, res)) return

  const jobName = String(req.params.jobName)
  if (!JOB_NAME_RE.test(jobName)) {
    return res.status(400).json({ success: false, error: 'Invalid job name', code: 'BAD_REQUEST' })
  }

  const status = req.body?.status === 'failure' ? 'failure' : 'success'
  const detail = typeof req.body?.error === 'string' ? req.body.error.slice(0, 1000) : ''

  if (status === 'success') {
    await recordJobSuccess(jobName)
  } else {
    await recordJobFailure(jobName, detail || 'reported failure (no detail)')
    // a self-reported failure is actionable NOW — don't wait for staleness
    void sendOpsAlert({
      key: `job-reported-failure:${jobName}`,
      severity: 'critical',
      title: `Job reported failure: ${jobName}`,
      detail: detail || '(no detail provided)',
    })
  }

  return res.json({ success: true, data: { jobName, status } })
})

router.get('/status', async (req: Request, res: Response) => {
  if (!tokenOk(req, res)) return

  const rows = await prisma.jobHeartbeat.findMany({ orderBy: { jobName: 'asc' } })
  const expectations = new Map(EXPECTED_JOBS.map((e) => [e.jobName, e.expectEveryHours]))
  return res.json({
    success: true,
    data: rows.map((r) => ({
      jobName: r.jobName,
      lastSuccessAt: r.lastSuccessAt,
      lastFailureAt: r.lastFailureAt,
      lastError: r.lastError,
      expectEveryHours: expectations.get(r.jobName) ?? null,
    })),
  })
})

export default router

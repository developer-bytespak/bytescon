// =============================================================
// POST /api/contracts/upload reads a notice's details from the uploaded
// document with AI. It used to call the AI only when the firm had saved its
// own key, so with the platform key (DEFAULT_LLM_PROVIDER + OPENAI_API_KEY,
// how live runs) extraction was skipped and the notice was named after the file.
// =============================================================
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { Express } from 'express'

const generate = vi.fn()
const configured = vi.fn()
vi.mock('../services/llm/llmRouter', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/llm/llmRouter')>()),
  generateWithRouter: (...a: unknown[]) => generate(...a),
  isLlmProviderConfigured: (...a: unknown[]) => configured(...a),
}))

import { prisma } from '../config/database'
import { buildTestApp, createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../test-utils/testClient'

let app: Express
let firm: TestFirm
let admin: TestUser

const SOW = Buffer.from(`SOLICITATION NUMBER: 36C24726Q0101
DEPARTMENT OF VETERANS AFFAIRS
Structured Cabling and Fiber Optic Backbone Upgrade, Charleston VA Medical Center. NAICS 238210. SDVOSB set-aside.`)

const upload = () => request(app).post('/api/contracts/upload').set('Authorization', `Bearer ${admin.token}`)
  .attach('file', SOW, { filename: 'notice-file.txt', contentType: 'text/plain' })

beforeAll(async () => {
  app = buildTestApp()
  firm = await createTestFirm({ name: 'Contract Upload Firm' })
  admin = await createTestUser(firm.id, { role: 'ADMIN' })
})
afterAll(async () => {
  await cleanupFirm(firm.id)
  await disconnectDb()
})
beforeEach(() => {
  generate.mockReset(); configured.mockReset()
})

describe('POST /api/contracts/upload', () => {
  it('extracts the details with AI on the platform key, though the firm saved no key of its own', async () => {
    const row = await prisma.consultingFirm.findUniqueOrThrow({ where: { id: firm.id } })
    expect(row.openaiApiKey ?? row.anthropicApiKey ?? null).toBeNull()
    configured.mockResolvedValue(true)
    generate.mockResolvedValue({
      text: JSON.stringify({ title: 'Structured Cabling Upgrade, Charleston VAMC', agency: 'Department of Veterans Affairs', naicsCode: '238210', solicitationNumber: '36C24726Q0101' }),
      inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, provider: 'openai', model: 'gpt-5',
    })
    const res = await upload().expect(201)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(res.body.data.extracted).toMatchObject({ title: 'Structured Cabling Upgrade, Charleston VAMC', agency: 'Department of Veterans Affairs', naicsCode: '238210' })
  })

  it('falls back to the file name when no AI is configured', async () => {
    configured.mockResolvedValue(false)
    const res = await upload().expect(201)
    expect(generate).not.toHaveBeenCalled()
    expect(res.body.data.extracted.title).toBe('notice file')
  })
})

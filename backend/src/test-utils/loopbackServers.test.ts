// Test servers bind 127.0.0.1 (see loopbackServers.ts), so a request from
// supertest can never be answered by another program sharing the port.
import { describe, it, expect, vi } from 'vitest'
import http from 'http'
import request from 'supertest'
import express from 'express'
import type { AddressInfo } from 'net'

describe('supertest test servers listen on 127.0.0.1', () => {
  it('binds 127.0.0.1, not every address, and still serves the request', async () => {
    const listen = vi.spyOn(http.Server.prototype, 'listen')
    const app = express().get('/ping', (_req, res) => { res.json({ ok: true }) })
    const res = await request(app).get('/ping')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    expect(listen).toHaveBeenCalledWith(0, '127.0.0.1')
    listen.mockRestore()
  })

  it('works with expect() chains and query strings', async () => {
    const app = express().get('/echo', (req, res) => { res.json({ q: req.query.q }) })
    await request(app).get('/echo').query({ q: 'x' }).expect(200, { q: 'x' })
  })

  it('leaves a server the test started itself alone', async () => {
    const app = express().get('/ping', (_req, res) => { res.json({ ok: true }) })
    const server = await new Promise<http.Server>((resolve) => { const s = http.createServer(app).listen(0, '::1', () => resolve(s)) })
    expect((server.address() as AddressInfo).address).toBe('::1')
    const res = await request(`http://[::1]:${(server.address() as AddressInfo).port}`).get('/ping')
    expect(res.status).toBe(200)
    server.close()
  })
})

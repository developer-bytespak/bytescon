// =============================================================
// fileStorage — uploads survive the local disk being wiped.
//
// Render (and any container host) throws away `uploads/` on every restart and
// redeploy. These tests stand in for the bucket with an in-memory store, wipe
// the disk copy the way a restart does, and check that the file comes back —
// through the module directly and through the real upload middleware.
// =============================================================
import fs from 'fs'
import path from 'path'
import express from 'express'
import request from 'supertest'
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import {
  UPLOAD_ROOT,
  RemoteFileStore,
  isRemoteStorageEnabled,
  keyForPath,
  persistUpload,
  removeUpload,
  restoreUpload,
  setRemoteFileStore,
  uploadPath,
  writeUpload,
} from './fileStorage'
import { upload } from '../middleware/upload'
import { sendAuthorizedFile } from './partnerPortal/partnerFiles'

class MemoryStore implements RemoteFileStore {
  objects = new Map<string, Buffer>()
  failPuts = false
  failGets = false
  async put(key: string, body: Buffer) {
    if (this.failPuts) throw new Error('bucket unavailable')
    this.objects.set(key, Buffer.from(body))
  }
  async get(key: string) {
    if (this.failGets) throw new Error('bucket unavailable')
    return this.objects.get(key) ?? null
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
}

const TEST_DIR = '__fileStorage_test__'
const written: string[] = []

function key(name: string) {
  const k = `${TEST_DIR}/${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`
  written.push(k)
  return k
}

/** What a server restart does to the local copy. */
function wipeLocal(k: string) {
  fs.rmSync(uploadPath(k) as string, { force: true })
}

let store: MemoryStore

beforeEach(() => {
  store = new MemoryStore()
  setRemoteFileStore(store)
})

afterEach(async () => {
  for (const k of written.splice(0)) await removeUpload(k)
  setRemoteFileStore(undefined)
})

afterAll(() => {
  fs.rmSync(path.join(UPLOAD_ROOT, TEST_DIR), { recursive: true, force: true })
})

describe('restoreUpload', () => {
  it('brings a file back from the bucket after the disk copy is wiped', async () => {
    const k = key('contract.pdf')
    await writeUpload(k, Buffer.from('%PDF-1.4 signed contract'), 'application/pdf')
    wipeLocal(k)
    expect(fs.existsSync(uploadPath(k) as string)).toBe(false)

    const restored = await restoreUpload(k)

    expect(restored).toBe(uploadPath(k))
    expect(fs.readFileSync(restored as string, 'utf-8')).toBe('%PDF-1.4 signed contract')
  })

  it('returns the local copy without touching the bucket when it is still on disk', async () => {
    const k = key('local.txt')
    await writeUpload(k, 'hello')
    store.failGets = true
    expect(await restoreUpload(k)).toBe(uploadPath(k))
  })

  it('reports a file that exists nowhere as missing', async () => {
    expect(await restoreUpload(key('never-uploaded.pdf'))).toBeNull()
  })

  it('reports missing (not throws) when the bucket is down', async () => {
    const k = key('outage.pdf')
    await writeUpload(k, 'x')
    wipeLocal(k)
    store.failGets = true
    expect(await restoreUpload(k)).toBeNull()
  })

  it('refuses keys that escape the uploads folder', async () => {
    store.objects.set('uploads/../../etc/passwd', Buffer.from('root'))
    for (const bad of ['../../etc/passwd', '/etc/passwd', '', null, undefined]) {
      expect(await restoreUpload(bad as string)).toBeNull()
    }
  })
})

describe('without a bucket (local development)', () => {
  beforeEach(() => setRemoteFileStore(null))

  it('keeps working on local disk alone', async () => {
    expect(isRemoteStorageEnabled()).toBe(false)
    const k = key('dev.txt')
    await writeUpload(k, 'dev')
    expect(await restoreUpload(k)).toBe(uploadPath(k))
    wipeLocal(k)
    expect(await restoreUpload(k)).toBeNull()
  })
})

describe('persistUpload / removeUpload', () => {
  it('stores the object under the uploads/ prefix', async () => {
    const k = key('a.txt')
    await writeUpload(k, 'abc')
    expect(store.objects.get(`uploads/${k}`)?.toString()).toBe('abc')
  })

  it('throws when the bucket write fails, so an upload is never silently lost', async () => {
    const k = key('b.txt')
    store.failPuts = true
    await expect(writeUpload(k, 'abc')).rejects.toThrow('bucket unavailable')
  })

  it('deletes from disk and bucket', async () => {
    const k = key('c.txt')
    await writeUpload(k, 'abc')
    await removeUpload(k)
    expect(fs.existsSync(uploadPath(k) as string)).toBe(false)
    expect(store.objects.has(`uploads/${k}`)).toBe(false)
  })

  it('refuses to persist a key outside the uploads folder', async () => {
    await expect(persistUpload('../outside.txt')).rejects.toThrow('invalid storage key')
  })

  it('maps multer paths to keys and back', () => {
    expect(keyForPath(path.join(UPLOAD_ROOT, 'branding', 'logo.png'))).toBe('branding/logo.png')
    expect(keyForPath('/tmp/elsewhere.png')).toBeNull()
  })
})

describe('upload middleware → restart → download', () => {
  function app() {
    const a = express()
    a.post('/upload', upload.single('file'), (req, res) => {
      written.push(req.file!.filename)
      res.json({ key: req.file!.filename })
    })
    // Same shape as the real download routes (documents, templates, teaming…).
    a.get('/download/:key', async (req, res) => {
      const filePath = await restoreUpload(req.params.key)
      if (!filePath) return res.status(404).json({ error: 'File not found' })
      res.download(filePath)
    })
    // The partner-portal / e-sign / personnel helper.
    a.get('/authorized/:key', async (req, res, next) => {
      try {
        await sendAuthorizedFile(res, { storageKey: req.params.key, fileName: 'file.pdf', fileType: 'application/pdf' })
      } catch (err) {
        next(err)
      }
    })
    a.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err.message })
    })
    return a
  }

  it('an uploaded file can still be downloaded after the server disk is wiped', async () => {
    const server = app()
    const up = await request(server).post('/upload').attach('file', Buffer.from('%PDF-1.4 rfp'), { filename: 'rfp.pdf', contentType: 'application/pdf' })
    expect(up.status).toBe(200)
    const k = up.body.key as string
    expect(store.objects.has(`uploads/${k}`)).toBe(true)

    wipeLocal(k)

    const down = await request(server).get(`/download/${k}`).buffer(true)
    expect(down.status).toBe(200)
    expect(Buffer.from(down.body).toString()).toBe('%PDF-1.4 rfp')

    wipeLocal(k)
    const auth = await request(server).get(`/authorized/${k}`).buffer(true)
    expect(auth.status).toBe(200)
    expect(auth.headers['cache-control']).toContain('no-store')
  })

  it('without a bucket the same flow loses the file — the original bug', async () => {
    setRemoteFileStore(null)
    const server = app()
    const up = await request(server).post('/upload').attach('file', Buffer.from('%PDF-1.4 rfp'), { filename: 'rfp.pdf', contentType: 'application/pdf' })
    wipeLocal(up.body.key)
    const down = await request(server).get(`/download/${up.body.key}`)
    expect(down.status).toBe(404)
  })

  it('rejects the upload and leaves nothing on disk when the bucket write fails', async () => {
    store.failPuts = true
    const before = new Set(fs.readdirSync(UPLOAD_ROOT))
    const up = await request(app()).post('/upload').attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' })
    expect(up.status).toBe(500)
    const added = fs.readdirSync(UPLOAD_ROOT).filter((f) => !before.has(f))
    expect(added).toEqual([])
  })
})

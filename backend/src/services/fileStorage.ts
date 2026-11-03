// =============================================================
// Durable storage for uploaded and generated files.
//
// Every file still lives under the local `uploads/` folder while the server
// works with it — parsers, PDF builders and res.download all take a path. The
// local folder is only a cache, though: hosts like Render wipe it on every
// restart and redeploy. When a bucket is configured (S3, Cloudflare R2, MinIO —
// anything S3-compatible), each file is also written to the bucket, and a file
// missing from disk is pulled back down before it is read.
//
// Without a bucket the module is a no-op wrapper around the local folder, which
// is the right behaviour for local development and tests.
//
// Storage keys are paths relative to `uploads/` in forward-slash form
// (`1730000000000-uuid.pdf`, `branding/1730000000000-uuid.png`). A key that
// escapes the folder is never read, written or deleted.
// =============================================================
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { logger } from '../utils/logger'

export const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads')

/** The bucket side of the store. Swappable so tests need no network. */
export interface RemoteFileStore {
  put(objectKey: string, body: Buffer, contentType?: string): Promise<void>
  /** The object's bytes, or null when the bucket has no such object. */
  get(objectKey: string): Promise<Buffer | null>
  delete(objectKey: string): Promise<void>
}

class S3FileStore implements RemoteFileStore {
  constructor(private client: S3Client, private bucket: string) {}

  async put(objectKey: string, body: Buffer, contentType?: string) {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: objectKey,
      Body: body,
      ContentType: contentType || 'application/octet-stream',
    }))
  }

  async get(objectKey: string) {
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }))
      if (!out.Body) return null
      return Buffer.from(await out.Body.transformToByteArray())
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
      if (e.name === 'NoSuchKey' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null
      throw err
    }
  }

  async delete(objectKey: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }))
  }
}

function storeFromEnv(): RemoteFileStore | null {
  const bucket = process.env.UPLOADS_S3_BUCKET?.trim()
  if (!bucket) return null
  const endpoint = process.env.UPLOADS_S3_ENDPOINT?.trim() || undefined
  const accessKeyId = process.env.UPLOADS_S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = process.env.UPLOADS_S3_SECRET_ACCESS_KEY?.trim()
  const client = new S3Client({
    // R2 ignores the region but the SDK requires one; 'auto' is R2's documented value.
    region: process.env.UPLOADS_S3_REGION?.trim() || 'auto',
    endpoint,
    // Path-style addressing works on R2, MinIO and AWS alike.
    forcePathStyle: Boolean(endpoint),
    credentials: accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined,
  })
  return new S3FileStore(client, bucket)
}

let remote: RemoteFileStore | null | undefined

function getRemote(): RemoteFileStore | null {
  if (remote === undefined) remote = storeFromEnv()
  return remote
}

/** Replace the bucket (tests) or reset to the environment's (pass undefined). */
export function setRemoteFileStore(store: RemoteFileStore | null | undefined): void {
  remote = store
}

export function isRemoteStorageEnabled(): boolean {
  return getRemote() !== null
}

function objectKeyFor(key: string): string {
  return `${process.env.UPLOADS_S3_PREFIX ?? 'uploads/'}${key}`
}

/**
 * Absolute path for a storage key, or null when the key is empty or would
 * escape the uploads folder.
 */
export function uploadPath(key: string | null | undefined): string | null {
  if (!key || typeof key !== 'string' || key.trim().length === 0) return null
  if (path.isAbsolute(key)) return null
  const resolved = path.resolve(UPLOAD_ROOT, key)
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep)) return null
  return resolved
}

/** Storage key for an absolute path inside the uploads folder (e.g. multer's file.path). */
export function keyForPath(absolutePath: string): string | null {
  const resolved = path.resolve(absolutePath)
  if (!resolved.startsWith(UPLOAD_ROOT + path.sep)) return null
  return path.relative(UPLOAD_ROOT, resolved).split(path.sep).join('/')
}

function isLocalFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * Copy a file that is already on disk to the bucket. Throws when the bucket
 * write fails, so the caller can refuse an upload that would not survive a
 * restart instead of accepting it silently.
 */
export async function persistUpload(key: string, contentType?: string): Promise<void> {
  const store = getRemote()
  if (!store) return
  const p = uploadPath(key)
  if (!p) throw new Error(`Refusing to persist invalid storage key: ${key}`)
  await store.put(objectKeyFor(key), await fs.promises.readFile(p), contentType)
}

/** Write bytes the server generated (PDFs, anonymized text) and persist them. */
export async function writeUpload(key: string, data: Buffer | string, contentType?: string): Promise<string> {
  const p = uploadPath(key)
  if (!p) throw new Error(`Refusing to write invalid storage key: ${key}`)
  await fs.promises.mkdir(path.dirname(p), { recursive: true })
  await fs.promises.writeFile(p, data)
  await persistUpload(key, contentType)
  return p
}

/**
 * Local path of a stored file, downloading it from the bucket first when the
 * disk copy is gone. Null when the key is invalid or the file exists nowhere.
 * A bucket outage is logged and reported as missing rather than thrown, so
 * every caller keeps its existing "file not found" handling.
 */
export async function restoreUpload(key: string | null | undefined): Promise<string | null> {
  const p = uploadPath(key)
  if (!p) return null
  if (isLocalFile(p)) return p
  const store = getRemote()
  if (!store) return null
  try {
    const body = await store.get(objectKeyFor(key as string))
    if (!body) return null
    await fs.promises.mkdir(path.dirname(p), { recursive: true })
    // Write then rename so a concurrent reader never sees a half-written file.
    const tmp = `${p}.${crypto.randomUUID()}.part`
    await fs.promises.writeFile(tmp, body)
    await fs.promises.rename(tmp, p)
    return p
  } catch (err) {
    logger.error('Could not restore file from bucket', { key, error: (err as Error).message })
    return null
  }
}

/** Delete a stored file from disk and bucket. Never throws. */
export async function removeUpload(key: string | null | undefined): Promise<void> {
  const p = uploadPath(key)
  if (!p) return
  try {
    await fs.promises.unlink(p)
  } catch {
    // already gone locally
  }
  const store = getRemote()
  if (!store) return
  try {
    await store.delete(objectKeyFor(key as string))
  } catch (err) {
    logger.warn('Could not delete file from bucket', { key, error: (err as Error).message })
  }
}

/** One startup line saying where files are kept; a warning in production without a bucket. */
export function logFileStorageMode(): void {
  if (isRemoteStorageEnabled()) {
    logger.info('File storage: local cache + bucket', { bucket: process.env.UPLOADS_S3_BUCKET })
  } else if (process.env.NODE_ENV === 'production') {
    logger.warn('File storage: local disk only — uploads are lost when the server restarts. Set UPLOADS_S3_BUCKET.')
  }
}

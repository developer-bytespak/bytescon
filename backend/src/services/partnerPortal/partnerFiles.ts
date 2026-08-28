// =============================================================
// §8.4 — Secure file delivery for the partner portal.
//
// Two rules, and they are the whole module:
//
//  1. AUTHORIZE, THEN READ. Every caller resolves the record through the
//     grant chain first. Nothing here accepts a file id, a filename, a path or
//     a partnerId from the request as evidence of anything.
//  2. THE STORAGE KEY IS NOT A PATH. It is a flat, server-generated file name.
//     A key that escapes the uploads root — by traversal, by separator, by
//     absolute path — is refused rather than sanitized, because a key that
//     needed sanitizing was never one this server wrote.
//
// Bytes are streamed from local disk after authorization. There is no signed
// URL and no public path, so there is nothing to copy, share or replay: every
// request re-derives the grant, which is what makes a revocation take effect
// on the next byte rather than at token expiry.
// =============================================================
import fs from 'fs'
import path from 'path'
import { Response } from 'express'
import { NotFoundError, ValidationError } from '../../utils/errors'

const UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads')

/**
 * Absolute on-disk path for a stored key, or a refusal.
 *
 * The resolved path must sit inside the uploads root. `path.resolve` collapses
 * `..` before the check, so traversal is caught rather than trusted.
 */
export function resolveStoredFilePath(storageKey: string | null | undefined): string {
  if (!storageKey || typeof storageKey !== 'string' || storageKey.trim().length === 0) {
    throw new NotFoundError('No file is attached to this record')
  }
  if (path.isAbsolute(storageKey)) throw new ValidationError('Invalid stored file reference')

  const resolved = path.resolve(UPLOAD_ROOT, storageKey)
  if (resolved !== UPLOAD_ROOT && !resolved.startsWith(UPLOAD_ROOT + path.sep)) {
    throw new ValidationError('Invalid stored file reference')
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new NotFoundError('That file is no longer available')
  }
  return resolved
}

/**
 * A Content-Disposition filename an external client cannot use to smuggle
 * header syntax, a path or a control character. Falls back to a neutral name
 * rather than an empty one.
 */
export function safeDownloadName(fileName: string | null | undefined): string {
  const base = path.basename(String(fileName ?? '')).replace(/[^A-Za-z0-9._ -]/g, '_').trim()
  const trimmed = base.replace(/^\.+/, '').slice(0, 120)
  return trimmed.length > 0 ? trimmed : 'download'
}

/**
 * Send an authorized file.
 *
 * The MIME type recorded at upload time is used verbatim: it was validated by
 * the upload middleware, and re-deriving it from the extension here would trust
 * a name instead of the check that already happened. The response is marked
 * private and no-store so an intermediary cannot retain a document that a
 * later revocation was supposed to take away, and nosniff keeps a browser from
 * upgrading an octet-stream into something executable.
 */
export function sendAuthorizedFile(
  res: Response,
  file: { storageKey: string | null; fileName: string | null; fileType: string | null },
): void {
  const absolute = resolveStoredFilePath(file.storageKey)
  const name = safeDownloadName(file.fileName)

  res.setHeader('Content-Type', file.fileType || 'application/octet-stream')
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
  res.setHeader('Cache-Control', 'private, no-store, max-age=0')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.sendFile(absolute)
}

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import multer, { FileFilterCallback } from 'multer'
import { ValidationError } from '../utils/errors'

const uploadDir = path.join(process.cwd(), 'uploads')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const allowedMimeTypes = new Set([
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'application/octet-stream',
])

// Image MIME allowlist for branding logo uploads. Kept SEPARATE from the
// document allowlist above so a doc-upload route can never accept an image
// (and vice versa) by accident. Add to either set with care — every type
// permitted here can be served by any route the operator wires up.
const imageMimeTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/svg+xml',
  'image/webp',
])

export const allowedDocumentMimeTypes = allowedMimeTypes
export const allowedImageMimeTypes = imageMimeTypes

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const extension = (path.extname(file.originalname || '').toLowerCase() || '.bin').slice(0, 10)
    const token = crypto.randomUUID()
    cb(null, `${Date.now()}-${token}${extension}`)
  },
})

function fileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: FileFilterCallback
) {
  if (!allowedMimeTypes.has(file.mimetype)) {
    cb(new ValidationError('Unsupported file type. Allowed: pdf, txt, doc, docx, xls, xlsx'))
    return
  }

  cb(null, true)
}

const maxUploadBytes = Math.max(
  1,
  Number(process.env.MAX_UPLOAD_MB || 25)
) * 1024 * 1024

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: maxUploadBytes,
    files: 1,
  },
})

/**
 * Build a per-route multer instance with a custom MIME allowlist, size cap,
 * and storage subdirectory. Use for routes that accept different file types
 * than the global document upload — e.g. logo uploads need image MIMEs but
 * must NOT permit pdf/docx, and document upload routes must NOT accept images.
 *
 * The subdir is created on first use under the project's `uploads/` root.
 * Filenames remain `{timestamp}-{uuid}{ext}` for uniqueness.
 */
export interface CreateUploadOptions {
  /** Set of accepted MIME types. Required — pass allowedImageMimeTypes etc. */
  allowedMimeTypes: Set<string>
  /** Max bytes per file. Defaults to MAX_UPLOAD_MB env (25MB) when omitted. */
  maxBytes?: number
  /** Subdirectory under uploads/ where files land. e.g. 'branding'. */
  subdir?: string
  /** Human label used in the unsupported-type error message. */
  typeLabel?: string
}

export function createUpload(opts: CreateUploadOptions) {
  const targetDir = opts.subdir ? path.join(uploadDir, opts.subdir) : uploadDir
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true })
  }

  const customStorage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, targetDir),
    filename: (_req, file, cb) => {
      const extension = (path.extname(file.originalname || '').toLowerCase() || '.bin').slice(0, 10)
      const token = crypto.randomUUID()
      cb(null, `${Date.now()}-${token}${extension}`)
    },
  })

  function customFilter(
    _req: Express.Request,
    file: Express.Multer.File,
    cb: FileFilterCallback,
  ) {
    if (!opts.allowedMimeTypes.has(file.mimetype)) {
      const label = opts.typeLabel ?? Array.from(opts.allowedMimeTypes).join(', ')
      cb(new ValidationError(`Unsupported file type. Allowed: ${label}`))
      return
    }
    cb(null, true)
  }

  return multer({
    storage: customStorage,
    fileFilter: customFilter,
    limits: {
      fileSize: opts.maxBytes ?? maxUploadBytes,
      files: 1,
    },
  })
}

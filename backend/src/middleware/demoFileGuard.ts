// =============================================================
// The demo has no file storage, so nobody uploads or downloads files on it.
//
// Enforced here for the whole API rather than route by route, so a new upload or
// export route can't be missed. Mounted only on the demo flavour.
// =============================================================
import type { NextFunction, Request, Response } from 'express'
import { ForbiddenError } from '../utils/errors'

const MESSAGE = 'File uploads and downloads are not available in this demo.'

function refuse(res: Response): Response {
  // Clears anything a route already set, such as a file name or type.
  res.removeHeader('Content-Disposition')
  res.removeHeader('Content-Type')
  return res.status(403).json({ success: false, error: MESSAGE, code: 'DEMO_NO_FILES' })
}

export function demoFileGuard(req: Request, res: Response, next: NextFunction): void {
  if ((req.headers['content-type'] || '').toLowerCase().startsWith('multipart/form-data')) {
    refuse(res)
    return
  }

  res.download = (() => refuse(res)) as unknown as Response['download']
  res.sendFile = (() => refuse(res)) as unknown as Response['sendFile']
  res.attachment = ((): never => { throw new ForbiddenError(MESSAGE) }) as unknown as Response['attachment']

  // Exports that write a file straight to the response set this header first.
  const setHeader = res.setHeader.bind(res)
  res.setHeader = ((name: string, value: number | string | readonly string[]) => {
    if (name.toLowerCase() === 'content-disposition' && String(value).toLowerCase().includes('attachment')) {
      throw new ForbiddenError(MESSAGE)
    }
    return setHeader(name, value)
  }) as Response['setHeader']

  next()
}

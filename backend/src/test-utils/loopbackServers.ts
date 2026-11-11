// =============================================================
// supertest's test servers listen on 127.0.0.1, not on every address.
//
// supertest starts each test app with `server.listen(0)`, which binds every
// address (`::`), and then sends the request to 127.0.0.1:<port>. On macOS a
// wildcard listener may share a port number with another program already
// listening on 127.0.0.1 — editors and their helpers (VS Code does) hold such
// ports in the same random range. When the OS hands a test app one of those
// ports, the request goes to the other program instead, and the test sees a
// stray 401, a 404 "Route not found", a wrong 200, or a hang that times out.
// It happens about once in every couple of full runs, in a different test
// each time.
//
// Here supertest binds 127.0.0.1 explicitly, so the OS picks a port that is
// free on that address and the request always reaches the test app. Binding a
// named host finishes a moment later (Node resolves the host first), so the
// request is sent once the server is listening. A server the test started
// itself, and string URLs, are left as they were.
// =============================================================
import type { Server } from 'http'
import { Server as TlsServer } from 'tls'
import { Test } from 'supertest'

const LOOPBACK = '127.0.0.1'
const PATCHED = Symbol.for('bytescon.test.loopbackSupertest')

interface PatchableTest {
  url: string
  _server?: Server
  _loopbackPath?: string
  serverAddress(app: Server, path: string): string
  end(fn?: (err: unknown, res: unknown) => void): unknown
}

const proto = Test.prototype as unknown as PatchableTest & { [PATCHED]?: boolean }

if (!proto[PATCHED]) {
  const originalServerAddress = proto.serverAddress
  const originalEnd = proto.end

  proto.serverAddress = function (this: PatchableTest, app: Server, path: string): string {
    // Already listening (a server the test started): keep supertest's behaviour.
    if (app.address()) return originalServerAddress.call(this, app, path)
    this._server = app.listen(0, LOOPBACK)
    this._loopbackPath = path
    const protocol = app instanceof TlsServer ? 'https' : 'http'
    // The real port is filled in by end(), once the server is listening.
    return `${protocol}://${LOOPBACK}:0${path}`
  }

  proto.end = function (this: PatchableTest, fn?: (err: unknown, res: unknown) => void) {
    const server = this._server
    if (!server || this._loopbackPath === undefined || server.address()) {
      if (server && this._loopbackPath !== undefined) this.url = withPort(this.url, server)
      return originalEnd.call(this, fn)
    }
    server.once('listening', () => {
      this.url = withPort(this.url, server)
      originalEnd.call(this, fn)
    })
    server.once('error', (err) => fn?.(err, undefined))
    return this
  }

  proto[PATCHED] = true
}

function withPort(url: string, server: Server): string {
  const address = server.address()
  const port = address && typeof address === 'object' ? address.port : 0
  return url.replace(`${LOOPBACK}:0`, `${LOOPBACK}:${port}`)
}

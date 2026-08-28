// =============================================================
// §8 FINAL ACCEPTANCE — the static security scan.
//
// Every assertion here is a rule about the SHAPE of Section 8 code, so it
// holds for code that does not exist yet. A reviewer reads a file once; this
// reads all of them on every push.
//
// Comments are stripped before matching, because several of these modules
// explain the rule they follow in prose — and a scan that cannot tell a rule
// from its violation is worse than no scan, since it trains people to ignore it.
// =============================================================
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'

const ROOT = path.resolve(__dirname, '../..')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.includes('.test.')) out.push(full)
  }
  return out
}

const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/')

function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** The files Section 8 introduced or took over. */
const SECTION8 = walk(path.join(ROOT, 'src')).filter((f) => {
  const p = rel(f)
  return /^src\/(services\/(crm|erp|integrations|knowledge|partnerPortal|publicApi|rbac|sso)|routes\/(crm|erp|esign|integrations|integrationWebhooks|knowledge|partnerPortal|personnel|rbac|sso|publicApi)|middleware\/permissions)/.test(p)
})

describe('§8 security: the tenant is never taken from the caller', () => {
  it('reads no consultingFirmId or tenantId out of a request body', () => {
    const offenders: string[] = []
    for (const file of SECTION8) {
      const body = code(file)
      if (/req\.body[^\n]*\b(consultingFirmId|tenantId|firmId)\b/.test(body)) offenders.push(rel(file))
      // `parsed.data.consultingFirmId` assigned straight into a where clause is
      // the same mistake wearing a validator.
      if (/consultingFirmId:\s*(parsed|body|d)\.(data\.)?consultingFirmId/.test(body)) offenders.push(rel(file))
    }
    expect(offenders).toEqual([])
  })

  it('refuses a caller-supplied tenant on the public API rather than ignoring it', () => {
    const auth = code(path.join(ROOT, 'src/services/publicApi/apiTokenAuth.ts'))
    expect(auth).toContain('TENANT_NOT_ADDRESSABLE')
    expect(auth).toMatch(/TENANT_ASSERTION_KEYS/)
  })

  it('derives the webhook tenant from stored state, never from the payload', () => {
    const webhook = code(path.join(ROOT, 'src/routes/integrationWebhooks.ts'))
    expect(webhook).toMatch(/envelope\.consultingFirmId/)
    expect(webhook).not.toMatch(/payload[^\n]*consultingFirmId/)
  })
})

describe('§8 security: secrets stay on the server', () => {
  it('logs no token, secret or authorization header anywhere in Section 8', () => {
    const offenders: string[] = []
    for (const file of SECTION8) {
      for (const call of code(file).matchAll(/logger\.\w+\([^)]*\)/g)) {
        if (/\b(accessToken|refreshToken|clientSecret|rawToken|passwordHash|apiKey|authorization)\b/i.test(call[0])) {
          offenders.push(`${rel(file)}: ${call[0].slice(0, 90)}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('names no encrypted column in any response-shaping module', () => {
    const offenders: string[] = []
    for (const file of SECTION8) {
      const p = rel(file)
      // The connection service is the one place allowed to touch them.
      if (p === 'src/services/integrations/connectionService.ts') continue
      const body = code(file)
      for (const column of ['accessTokenEnc', 'refreshTokenEnc', 'clientSecretEnc', 'codeVerifierEnc']) {
        // Reading one to decrypt it is fine; putting it in a select for a DTO is not.
        if (new RegExp(`${column}:\\s*true`).test(body)) offenders.push(`${p}:${column}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('hard-codes no credential', () => {
    const offenders: string[] = []
    for (const file of SECTION8) {
      const body = code(file)
      for (const match of body.matchAll(/(?:secret|password|apiKey|token)\s*[:=]\s*'([^']{16,})'/gi)) {
        // Environment lookups and error strings are not credentials.
        if (/process\.env|\s/.test(match[1])) continue
        offenders.push(`${rel(file)}: ${match[0].slice(0, 60)}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('§8 security: no raw row reaches a public surface', () => {
  it('spreads no Prisma row into a public API DTO', () => {
    const dto = code(path.join(ROOT, 'src/services/publicApi/dto.ts'))
    expect(dto).not.toMatch(/\.\.\.row|\.\.\.record|\.\.\.r\b/)
  })

  it('names every public API field explicitly', () => {
    const dto = code(path.join(ROOT, 'src/services/publicApi/dto.ts'))
    // Each builder ends in an object literal of named fields.
    for (const builder of ['toOpportunityDto', 'toPursuitDto', 'toContractDto', 'toPartnerDto', 'toPersonnelDto']) {
      expect(dto).toContain(`export function ${builder}`)
    }
    expect(dto).not.toContain('consultingFirmId:')
  })

  it('returns no credential-shaped field from the integration DTO', () => {
    const service = code(path.join(ROOT, 'src/services/integrations/connectionService.ts'))
    const dtoBlock = /export function toConnectionDto[\s\S]*?\n\}/.exec(service)?.[0] ?? ''
    expect(dtoBlock.length).toBeGreaterThan(100)
    for (const forbidden of ['accessTokenEnc', 'refreshTokenEnc', 'accessToken', 'refreshToken']) {
      expect([forbidden, dtoBlock.includes(forbidden)]).toEqual([forbidden, false])
    }
  })
})

describe('§8 security: files are served only after authorization', () => {
  it('resolves every stored path through the one guarded resolver', () => {
    const offenders: string[] = []
    for (const file of SECTION8) {
      const body = code(file)
      if (/res\.(download|sendFile)\(/.test(body) && !/sendAuthorizedFile/.test(body)) offenders.push(rel(file))
    }
    expect(offenders).toEqual([])
  })

  it('refuses a storage key that escapes the uploads root', () => {
    const files = code(path.join(ROOT, 'src/services/partnerPortal/partnerFiles.ts'))
    expect(files).toContain('path.isAbsolute')
    expect(files).toMatch(/startsWith\(UPLOAD_ROOT/)
    expect(files).toContain('nosniff')
    expect(files).toContain('no-store')
  })
})

describe('§8 security: every external entry point is verified', () => {
  it('verifies the provider signature before acting on a webhook', () => {
    const webhook = code(path.join(ROOT, 'src/routes/integrationWebhooks.ts'))
    // Compare CALL sites, not the import list at the top of the file.
    const handler = /router\.post\('\/docusign'[\s\S]*$/.exec(webhook)?.[0] ?? ''
    const verifyAt = handler.indexOf('verifyDocusignSignature(')
    const applyAt = handler.indexOf('applyProviderStatus(')
    expect(verifyAt).toBeGreaterThan(-1)
    expect(applyAt).toBeGreaterThan(verifyAt)
    // And a failed verification returns before anything else happens.
    expect(handler).toMatch(/verifyDocusignSignature\([\s\S]{0,300}?res\.status\(401\)[\s\S]{0,120}?return/)
  })

  it('has no path that accepts an unverified identity token', () => {
    const verifier = code(path.join(ROOT, 'src/services/sso/idTokenVerifier.ts'))
    // Every branch either verifies or throws.
    expect(verifier).toMatch(/jwt\.verify\(idToken, secret/)
    expect(verifier).toMatch(/jwt\.verify\(idToken, jwkToPem/)
    expect(verifier).toMatch(/unsupported signature algorithm/)
    expect(verifier).not.toMatch(/ignoreExpiration|algorithms:\s*\[\s*'none'/)
  })

  it('burns every single-use state with a conditional update', () => {
    for (const file of ['src/services/integrations/connectionService.ts', 'src/services/sso/ssoService.ts']) {
      const body = code(path.join(ROOT, file))
      expect([file, /updateMany\([\s\S]{0,200}consumedAt: null/.test(body)]).toEqual([file, true])
    }
  })

  it('stores only a hash of every state and reset token', () => {
    const connection = code(path.join(ROOT, 'src/services/integrations/connectionService.ts'))
    const sso = code(path.join(ROOT, 'src/services/sso/ssoService.ts'))
    expect(connection).toMatch(/stateHash:\s*crypto\.createHash\('sha256'\)/)
    expect(sso).toMatch(/stateHash:\s*sha256\(state\)/)
  })
})

describe('§8 security: a role never substitutes for a permission', () => {
  it('checks no bare role string inside a Section 8 handler', () => {
    const offenders: string[] = []
    for (const file of SECTION8) {
      const body = code(file)
      for (const match of body.matchAll(/req\.user[?.]*\.role\s*===\s*'[A-Z_]+'/g)) {
        offenders.push(`${rel(file)}: ${match[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('resolves permissions from the database rather than the token', () => {
    const middleware = code(path.join(ROOT, 'src/middleware/permissions.ts'))
    expect(middleware).toContain('prisma.user.findUnique')
    expect(middleware).toMatch(/isActive/)
    // A deactivated account holds nothing, whatever its token says.
    expect(middleware).toMatch(/new Set<Permission>\(\)/)
  })
})

describe('§8 security: no raw SQL without a tenant', () => {
  it('uses no unsafe raw query anywhere in Section 8', () => {
    const offenders = SECTION8.filter((f) => /\$queryRawUnsafe|\$executeRawUnsafe/.test(code(f)))
    expect(offenders.map(rel)).toEqual([])
  })

  it('scopes the one tagged raw statement to a single row by id', () => {
    const portal = code(path.join(ROOT, 'src/routes/partnerPortal.ts'))
    for (const match of portal.matchAll(/\$executeRaw`([^`]+)`/g)) {
      expect(match[1]).toMatch(/WHERE "id" = /)
    }
  })
})

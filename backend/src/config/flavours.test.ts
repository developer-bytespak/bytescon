// The flavour list is only useful if render.yaml and the example files agree with
// it. These tests fail when they drift, before a deploy finds out the hard way.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { getFlavour, missingSettings, REQUIRED_SETTINGS, settingProblems, type HostedFlavour } from './flavours'

const ROOT = path.resolve(__dirname, '../../..')
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8')

/** The block of render.yaml for one service. */
function renderService(name: string): string {
  const yaml = read('render.yaml')
  const start = yaml.indexOf(`name: ${name}\n`)
  expect(start, `${name} in render.yaml`).toBeGreaterThan(-1)
  const next = yaml.slice(start).search(/\n\s+- type: /)
  return next === -1 ? yaml.slice(start) : yaml.slice(start, start + next)
}

const complete = (flavour: HostedFlavour) => ({
  APP_ENV: flavour,
  ...Object.fromEntries(REQUIRED_SETTINGS[flavour].map((name) => [name, name.endsWith('URL') ? 'https://x.example' : 'set'])),
})

describe('getFlavour', () => {
  it.each([
    [{}, 'development'],
    [{ NODE_ENV: 'development' }, 'development'],
    [{ NODE_ENV: 'production' }, 'production'],
    [{ NODE_ENV: 'production', APP_ENV: 'production' }, 'production'],
    [{ NODE_ENV: 'production', APP_ENV: 'staging' }, 'staging'],
    [{ APP_ENV: ' STAGING ' }, 'staging'],
    [{ NODE_ENV: 'production', APP_ENV: 'demo' }, 'demo'],
  ])('%j is %s', (env, expected) => {
    expect(getFlavour(env)).toBe(expected)
  })
})

describe('missingSettings', () => {
  it.each(['staging', 'demo', 'production'] as const)('finds nothing missing on a complete %s', (flavour) => {
    expect(missingSettings(flavour, complete(flavour))).toEqual([])
  })

  it('names what is missing, and treats a blank value as missing', () => {
    const env: Record<string, string> = { ...complete('staging'), FIELD_ENCRYPTION_KEY: '   ' }
    delete env.STAGING_ALLOWED_EMAILS
    expect(missingSettings('staging', env)).toEqual(['FIELD_ENCRYPTION_KEY', 'STAGING_ALLOWED_EMAILS'])
  })

  it('needs the staff list on staging and monitoring on production', () => {
    expect(REQUIRED_SETTINGS.staging).toContain('STAGING_ALLOWED_EMAILS')
    expect(REQUIRED_SETTINGS.production).not.toContain('STAGING_ALLOWED_EMAILS')
    expect(REQUIRED_SETTINGS.production).toContain('SENTRY_DSN')
  })
})

describe('settingProblems', () => {
  const SECRET = 'sk_live_do_not_print_me'

  it.each(['staging', 'demo', 'production'] as const)('finds nothing wrong on a complete %s', (flavour) => {
    expect(settingProblems(flavour, complete(flavour))).toEqual([])
  })

  it('refuses a live Stripe key on staging without printing it', () => {
    const problems = settingProblems('staging', { ...complete('staging'), STRIPE_SECRET_KEY: SECRET })
    expect(problems.join(' ')).toMatch(/live key/)
    expect(problems.join(' ')).not.toContain(SECRET)
  })

  it('flags a test Stripe key on production', () => {
    expect(settingProblems('production', { ...complete('production'), STRIPE_SECRET_KEY: 'sk_test_x' }).join(' ')).toMatch(/test key/)
  })

  it('flags a site address that is not https', () => {
    expect(settingProblems('production', { ...complete('production'), APP_URL: 'http://app.example' })).toEqual(['APP_URL must start with https://.'])
  })

  it('flags a flavour the environment does not say it is', () => {
    expect(settingProblems('staging', { ...complete('staging'), APP_ENV: 'production' })).toEqual(['APP_ENV must be set to staging.'])
  })
})

describe('render.yaml agrees', () => {
  const services: Array<[HostedFlavour, string]> = [['staging', 'bytescon-api-staging'], ['production', 'bytescon-api']]

  it.each(services)('%s: %s declares every required setting', (flavour, service) => {
    const block = renderService(service)
    for (const name of REQUIRED_SETTINGS[flavour]) expect(block, name).toContain(`key: ${name}`)
    expect(block).toContain(`{ key: APP_ENV, value: ${flavour} }`)
    expect(block).toContain('{ key: NODE_ENV, value: production }')
  })

  it('never shares a Redis between the two flavours', () => {
    expect(renderService('bytescon-api-staging')).toContain('name: bytescon-redis-staging')
    expect(renderService('bytescon-api')).not.toContain('bytescon-redis-staging')
  })

  it('deploys each flavour from its own branch', () => {
    expect(renderService('bytescon-api-staging')).toContain('branch: staging')
    expect(renderService('bytescon-api')).toContain('branch: main')
  })
})

describe('the demo flavour', () => {
  const blueprint = read('render-demo.yaml')

  it('declares every required setting in its own blueprint', () => {
    for (const name of REQUIRED_SETTINGS.demo) expect(blueprint, name).toContain(`key: ${name}`)
    expect(blueprint).toContain('{ key: APP_ENV, value: demo }')
  })

  it('deploys from its own branch and touches no other environment', () => {
    expect(blueprint).toContain('branch: feat/demo-version')
    expect(blueprint).not.toMatch(/name: bytescon-api\n/)
    expect(blueprint).not.toMatch(/name: bytescon-redis\n/)
    expect(blueprint).not.toContain('STRIPE_SECRET_KEY')
    expect(blueprint).not.toContain('UPLOADS_S3')
  })

  it('refuses a live Stripe key', () => {
    expect(settingProblems('demo', { ...complete('demo'), STRIPE_SECRET_KEY: 'sk_live_x' }).join(' ')).toMatch(/live key/)
  })
})

describe('the example files agree', () => {
  it.each([['staging', 'backend/.env.staging.example'], ['demo', 'backend/.env.demo.example'], ['production', 'backend/.env.prod.example']] as const)(
    '%s: %s lists every required setting, with no real secrets',
    (flavour, file) => {
      const text = read(file)
      for (const name of REQUIRED_SETTINGS[flavour]) expect(text, name).toMatch(new RegExp(`^${name}=`, 'm'))
      expect(text).toMatch(new RegExp(`^APP_ENV=${flavour}$`, 'm'))
      expect(text).not.toMatch(/sk_live_[A-Za-z0-9]{8,}/)
    },
  )
})

// =============================================================
// Flavours: the named setups Bytescon runs as.
//
//   development  a developer's machine
//   staging      internal team only, test data, fake money (APP_ENV=staging)
//   demo         client demos: expiring accounts, sample data, no payments or files
//   production   real customers
//
// All three run the same code. A flavour is only which settings it needs, so
// this is the one list of them. render.yaml and the .env example files must
// agree with it, and a test fails if they drift.
//
// Names only, always: nothing here reads out or logs a setting's value.
// =============================================================

export type Flavour = 'development' | 'staging' | 'demo' | 'production'
export type HostedFlavour = Exclude<Flavour, 'development'>

/** Needed by both hosted flavours, each with its own values. */
const SHARED = [
  'DATABASE_URL',
  'DIRECT_URL',
  'REDIS_URL',
  'JWT_SECRET',
  'FIELD_ENCRYPTION_KEY',
  'APP_URL',
  'FRONTEND_URL',
  'PUBLIC_APP_URL',
  'ALLOWED_ORIGINS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SENDGRID_API_KEY',
  'EMAIL_FROM',
  'SAM_API_KEY',
  'UPLOADS_S3_BUCKET',
  'UPLOADS_S3_ENDPOINT',
  'UPLOADS_S3_REGION',
  'UPLOADS_S3_ACCESS_KEY_ID',
  'UPLOADS_S3_SECRET_ACCESS_KEY',
]

export const REQUIRED_SETTINGS: Record<HostedFlavour, string[]> = {
  staging: [...SHARED, 'STAGING_ALLOWED_EMAILS'],
  // No Stripe, email, SAM.gov or file storage: the demo doesn't use them.
  demo: [
    'DATABASE_URL',
    'DIRECT_URL',
    'REDIS_URL',
    'JWT_SECRET',
    'FIELD_ENCRYPTION_KEY',
    'APP_URL',
    'FRONTEND_URL',
    'PUBLIC_APP_URL',
    'ALLOWED_ORIGINS',
    'PLATFORM_ADMIN_EMAILS',
  ],
  production: [
    ...SHARED,
    'SENTRY_DSN',
    'OPS_HEARTBEAT_TOKEN',
    'ALERT_WEBHOOK_URL',
    'METRICS_SECRET',
    'PLATFORM_ADMIN_EMAIL',
    'PLATFORM_ADMIN_EMAILS',
  ],
}

type Env = Record<string, string | undefined>

/** Follows getAppEnv: only a machine that isn't NODE_ENV=production can be development. */
export function getFlavour(env: Env = process.env): Flavour {
  const appEnv = (env.APP_ENV || '').trim().toLowerCase()
  if (appEnv === 'staging') return 'staging'
  if (appEnv === 'demo') return 'demo'
  if (appEnv === 'production' || env.NODE_ENV === 'production') return 'production'
  return 'development'
}

export function missingSettings(flavour: HostedFlavour, env: Env = process.env): string[] {
  return REQUIRED_SETTINGS[flavour].filter((name) => !(env[name] || '').trim())
}

const isLiveStripeKey = (key: string) => key.startsWith('sk_live') || key.startsWith('rk_live')
const isTestStripeKey = (key: string) => key.startsWith('sk_test') || key.startsWith('rk_test')

/** Settings that are present but wrong for this flavour. Describes them without their values. */
export function settingProblems(flavour: HostedFlavour, env: Env = process.env): string[] {
  const problems: string[] = []
  const stripeKey = (env.STRIPE_SECRET_KEY || '').trim()

  if (flavour !== 'production' && isLiveStripeKey(stripeKey)) {
    problems.push(`STRIPE_SECRET_KEY is a live key. The ${flavour} flavour must not use one.`)
  }
  if (flavour === 'production' && isTestStripeKey(stripeKey)) {
    problems.push('STRIPE_SECRET_KEY is a test key, so production cannot take real payments yet.')
  }
  for (const name of ['APP_URL', 'FRONTEND_URL', 'PUBLIC_APP_URL']) {
    const value = (env[name] || '').trim()
    if (value && !value.startsWith('https://')) problems.push(`${name} must start with https://.`)
  }
  const appEnv = (env.APP_ENV || '').trim().toLowerCase()
  if (appEnv !== flavour) problems.push(`APP_ENV must be set to ${flavour}.`)
  return problems
}

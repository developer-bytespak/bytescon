// Is this environment fully set up? Prints setting names only, never values.
//
//   npm run flavour:check              the flavour this environment says it is
//   npm run flavour:check -- staging   check against a named flavour
//
// Exits 1 if anything is missing or wrong, so it can gate a go-live step.
import 'dotenv/config'
import { getFlavour, missingSettings, settingProblems, type HostedFlavour } from '../src/config/flavours'

const named = process.argv[2]
if (named && named !== 'staging' && named !== 'demo' && named !== 'production') {
  console.error(`Unknown flavour "${named}". Use staging, demo or production.`)
  process.exit(2)
}
const flavour = (named as HostedFlavour | undefined) ?? getFlavour()
if (flavour === 'development') {
  console.log('This is the development flavour, which has no required settings. Name one to check: staging or production.')
  process.exit(0)
}

const missing = missingSettings(flavour)
const problems = settingProblems(flavour)
console.log(`Flavour: ${flavour}`)
if (missing.length) console.log(`\nMissing (${missing.length}):\n${missing.map((m) => `  - ${m}`).join('\n')}`)
if (problems.length) console.log(`\nWrong (${problems.length}):\n${problems.map((p) => `  - ${p}`).join('\n')}`)
if (missing.length || problems.length) process.exit(1)
console.log('All required settings are present.')

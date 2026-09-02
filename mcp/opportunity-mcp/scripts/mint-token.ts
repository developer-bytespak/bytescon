#!/usr/bin/env node
// =============================================================
// Mint an API token for the MCP server.
//
// Replaces the "direct SQL INSERT" footgun in the README (v0.1/v0.2)
// with a typed, validated, audited path. Uses the same hashing
// function as src/lib/auth.ts so the row matches what the runtime
// expects.
//
// Usage (from mcp/opportunity-mcp/):
//   DATABASE_URL=postgresql://... npx tsx scripts/mint-token.ts \
//     --firm-id <consulting_firm_uuid> \
//     --name "MCP demo for Acme Corp" \
//     [--tier CORE|PRO|VAULT] \
//     [--expires-in-days 90]
//
// Prints the raw token to stdout ONCE — the server stores only the
// hash, so this is the only time the value is visible. Treat it like
// a password.
// =============================================================
import crypto from "node:crypto"
import process from "node:process"
import { PrismaClient } from "@prisma/client"
import { hashToken } from "../src/lib/auth.js"

type Tier = "CORE" | "PRO" | "VAULT"

interface Args {
  firmId: string
  name: string
  tier: Tier
  expiresInDays: number | null
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  let firmId = ""
  let name = ""
  let tier: Tier = "CORE"
  let expiresInDays: number | null = null

  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]
    switch (v) {
      case "--firm-id":
        firmId = argv[++i] ?? ""
        break
      case "--name":
        name = argv[++i] ?? ""
        break
      case "--tier": {
        const t = (argv[++i] ?? "").toUpperCase()
        if (t === "CORE" || t === "PRO" || t === "VAULT") tier = t
        else throw new Error(`invalid --tier "${t}" — must be CORE | PRO | VAULT`)
        break
      }
      case "--expires-in-days": {
        const n = parseInt(argv[++i] ?? "", 10)
        if (!Number.isFinite(n) || n <= 0) {
          throw new Error("--expires-in-days must be a positive integer")
        }
        expiresInDays = n
        break
      }
      case "-h":
      case "--help":
        printUsage()
        process.exit(0)
      default:
        throw new Error(`unknown arg: ${v}`)
    }
  }

  if (!firmId) throw new Error("--firm-id is required")
  if (!name) throw new Error("--name is required")
  if (name.length > 200) throw new Error("--name max length 200")

  return { firmId, name, tier, expiresInDays }
}

function printUsage(): void {
  console.error([
    "Usage: npx tsx scripts/mint-token.ts \\",
    "  --firm-id <consulting_firm_uuid> \\",
    "  --name \"Human-readable label\" \\",
    "  [--tier CORE|PRO|VAULT]            (default CORE)",
    "  [--expires-in-days N]              (default no expiry)",
  ].join("\n"))
}

async function main(): Promise<void> {
  let args: Args
  try {
    args = parseArgs()
  } catch (err) {
    console.error("error:", (err as Error).message)
    printUsage()
    process.exit(2)
  }

  const prisma = new PrismaClient()
  try {
    const firm = await prisma.consultingFirm.findUnique({
      where: { id: args.firmId },
      select: { id: true, name: true },
    })
    if (!firm) {
      console.error(`error: no consulting_firm with id=${args.firmId}`)
      process.exit(3)
    }

    // 32 bytes of cryptographic randomness, base64url-encoded → 43 chars
    // (matches the entropy floor in src/lib/auth.ts which rejects < 16).
    const rawToken = crypto.randomBytes(32).toString("base64url")
    const tokenHash = hashToken(rawToken)
    const tokenPrefix = rawToken.slice(0, 8)

    const expiresAt = args.expiresInDays
      ? new Date(Date.now() + args.expiresInDays * 24 * 60 * 60 * 1000)
      : null

    const row = await prisma.apiToken.create({
      data: {
        name: args.name,
        consultingFirmId: args.firmId,
        tokenHash,
        tokenPrefix,
        tier: args.tier,
        expiresAt,
      },
      select: { id: true, name: true, tier: true, createdAt: true, expiresAt: true },
    })

    console.log(JSON.stringify({
      tokenId: row.id,
      firmId: args.firmId,
      firmName: firm.name,
      tokenName: row.name,
      tier: row.tier,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      rawToken,
      hint: "Save this raw token NOW — the server stores only the hash. Set Bytescon_MCP_TOKEN to this value.",
    }, null, 2))
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error("mint-token failed:", err)
  process.exit(1)
})

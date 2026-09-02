#!/usr/bin/env pwsh
<#
.SYNOPSIS
  One-command pre-VETS26-demo health check for opportunity-mcp.

.DESCRIPTION
  Verifies — and where possible self-heals — the full chain the MCP demo
  depends on:
      1. Docker daemon up        (launches Docker Desktop + waits if down)
      2. bytescon_postgres ready   (docker start + pg_isready wait if down)
      3. api_tokens row resolves (the Bytescon_MCP_TOKEN seed exists/active)
      4. VETS26 demo data loaded (>0 vets26 opportunities)
      5. smoke.ps1 green         (end-to-end JSON-RPC, exit 0)

  Run this right before the demo (or after any reboot). Green across all
  five = safe to present. Background: the only thing that has ever broken
  this demo is Docker/Postgres being down, which steps 1-2 now auto-fix.

.EXAMPLE
  ./scripts/predemo-check.ps1
#>

param(
    [string]$Container  = "bytescon_postgres",
    [string]$DbUser     = "bytescon_user",
    [string]$DbName     = "bytescon_platform",
    [string]$Token      = "2cfa7e8569e5b78e5d4265feb04026723b5e8466d4ada4c61bde889a2064770c",
    [int]$WaitSeconds   = 180
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$fail = $false

function Step($n, $msg)  { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)        { Write-Host "    PASS  $msg" -ForegroundColor Green }
function Warn($msg)      { Write-Host "    .. $msg" -ForegroundColor Yellow }
function Bad($msg)       { Write-Host "    FAIL  $msg" -ForegroundColor Red; $script:fail = $true }

# ── 1. Docker daemon ────────────────────────────────────────────────────────
Step 1 "Docker daemon"
if (docker info --format '{{.ServerVersion}}' 2>$null) {
    Ok "daemon up ($(docker info --format '{{.ServerVersion}}' 2>$null))"
} else {
    Warn "daemon down — launching Docker Desktop"
    $exe = "C:\Program Files\Docker\Docker\Docker Desktop.exe"
    if (Test-Path $exe) { Start-Process $exe }
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $WaitSeconds) {
        if (docker info --format '{{.ServerVersion}}' 2>$null) { break }
        Start-Sleep -Seconds 5
    }
    if (docker info --format '{{.ServerVersion}}' 2>$null) { Ok "daemon came up after $([int]$sw.Elapsed.TotalSeconds)s" }
    else { Bad "daemon did not come up within ${WaitSeconds}s"; Write-Host "`nABORT — fix Docker, then re-run." -ForegroundColor Red; exit 1 }
}

# ── 2. Postgres container ───────────────────────────────────────────────────
Step 2 "Postgres ($Container)"
$running = (docker ps --filter "name=^/$Container$" --format '{{.Names}}') -eq $Container
if (-not $running) { Warn "not running — docker start $Container"; docker start $Container | Out-Null }
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$ready = $false
while ($sw.Elapsed.TotalSeconds -lt 60) {
    docker exec $Container pg_isready -U $DbUser -d $DbName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Seconds 2
}
if ($ready) { Ok "accepting connections" } else { Bad "pg_isready never succeeded" }

# ── 3. Token resolves ───────────────────────────────────────────────────────
Step 3 "API token seed"
$prefix = $Token.Substring(0, 12)
$q = "SELECT count(*) FROM api_tokens WHERE ""tokenPrefix""='$prefix' AND ""revokedAt"" IS NULL AND (""expiresAt"" IS NULL OR ""expiresAt"" > NOW());"
$rows = (docker exec $Container psql -U $DbUser -d $DbName -tAc $q 2>$null)
if ($rows -eq "1") { Ok "active token row present (prefix $prefix)" }
else { Bad "no active token row for prefix $prefix (got '$rows') — re-seed api_tokens" }

# ── 4. Demo data ────────────────────────────────────────────────────────────
Step 4 "VETS26 demo data"
$dq = "SELECT count(*) FROM opportunities WHERE id LIKE 'vets26%' OR id LIKE 'demo-vets26%';"
$n  = (docker exec $Container psql -U $DbUser -d $DbName -tAc $dq 2>$null)
if ([int]$n -gt 0) { Ok "$n VETS26 demo opportunities loaded" }
else { Bad "0 VETS26 demo opps — run scripts/seed-vets26-demo.sql" }

# ── 5. End-to-end smoke ─────────────────────────────────────────────────────
Step 5 "End-to-end smoke test"
$env:Bytescon_MCP_TOKEN = $Token
$smoke = Join-Path $scriptDir "smoke.ps1"
$out = & $smoke 2>&1 | Out-String
$exit = ($out -split "--- EXIT CODE ---")[-1].Trim()
if ($exit -eq "0" -and $out -match '"result_count":\s*[1-9]') { Ok "smoke green (exit 0, results returned)" }
else { Bad "smoke not green (exit '$exit') — see full output below"; Write-Host $out -ForegroundColor DarkGray }

# ── Verdict ─────────────────────────────────────────────────────────────────
Write-Host ""
if ($fail) { Write-Host "RESULT: NOT READY — resolve the FAIL line(s) above." -ForegroundColor Red; exit 1 }
else       { Write-Host "RESULT: DEMO READY — all five checks green." -ForegroundColor Green; exit 0 }

#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Smoke test for knowledge-mcp. Exercises auth -> tools/list -> one
  tools/call per tool -> audit-write end-to-end via JSON-RPC over stdio.

.DESCRIPTION
  Spawns `node dist/server.js` as a child process, drives the MCP
  handshake, calls retrieve_far_clause, retrieve_dfars_clause,
  retrieve_agency_pattern, and search_clauses, prints raw JSON-RPC
  responses and captured stderr. Re-runnable in seconds.

  Prerequisite: the clause catalog must be seeded once per database:
    Get-Content scripts/seed-clause-catalog.sql -Raw |
      docker exec -i bytescon_postgres psql -U bytescon_user -d bytescon_platform

.PARAMETER DatabaseUrl
  Postgres connection string. Defaults to the local docker container.

.PARAMETER TokenFile
  Path to a file containing the raw Bytescon_MCP_TOKEN. Defaults to
  ../../vets26_dev_token.txt relative to this script. Overridden if
  $env:Bytescon_MCP_TOKEN is already set.

.EXAMPLE
  ./scripts/smoke.ps1
#>

param(
    [string]$DatabaseUrl = "postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform",
    [string]$TokenFile = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverJs  = Join-Path $scriptDir "..\dist\server.js" | Resolve-Path | Select-Object -ExpandProperty Path

$token = $env:Bytescon_MCP_TOKEN
if (-not $token) {
    if (-not $TokenFile) {
        $TokenFile = Join-Path $scriptDir "..\..\vets26_dev_token.txt"
    }
    if (-not (Test-Path $TokenFile)) {
        throw "Bytescon_MCP_TOKEN env var unset and token file not found at $TokenFile"
    }
    $token = (Get-Content $TokenFile -Raw).Trim()
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName  = "node"
$psi.Arguments = $serverJs
$psi.RedirectStandardInput  = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.UseShellExecute = $false
$psi.CreateNoWindow  = $true
$psi.EnvironmentVariables["DATABASE_URL"]    = $DatabaseUrl
$psi.EnvironmentVariables["Bytescon_MCP_TOKEN"] = $token

$proc = [System.Diagnostics.Process]::Start($psi)

$stderrBuf = New-Object System.Text.StringBuilder
$null = Register-ObjectEvent -InputObject $proc -EventName ErrorDataReceived -Action {
    if ($EventArgs.Data) { [void]$Event.MessageData.AppendLine($EventArgs.Data) }
} -MessageData $stderrBuf
$proc.BeginErrorReadLine()

function Send-Json($obj) {
    $line = $obj | ConvertTo-Json -Compress -Depth 10
    $proc.StandardInput.WriteLine($line)
    $proc.StandardInput.Flush()
}

function Read-Response($label, $timeoutMs = 8000) {
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt $timeoutMs) {
        $line = $proc.StandardOutput.ReadLine()
        if ($line) {
            Write-Output "--- $label ---"
            Write-Output $line
            return
        }
        Start-Sleep -Milliseconds 50
    }
    Write-Output "--- $label (TIMEOUT after ${timeoutMs}ms) ---"
}

Send-Json @{
    jsonrpc = "2.0"; id = 1; method = "initialize"
    params = @{
        protocolVersion = "2024-11-05"
        capabilities    = @{}
        clientInfo      = @{ name = "smoke-test"; version = "0.0.1" }
    }
}
Read-Response "INITIALIZE RESPONSE"

Send-Json @{ jsonrpc = "2.0"; method = "notifications/initialized" }

Send-Json @{ jsonrpc = "2.0"; id = 2; method = "tools/list" }
Read-Response "TOOLS/LIST RESPONSE"

Send-Json @{
    jsonrpc = "2.0"; id = 3; method = "tools/call"
    params  = @{
        name      = "retrieve_far_clause"
        arguments = @{ code = "52.219-14" }
    }
}
Read-Response "RETRIEVE_FAR_CLAUSE RESPONSE" 10000

Send-Json @{
    jsonrpc = "2.0"; id = 4; method = "tools/call"
    params  = @{
        name      = "retrieve_dfars_clause"
        arguments = @{ code = "252.204-7012" }
    }
}
Read-Response "RETRIEVE_DFARS_CLAUSE RESPONSE" 10000

Send-Json @{
    jsonrpc = "2.0"; id = 5; method = "tools/call"
    params  = @{
        name      = "retrieve_agency_pattern"
        arguments = @{ agency = "Veterans" }
    }
}
Read-Response "RETRIEVE_AGENCY_PATTERN RESPONSE" 10000

Send-Json @{
    jsonrpc = "2.0"; id = 6; method = "tools/call"
    params  = @{
        name      = "search_clauses"
        arguments = @{ keyword = "subcontracting"; limit = 5 }
    }
}
Read-Response "SEARCH_CLAUSES RESPONSE" 10000

$proc.StandardInput.Close()
if (-not $proc.WaitForExit(2000)) { $proc.Kill() }

Write-Output ""
Write-Output "--- STDERR (server logs) ---"
Write-Output $stderrBuf.ToString()
Write-Output "--- EXIT CODE ---"
Write-Output $proc.ExitCode

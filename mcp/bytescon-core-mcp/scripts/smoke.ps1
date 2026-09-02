#!/usr/bin/env pwsh
<#
.SYNOPSIS
  Smoke test for bytescon-core-mcp. Exercises auth -> tools/list -> one
  tools/call per tool -> audit-write end-to-end via JSON-RPC over stdio.

.DESCRIPTION
  Spawns `node dist/server.js` as a child process, drives the MCP
  handshake, calls all four tools (list_deliverables, get_billing_status,
  get_usage_summary, list_users), prints raw JSON-RPC responses and
  captured stderr. Re-runnable in a few seconds.

  NOTE: the token must be tier PRO or VAULT; the server exits non-zero on
  a CORE token (server-wide minimum tier gate).

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

function Read-Response($label, $timeoutMs = 5000) {
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
        name      = "list_deliverables"
        arguments = @{ limit = 3 }
    }
}
Read-Response "LIST_DELIVERABLES RESPONSE" 10000

Send-Json @{
    jsonrpc = "2.0"; id = 4; method = "tools/call"
    params  = @{
        name      = "get_billing_status"
        arguments = @{}
    }
}
Read-Response "GET_BILLING_STATUS RESPONSE" 10000

Send-Json @{
    jsonrpc = "2.0"; id = 5; method = "tools/call"
    params  = @{
        name      = "get_usage_summary"
        arguments = @{ window_days = 30 }
    }
}
Read-Response "GET_USAGE_SUMMARY RESPONSE" 10000

Send-Json @{
    jsonrpc = "2.0"; id = 6; method = "tools/call"
    params  = @{
        name      = "list_users"
        arguments = @{ limit = 5 }
    }
}
Read-Response "LIST_USERS RESPONSE" 10000

$proc.StandardInput.Close()
if (-not $proc.WaitForExit(2000)) { $proc.Kill() }

Write-Output ""
Write-Output "--- STDERR (server logs) ---"
Write-Output $stderrBuf.ToString()
Write-Output "--- EXIT CODE ---"
Write-Output $proc.ExitCode

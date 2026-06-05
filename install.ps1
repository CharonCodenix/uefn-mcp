param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallerArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Installer = Join-Path $RepoRoot "scripts\guided_install.mjs"

if (-not (Test-Path -LiteralPath $Installer)) {
  throw "Guided installer not found: $Installer"
}

Write-Host ""
Write-Host "Launching UEFN MCP guided installer..."
Write-Host ""

node $Installer @InstallerArgs

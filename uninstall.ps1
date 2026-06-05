param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$UninstallerArgs
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Uninstaller = Join-Path $RepoRoot "scripts\guided_uninstall.mjs"

if (-not (Test-Path -LiteralPath $Uninstaller)) {
  throw "Guided uninstaller not found: $Uninstaller"
}

Write-Host ""
Write-Host "Launching UEFN MCP guided uninstaller..."
Write-Host ""

node $Uninstaller @UninstallerArgs

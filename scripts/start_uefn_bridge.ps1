param(
  [string]$BridgeScript = (Join-Path (Split-Path $PSScriptRoot -Parent) "bridge\uefn_bridge.py")
)

if (-not (Test-Path -LiteralPath $BridgeScript)) {
  throw "Bridge script not found: $BridgeScript"
}

Set-Clipboard -Value "exec(open(r'$BridgeScript', encoding='utf-8').read())"
Write-Host "Copied the fallback UEFN Python bridge command to the clipboard."
Write-Host "Preferred path: install the plugin and click UEFN MCP Bridge > Start Bridge."
Write-Host "Fallback path: in UEFN, open the Python console or Output Log set to Python, paste, and press Enter."
Write-Host "Then ask Codex to call uefn_status."

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$nodeCommand = Get-Command node -ErrorAction Stop
$nodeExe = $nodeCommand.Source
$tsxCli = Join-Path $repoRoot 'node_modules\tsx\dist\cli.mjs'
$ensureServicesScript = Join-Path $repoRoot 'scripts\ensure-services.ts'

if (-not (Test-Path $tsxCli)) {
  throw "tsx CLI not found at $tsxCli"
}

if (-not (Test-Path $ensureServicesScript)) {
  throw "ensure-services.ts not found at $ensureServicesScript"
}

Start-Process -FilePath $nodeExe `
  -ArgumentList @($tsxCli, '--experimental-sqlite', $ensureServicesScript) `
  -WorkingDirectory $repoRoot `
  -WindowStyle Hidden

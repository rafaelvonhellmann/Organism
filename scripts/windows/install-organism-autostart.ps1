$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$startupDir = [Environment]::GetFolderPath('Startup')
$launcherName = 'Organism Local Bridge.vbs'
$launcherPath = Join-Path $startupDir $launcherName
$powershellScript = Join-Path $repoRoot 'scripts\windows\start-organism-services.ps1'

if (-not (Test-Path $powershellScript)) {
  throw "Startup target script not found at $powershellScript"
}

$escapedScript = $powershellScript.Replace('"', '""')
$vbs = @"
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$escapedScript""", 0, False
"@

Set-Content -Path $launcherPath -Value $vbs -Encoding ASCII
Write-Output "Installed quiet Organism autostart at $launcherPath"

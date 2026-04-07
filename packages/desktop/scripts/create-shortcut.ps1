# Create a desktop shortcut for Organism that launches minimized (hidden window)
# Run: powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1

$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [System.Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $DesktopPath "Organism.lnk"

# Find Electron executable
$ElectronPath = Join-Path $PSScriptRoot "..\node_modules\.bin\electron.cmd"
$AppRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = (Resolve-Path $ElectronPath).Path
$Shortcut.Arguments = "."
$Shortcut.WorkingDirectory = $AppRoot
$Shortcut.WindowStyle = 7  # 7 = minimized (starts hidden, tray only)
$Shortcut.Description = "Organism Dashboard"

# Use the app icon if it exists
$IconPath = Join-Path $AppRoot "assets\icon.ico"
if (Test-Path $IconPath) {
    $Shortcut.IconLocation = $IconPath
}

$Shortcut.Save()
Write-Host "Shortcut created at: $ShortcutPath"
Write-Host "Window style: minimized (starts to tray)"

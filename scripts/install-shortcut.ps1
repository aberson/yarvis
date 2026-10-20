# Creates (or refreshes) the "Yarvis" Desktop shortcut: runs scripts/launch.ps1 with no visible
# console of its own, using scripts/yarvis.ico. Run once:  powershell -File scripts\install-shortcut.ps1
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a no-BOM .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
$scripts = $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$link = Join-Path $desktop 'Yarvis.lnk'

$shell = New-Object -ComObject WScript.Shell
$s = $shell.CreateShortcut($link)
$s.TargetPath = Join-Path $PSHOME 'powershell.exe'
$s.Arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $scripts 'launch.ps1') + '"'
$s.WorkingDirectory = Split-Path -Parent $scripts
$s.IconLocation = (Join-Path $scripts 'yarvis.ico') + ',0'
$s.Description = 'Start Yarvis and open it in the browser'
$s.WindowStyle = 7
$s.Save()
Write-Output "created $link"

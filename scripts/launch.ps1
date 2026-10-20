# Yarvis desktop launcher: the target of the "Yarvis" Desktop shortcut (scripts/install-shortcut.ps1).
# - Already running (GET /api/health answers through the web port): just open the browser.
# - Otherwise: start `npm run dev` in its own minimized window titled "Yarvis", wait for health,
#   then open the browser. Closing that window stops Yarvis.
# Keep this file ASCII-only: Windows PowerShell 5.1 reads a no-BOM .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms

$repo = Split-Path -Parent $PSScriptRoot
$webPort = 5173
if ($env:YARVIS_WEB_PORT) { $webPort = [int]$env:YARVIS_WEB_PORT }
$url = "http://127.0.0.1:$webPort/"

function Show-Problem([string]$Text) {
    [void][System.Windows.Forms.MessageBox]::Show($Text, 'Yarvis')
    exit 1
}

function Test-Healthy {
    try {
        $r = Invoke-RestMethod -Uri ($url + 'api/health') -TimeoutSec 2
        return [bool]$r.ok
    } catch {
        return $false
    }
}

if (-not (Test-Healthy)) {
    $command = "`$Host.UI.RawUI.WindowTitle = 'Yarvis (close this window to stop)'; npm run dev"
    Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NoExit', '-Command', $command) `
        -WorkingDirectory $repo -WindowStyle Minimized | Out-Null
    $deadline = (Get-Date).AddSeconds(90)
    while (-not (Test-Healthy)) {
        if ((Get-Date) -gt $deadline) {
            Show-Problem ("Yarvis did not start within 90 seconds. Open the minimized 'Yarvis' window " +
                "on the taskbar to see why (a port already in use, or a missing npm install in " + $repo + ").")
        }
        Start-Sleep -Milliseconds 750
    }
}
Start-Process $url

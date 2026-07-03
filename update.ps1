# Update Local Spotify to the latest version (Windows).
# Your music, passwords, playlists, and history are untouched — the update
# only replaces app code (the download contains no music/ or data/ folders).
#
#   powershell -ExecutionPolicy Bypass -File update.ps1
#
# Stop the server (Ctrl-C) before running; start it again after.
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$branch = 'claude/local-spotify-clone-yfmoli'
$zipUrl = "https://github.com/fslb10/NewProject1/archive/refs/heads/$branch.zip"
$srcDir = "update-tmp\NewProject1-" + ($branch -replace '/', '-')

Write-Host "* Downloading latest version..."
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Invoke-WebRequest $zipUrl -OutFile update.zip

Write-Host "* Applying update..."
Expand-Archive update.zip -DestinationPath update-tmp -Force
Copy-Item "$srcDir\*" . -Recurse -Force
Remove-Item update.zip, update-tmp -Recurse -Force

Write-Host ""
Write-Host "Updated. Start the server again with:  node server.js"
Write-Host "(then hard-refresh the browser: Ctrl-F5)"

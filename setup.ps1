# One-shot setup for Local Spotify (Windows PowerShell).
#
#   .\setup.ps1            install + start on http://127.0.0.1:8888
#   .\setup.ps1 -Tunnel    also open a public HTTPS URL via Cloudflare Tunnel
#
# If scripts are blocked: powershell -ExecutionPolicy Bypass -File setup.ps1
param([switch]$Tunnel)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "* Local Spotify setup"

# ---- 1. Node.js 18+ ---------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host ""
  Write-Host "Node.js (v18+) is required and wasn't found. Install it, then re-run:"
  Write-Host "  winget install OpenJS.NodeJS.LTS     (or https://nodejs.org)"
  exit 1
}
$major = [int](node -p 'parseInt(process.versions.node)')
if ($major -lt 18) {
  Write-Host "Node $(node --version) found, but v18+ is required - update via https://nodejs.org"
  exit 1
}
Write-Host "  node     : $(node --version) ok"

# ---- 2. music ---------------------------------------------------------------
if (-not $env:MUSIC_DIR) { $env:MUSIC_DIR = Join-Path $PWD 'music' }
$hasFiles = (Test-Path $env:MUSIC_DIR) -and
            (Get-ChildItem $env:MUSIC_DIR -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First 1)
if (-not $hasFiles) {
  Write-Host "  music    : $env:MUSIC_DIR is empty - generating demo tracks"
  node tools/generate-samples.js $env:MUSIC_DIR | Out-Null
} else {
  Write-Host "  music    : using $env:MUSIC_DIR"
}

# ---- 3. passwords -----------------------------------------------------------
if (-not (Test-Path 'data/auth.json')) {
  node -e @"
const { Auth, generatePassword } = require('./lib/auth');
const auth = new Auth('./data');
const listener = generatePassword(), admin = generatePassword();
auth.setPassword('listener', listener);
auth.setPassword('admin', admin);
console.log('  passwords: generated - write these down, they are shown once');
console.log('             listener (share it) : ' + listener);
console.log('             admin    (keep it)  : ' + admin);
"@
} else {
  Write-Host "  passwords: already configured (reset with: node tools/set-password.js)"
}

# ---- 4. optional public tunnel ----------------------------------------------
if ($Tunnel) {
  $cfd = Get-Command cloudflared -ErrorAction SilentlyContinue
  if ($cfd) { $cfdPath = $cfd.Source }
  else {
    $cfdPath = Join-Path $PWD 'bin\cloudflared.exe'
    if (-not (Test-Path $cfdPath)) {
      New-Item -ItemType Directory -Force -Path 'bin' | Out-Null
      Write-Host "  tunnel   : downloading cloudflared..."
      Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cfdPath
    }
  }
  Write-Host "  tunnel   : starting (watch its window for the trycloudflare.com URL)"
  Start-Process -FilePath $cfdPath -ArgumentList 'tunnel','--url','http://127.0.0.1:8888','--no-autoupdate'
  $env:TRUST_PROXY = '1'
}

# ---- 5. run -------------------------------------------------------------------
Write-Host ""
Write-Host "Starting... open http://127.0.0.1:8888 (Ctrl-C stops the server)"
Write-Host ""
node server.js

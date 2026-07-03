#!/usr/bin/env sh
# One-shot setup for Local Spotify (macOS / Linux).
#
#   ./setup.sh             install + start on http://127.0.0.1:8888
#   ./setup.sh --tunnel    also open a public HTTPS URL via Cloudflare Tunnel
#
# Windows: run setup.ps1 in PowerShell instead.
set -e
cd "$(dirname "$0")"

echo "♫ Local Spotify setup"

# ---- 1. Node.js 18+ ---------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "Node.js (v18+) is required and wasn't found. Install it, then re-run:"
  echo "  macOS : brew install node        (or https://nodejs.org)"
  echo "  Linux : your package manager, or https://nodejs.org"
  exit 1
fi
NODE_MAJOR=$(node -p 'parseInt(process.versions.node)')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node $(node --version) found, but v18+ is required — update via https://nodejs.org"
  exit 1
fi
echo "  node     : $(node --version) ok"

# ---- 2. music ---------------------------------------------------------------
MUSIC_DIR="${MUSIC_DIR:-$PWD/music}"
if [ -z "$(find "$MUSIC_DIR" -type f -name '*.*' 2>/dev/null | head -n 1)" ]; then
  echo "  music    : $MUSIC_DIR is empty — generating demo tracks"
  node tools/generate-samples.js "$MUSIC_DIR" >/dev/null
else
  echo "  music    : using $MUSIC_DIR"
fi

# ---- 3. passwords -----------------------------------------------------------
if [ ! -f data/auth.json ]; then
  node -e "
    const { Auth, generatePassword } = require('./lib/auth');
    const auth = new Auth('./data');
    const listener = generatePassword(), admin = generatePassword();
    auth.setPassword('listener', listener);
    auth.setPassword('admin', admin);
    console.log('  passwords: generated — write these down, they are shown once');
    console.log('             listener (share it) : ' + listener);
    console.log('             admin    (keep it)  : ' + admin);
  "
else
  echo "  passwords: already configured (reset with: node tools/set-password.js)"
fi

# ---- 4. optional public tunnel ---------------------------------------------
if [ "$1" = "--tunnel" ]; then
  CFD=./bin/cloudflared
  if ! command -v cloudflared >/dev/null 2>&1 && [ ! -x "$CFD" ]; then
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    case "$ARCH" in x86_64) ARCH=amd64 ;; aarch64|arm64) ARCH=arm64 ;; esac
    mkdir -p bin
    echo "  tunnel   : downloading cloudflared ($OS/$ARCH)…"
    BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"
    if [ "$OS" = "darwin" ]; then
      curl -fsSL "$BASE/cloudflared-darwin-$ARCH.tgz" | tar -xz -C bin
    else
      curl -fsSL "$BASE/cloudflared-linux-$ARCH" -o "$CFD"
    fi
    chmod +x "$CFD"
  fi
  command -v cloudflared >/dev/null 2>&1 && CFD=cloudflared
  echo "  tunnel   : starting (public URL appears below in a few seconds)"
  "$CFD" tunnel --url http://127.0.0.1:8888 --no-autoupdate 2>&1 \
    | grep --line-buffered -o 'https://[a-z0-9-]*\.trycloudflare\.com' \
    | while read -r URL; do echo ""; echo "  ➜ public URL: $URL"; echo ""; done &
  export TRUST_PROXY=1
fi

# ---- 5. run ------------------------------------------------------------------
echo ""
echo "Starting… open http://127.0.0.1:8888 (Ctrl-C stops the server)"
echo ""
exec env MUSIC_DIR="$MUSIC_DIR" node server.js

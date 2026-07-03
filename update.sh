#!/usr/bin/env sh
# Update Local Spotify to the latest version (macOS / Linux).
# Your music, passwords, playlists, and history are untouched — the update
# only replaces app code (the download contains no music/ or data/ folders).
#
#   ./update.sh
#
# Stop the server (Ctrl-C) before running; start it again after.
set -e
cd "$(dirname "$0")"

BRANCH="claude/local-spotify-clone-yfmoli"
ZIP_URL="https://github.com/fslb10/NewProject1/archive/refs/heads/$BRANCH.zip"
SRC_DIR="update-tmp/NewProject1-$(echo "$BRANCH" | tr '/' '-')"

echo "♫ Downloading latest version…"
curl -fsSL "$ZIP_URL" -o update.zip

echo "♫ Applying update…"
rm -rf update-tmp
mkdir -p update-tmp
unzip -qo update.zip -d update-tmp
cp -R "$SRC_DIR"/. .
rm -rf update.zip update-tmp

echo ""
echo "Updated. Start the server again with:  node server.js"
echo "(then hard-refresh the browser: Ctrl-Shift-R)"

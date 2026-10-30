#!/usr/bin/env bash
# Builds dist/timetabs-<version>.zip from src/, ready to upload to the Chrome Web Store.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version=$(node -p "require('$root/src/manifest.json').version")
out="$root/dist/timetabs-$version.zip"

node "$root/scripts/verify.js"
mkdir -p "$root/dist"
rm -f "$out"
(cd "$root/src" && zip -qr -X "$out" . -x '.*' -x '*/.*')
echo "Built ${out#"$root"/} ($(du -h "$out" | cut -f1 | tr -d ' '))"

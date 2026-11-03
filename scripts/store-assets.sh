#!/usr/bin/env bash
# Builds Chrome Web Store listing images in store/ from docs/ screenshots and the 128px icon.
# Screenshots must be 1280x800 or 640x400; the small promo tile must be 440x280. macOS only (uses sips).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/store"
bg=1E1E2E  # Catppuccin Mocha base, matches the extension UI
mkdir -p "$out"

dims() { sips -g pixelWidth -g pixelHeight "$1" | awk '/pixel/ {printf "%s ", $2}'; }

fit() {  # fit <src> <dst> <width> <height>: scale to fit inside, then pad to the exact size
  read -r w h <<<"$(dims "$1")"
  read -r nw nh <<<"$(awk -v w="$w" -v h="$h" -v W="$3" -v H="$4" \
    'BEGIN { s = (W / w < H / h) ? W / w : H / h; if (s > 1) s = 1; printf "%d %d", w * s, h * s }')"
  sips -s format png --resampleHeightWidth "$nh" "$nw" "$1" --out "$2" >/dev/null
  sips --padToHeightWidth "$4" "$3" --padColor "$bg" "$2" >/dev/null 2>&1
}

fit "$root/docs/popup.png" "$out/screenshot-popup-640x400.png" 640 400
fit "$root/docs/alert.png" "$out/screenshot-alert-640x400.png" 640 400
fit "$root/src/icons/icon-128.png" "$out/promo-small-440x280.png" 440 280

for f in "$out"/*.png; do
  echo "${f#"$root"/}: $(dims "$f")"
done

#!/usr/bin/env bash
# Uploads a packaged zip to the Chrome Web Store and submits it for review (Chrome Web Store API v2).
# Usage: scripts/publish.sh dist/timetabs-<version>.zip [--upload-only]
# Env: CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID, CWS_EXTENSION_ID
set -euo pipefail

zip="${1:?usage: publish.sh <zip> [--upload-only]}"
upload_only="${2:-}"
for v in CWS_CLIENT_ID CWS_CLIENT_SECRET CWS_REFRESH_TOKEN CWS_PUBLISHER_ID CWS_EXTENSION_ID; do
  [[ -n "${!v:-}" ]] || { echo "missing env $v" >&2; exit 1; }
done

api="https://chromewebstore.googleapis.com"
item="publishers/$CWS_PUBLISHER_ID/items/$CWS_EXTENSION_ID"
field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.argv[1]];console.log(v??"")})' "$1"; }

token=$(curl -sS --fail-with-body https://oauth2.googleapis.com/token \
  -d grant_type=refresh_token \
  --data-urlencode "client_id=$CWS_CLIENT_ID" \
  --data-urlencode "client_secret=$CWS_CLIENT_SECRET" \
  --data-urlencode "refresh_token=$CWS_REFRESH_TOKEN" | field access_token)
[[ -n "$token" ]] || { echo "could not get an access token" >&2; exit 1; }
[[ -n "${GITHUB_ACTIONS:-}" ]] && echo "::add-mask::$token"
auth=(-H "Authorization: Bearer $token")

echo "Uploading $zip…"
res=$(curl -sS --fail-with-body -X POST "${auth[@]}" -T "$zip" "$api/upload/v2/$item:upload")
echo "$res"
state=$(field uploadState <<<"$res")

for _ in $(seq 1 30); do
  case "$state" in
    SUCCEEDED) break ;;
    IN_PROGRESS|UPLOAD_IN_PROGRESS)
      sleep 10
      res=$(curl -sS --fail-with-body "${auth[@]}" "$api/v2/$item:fetchStatus")
      state=$(field lastAsyncUploadState <<<"$res") ;;
    *) echo "upload failed: $res" >&2; exit 1 ;;
  esac
done
[[ "$state" == SUCCEEDED ]] || { echo "upload still $state after 5 minutes" >&2; exit 1; }
echo "Upload succeeded."

if [[ "$upload_only" == --upload-only ]]; then
  echo "Skipping publish (--upload-only). The draft is waiting in the Developer Dashboard."
  exit 0
fi

echo "Submitting for review…"
curl -sS --fail-with-body -X POST "${auth[@]}" -H "Content-Type: application/json" -d '{}' "$api/v2/$item:publish"
echo

#!/usr/bin/env bash
set -euo pipefail

ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
[ -x "$ADB" ] || { echo "adb not found at $ADB"; exit 1; }

# Parse tab-delimited, not whitespace-delimited: a wireless-debugging transport
# name can contain a space (e.g. "adb-SERIAL-xxxx (2)._adb-tls-connect._tcp"),
# which a whitespace split would mangle into a nonexistent device id.
DEVICES=$("$ADB" devices | awk -F'\t' 'NR>1 && $2=="device" {print $1}')

if [ -z "$DEVICES" ]; then
  echo "No authorised Android device found."
  echo
  echo "  1. Settings > About phone > tap 'Build number' seven times"
  echo "  2. Settings > System > Developer options > enable USB debugging"
  echo "     (or Wireless debugging, then: adb pair <host:port>)"
  echo "  3. Connect, and accept the 'Allow debugging' prompt on the phone"
  echo
  "$ADB" devices -l
  exit 1
fi

# One phone can appear more than once - e.g. wireless debugging registers both an
# IP transport and an mDNS one. Deduplicate by hardware serial so a single phone
# is configured once and reported once.
declare -a SEEN_SERIALS=()
declare -a TARGETS=()

while IFS= read -r d; do
  [ -n "$d" ] || continue
  serial=$("$ADB" -s "$d" shell getprop ro.serialno 2>/dev/null | tr -d '\r\n')
  [ -n "$serial" ] || serial="$d"
  duplicate=""
  for s in ${SEEN_SERIALS[@]+"${SEEN_SERIALS[@]}"}; do
    [ "$s" = "$serial" ] && duplicate=1 && break
  done
  [ -n "$duplicate" ] && continue
  SEEN_SERIALS+=("$serial")
  TARGETS+=("$d")
done <<< "$DEVICES"

for d in ${TARGETS[@]+"${TARGETS[@]}"}; do
  "$ADB" -s "$d" reverse tcp:3000 tcp:3000
  "$ADB" -s "$d" reverse tcp:8081 tcp:8081
  # MinIO. NOT optional: the API signs item image URLs against S3_PUBLIC_URL,
  # which is http://localhost:9000 in development, and the phone resolves that
  # to ITSELF. Without this reverse every garment photo in the app is a blank
  # tile -- the category badge, the colour dots and the laundry badge all
  # render, so the screen looks populated and only the images are missing,
  # which reads as a broken image pipeline rather than a missing port.
  # Found during the Stage 7 device gate; before this line, no device run in
  # this project could display an item photograph fetched from storage.
  "$ADB" -s "$d" reverse tcp:9000 tcp:9000
  model=$("$ADB" -s "$d" shell getprop ro.product.model 2>/dev/null | tr -d '\r\n')
  echo "${model:-device} ready ($d): localhost:3000 -> API, localhost:8081 -> Metro, localhost:9000 -> MinIO"
done

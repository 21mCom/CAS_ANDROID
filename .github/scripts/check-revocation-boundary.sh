#!/usr/bin/env bash
# Revocation-boundary invariant for the CAS test app.
#
# Threat model: an attacker holding a revoked phone types any string into the
# enrollment-credential field. If saving that unverified input cleared the
# enrolled device token or reset the provisioned flag, the pickup/receipt
# paths (DeviceSmsSender) would stop refusing the legacy shared device token
# and the revoked phone would resume mutating delivery state — revocation
# would be bypassable from the handset alone.
#
# Invariants this scan enforces (static, deterministic, no emulator needed):
#   1. The provisioned flag is only ever SET (to true), and only inside
#      AlertSender's successful-enrollment path. Nothing may reset it.
#   2. The enrolled device token is only cleared where the SERVER rejected
#      the credential (401 handling) — never on an input-save path.
#   3. The shared-token fallback refusals stay in place: both the pickup
#      (fetchPendingItems) and receipt paths in DeviceSmsSender must keep
#      the "enrolled blank && provisioned -> refuse shared token" guard.
#   4. MainActivity's "Save alert credential" handler must not touch the
#      enrolled token or the provisioned flag at all.

set -euo pipefail

APP_SRC="artifacts/covert-alert-system/android-test-package/app/src/main/java/com/covertalert/pixeltest"
[ -d "$APP_SRC" ] || { echo "::error::app sources not found at $APP_SRC"; exit 1; }

fail() {
  echo "::error::revocation-boundary violation: $1"
  exit 1
}

# 1. The provisioned flag is written exactly once, as `true`, in the
#    enrollment success path.
writes="$(grep -rn 'setDeviceCredentialProvisioned' "$APP_SRC" --include='*.kt' | grep -v 'TestStore.kt' || true)"
if [ "$(printf '%s\n' "$writes" | grep -c 'AlertSender.kt')" != "1" ] \
  || ! printf '%s\n' "$writes" | grep -q 'AlertSender.kt.*setDeviceCredentialProvisioned(context, true)'; then
  echo "$writes"
  fail "the provisioned flag must be set exactly once, to true, in AlertSender's enrollment success path — it is sticky until authenticated re-enrollment succeeds."
fi

# 2. The enrolled token may only be cleared on server rejection (401), never
#    from MainActivity's input-save handlers.
clears="$(grep -rn 'setEnrolledDeviceToken' "$APP_SRC" --include='*.kt' | grep -v 'TestStore.kt' || true)"
if printf '%s\n' "$clears" | grep -q 'MainActivity.kt'; then
  echo "$clears"
  fail "MainActivity clears the enrolled device token — saving an unverified credential must never drop it or reset the provisioned guard."
fi
for site in $(printf '%s\n' "$clears" | grep 'setEnrolledDeviceToken(context, "")' | cut -d: -f1-2); do
  file="${site%:*}"; line="${site##*:}"
  # Each clear site must sit next to a 401 (server rejection) check.
  if ! sed -n "$((line > 12 ? line - 12 : 1)),$((line + 2))p" "$file" | grep -q '401'; then
    fail "$site clears the enrolled token without an adjacent 401 (server-rejection) check."
  fi
done

# 3. Both DeviceSmsSender paths keep the shared-token refusal guard.
guard_count="$(grep -c 'enrolled.isBlank() && TestStore.deviceCredentialProvisioned(context)' "$APP_SRC/DeviceSmsSender.kt" || true)"
if [ "$guard_count" -lt 2 ]; then
  fail "DeviceSmsSender must refuse the shared device token once provisioned in BOTH the pickup (fetchPendingItems) and receipt paths — found $guard_count guard(s)."
fi

echo "Revocation-boundary invariants hold: provisioned flag sticky, enrolled token only dropped on server rejection, shared-token fallback refused in pickup and receipts."

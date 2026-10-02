#!/usr/bin/env bash
# Silent-channel invariant for the CAS test app.
#
# Threat model: an attacker may be holding the phone while an alert fires.
# Anything that flashes another app's UI on screen (the retired WhatsApp
# tap-to-send handoff did exactly that) escalates the situation. So no alert
# path on the device may start a visible activity besides the configured
# cover app, and no alert code may reference a third-party messaging app.
# Device-side delivery is SMS (invisible to the user, no UI) plus the data
# POST; every other channel fans out server-side through the outbox worker.
# The same rule covers evidence capture: bounded audio/photo/video clips are
# recorded by a preview-free foreground service — never by launching the
# camera app or showing a preview — so the only on-screen trace is the
# owner-accepted OS recording indicator.
#
# One sanctioned exception, outside every alert path: the one-tap self-update
# flow (UpdateInstallReceiver) may surface the SYSTEM'S OWN PackageInstaller
# confirmation when the owner taps Download & install — Android requires that
# prompt for sideloaded updates; the app never starts an app-chosen activity.
#
# This script fails the build if any of that creeps back in. It is a static
# scan of the app sources — deterministic, no emulator needed.

set -euo pipefail

APP_SRC="artifacts/covert-alert-system/android-test-package/app/src"
[ -d "$APP_SRC" ] || { echo "::error::app sources not found at $APP_SRC"; exit 1; }

fail() {
  echo "::error::silent-channel violation: $1"
  exit 1
}

# 1. No WhatsApp (or other handoff-messenger) references anywhere in app
#    sources — code, comments, or resources. The channel is server-side now;
#    even a stray deep-link helper is a regression waiting to be wired up.
if grep -rniE 'whats\s?app|wa\.me|api\.whatsapp\.com' "$APP_SRC"; then
  fail "WhatsApp reference found in app sources — the on-screen handoff was removed; WhatsApp delivery is server-side via CAS_WHATSAPP_PROVIDER_URL."
fi

# 2. No intent primitives that can surface a third-party UI: VIEW/SEND/SENDTO
#    actions or pinning an intent to a specific package.
if grep -rnE 'ACTION_VIEW|ACTION_SEND|ACTION_SENDTO|setPackage\(' "$APP_SRC" --include='*.kt' --include='*.xml' --include='*.java'; then
  fail "third-party UI intent primitive (ACTION_VIEW/ACTION_SEND/setPackage) found in app sources."
fi

# 3. startActivity is allow-listed to exactly three sites:
#      - TriggerActivity.kt: launches the configured cover app (the one
#        permitted visible surface, and it is operator-chosen, never
#        alert-shaped).
#      - MainActivity.kt: starts its own internal proxy activity
#        (IntentFactory.proxy()), which is part of this app, not a
#        third-party UI.
#      - UpdateInstallReceiver.kt: starts ONLY the system's own install
#        confirmation that PackageInstaller hands back as EXTRA_INTENT (the
#        sanctioned one-tap update prompt; no app-chosen activity, and the
#        flow begins at the operator's explicit Download & install tap).
violations="$(grep -rn 'startActivity' "$APP_SRC" --include='*.kt' --include='*.java' \
  | grep -v 'TriggerActivity.kt' \
  | grep -v 'MainActivity.kt.*IntentFactory\.proxy(' \
  | grep -v 'UpdateInstallReceiver.kt' || true)"
if [ -n "$violations" ]; then
  echo "$violations"
  fail "startActivity outside the allow-listed sites (TriggerActivity cover launch, MainActivity internal proxy, UpdateInstallReceiver system install confirmation)."
fi

# The receiver's one sanctioned surface: every startActivity in it must be the
# PackageInstaller confirmation handoff (the EXTRA_INTENT the OS fills in),
# never an app-chosen intent.
receiver="$APP_SRC/main/java/com/covertalert/pixeltest/UpdateInstallReceiver.kt"
if [ -f "$receiver" ] \
  && grep -n 'startActivity' "$receiver" | grep -v 'startActivity(confirm)'; then
  fail "UpdateInstallReceiver starts an activity other than the system's own install confirmation (EXTRA_INTENT)."
fi

# MainActivity may only start the internal proxy — no other startActivity call.
if grep -n 'startActivity' "$APP_SRC/main/java/com/covertalert/pixeltest/MainActivity.kt" \
  | grep -v 'IntentFactory\.proxy('; then
  fail "MainActivity starts an activity other than its own internal proxy (IntentFactory.proxy(...))."
fi

# 4. No manifest may declare visibility of specific third-party packages.
#    The MAIN/LAUNCHER intent query (cover-app picker) is fine; named
#    <package> queries exist only to hand off to another app.
while IFS= read -r manifest; do
  if grep -n '<package android:name=' "$manifest"; then
    fail "$manifest declares visibility of a specific third-party package — alert paths must not query or launch other apps."
  fi
done < <(find "$APP_SRC" -name AndroidManifest.xml)

# 5. Evidence capture never surfaces camera UI: no MediaStore capture intents
#    (which open the stock camera app in the attacker's hands) and no preview
#    surfaces — bounded capture runs preview-free in the foreground service,
#    and the only on-screen trace is the owner-accepted OS indicator.
if grep -rnE 'ACTION_IMAGE_CAPTURE|ACTION_VIDEO_CAPTURE|ACTION_VIDEO_CAMERA|MediaStore\.ACTION|SurfaceView|TextureView|PreviewView' "$APP_SRC" --include='*.kt' --include='*.java' --include='*.xml'; then
  fail "on-screen camera primitive found — evidence capture must run in the preview-free foreground service, never the camera app UI or a preview surface."
fi

echo "silent-channel check passed: no alert path can surface a third-party UI, and evidence capture stays preview-free."

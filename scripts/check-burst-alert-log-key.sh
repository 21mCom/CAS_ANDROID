#!/usr/bin/env bash
set -euo pipefail

# CI/dev-only drift gate: prove the self-hosting runbook's credential-burst
# alerting recipe still matches the log line the server actually emits.
#
# artifacts/api-server/SELF-HOSTING.md Step 10 tells the operator to grep the
# service journal for a literal string, and defaultBurstRecorder in
# artifacts/api-server/src/lib/cas-auth.ts emits the structured warn line that
# grep is meant to catch. Nothing else ties the two together: renaming the log
# key in code (or editing the runbook's match string) compiles and reads fine,
# and the operator finds out the day a real probing attack goes unalerted.
# This script closes the gap in BOTH directions without hardcoding the key
# here (a hardcoded copy would just be a third place to drift):
#
#   1. The watchdog script the runbook installs (cas-burst-watch.sh — the
#      alert that actually pages the operator) must grep for EXACTLY the burst
#      key cas-auth.ts emits. The separate manual diagnostic command in the
#      same section cannot satisfy this check.
#   2. Every grep match string in the runbook's Step 10 section must appear in
#      cas-auth.ts, and the emitted burst message must still be quoted there —
#      the recipe may not match on a string the code never emits.
#
# Deliberate one-sided edits on either side must turn this check red; the
# api-server-tests workflow proves both directions with negative steps.
#
# Usage: scripts/check-burst-alert-log-key.sh
# Prints: BURST_ALERT_LOG_KEY_OK key=<key> patterns=<n>
# On drift: BURST_ALERT_LOG_KEY_FAILED naming the disagreeing side, exit 1.

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly RUNBOOK="$REPO_ROOT/artifacts/api-server/SELF-HOSTING.md"
readonly EMITTING_CODE="$REPO_ROOT/artifacts/api-server/src/lib/cas-auth.ts"

[[ -f "$RUNBOOK" ]] || { echo "Runbook not found: $RUNBOOK" >&2; exit 2; }
[[ -f "$EMITTING_CODE" ]] || { echo "Emitting code not found: $EMITTING_CODE" >&2; exit 2; }

fail() {
    echo "BURST_ALERT_LOG_KEY_FAILED: $1" >&2
    echo "The runbook's Step 10 burst-alert recipe and the burst log line in cas-auth.ts must change together." >&2
    exit 1
}

# --- The runbook side: Step 10 only -----------------------------------------
# Isolate the Step 10 section (from its heading to the next level-2 heading)
# so greps elsewhere in the runbook cannot satisfy or pollute the check.
step10="$(sed -n '/^## Step 10 /,/^## /p' "$RUNBOOK" | sed '$d')"
[[ -n "$step10" ]] || { echo "Could not isolate the Step 10 section in $RUNBOOK" >&2; exit 2; }

# The alert that actually pages the operator is the watchdog script installed
# by the heredoc (`sudo tee /usr/local/sbin/cas-burst-watch.sh ... EOF`), not
# any grep anywhere in the section. Isolate that block first: a drifted or
# deleted watchdog grep must fail even while the separate manual diagnostic
# command further down still matches the emitted key.
watchdog="$(sed -n '/sudo tee \/usr\/local\/sbin\/cas-burst-watch\.sh/,/^ *EOF/p' <<<"$step10")"
[[ -n "$watchdog" ]] || fail "Step 10 no longer installs the cas-burst-watch.sh watchdog script; the burst alert itself is gone."

mapfile -t watchdog_patterns < <(grep -oE "grep '[A-Za-z0-9_.-]+'" <<<"$watchdog" \
    | sed -E "s/^grep '//; s/'\$//" \
    | sort -u)
((${#watchdog_patterns[@]} == 1)) || fail "expected exactly one quoted grep match string in the watchdog script, found ${#watchdog_patterns[@]} — the alert's match string is missing, rewritten in an unrecognized shape, or ambiguous."
watchdog_pattern="${watchdog_patterns[0]}"

# The section's OTHER grep match strings (the manual proof command) are also
# checked against the code, but they can never satisfy the watchdog check
# above. Recognized forms: `grep 'KEY'` and a pipe ending in `| grep KEY` at
# end of line. Prose mentions of grep ("lets grep exit on the first match")
# and flag forms (`grep -q KEY`) are deliberately NOT recognized: a recipe
# rewritten in another shape fails the gate closed instead of silently
# matching the wrong string.
mapfile -t patterns < <({
    grep -oE "grep '[A-Za-z0-9_.-]+'" <<<"$step10" | sed -E "s/^grep '//; s/'\$//"
    grep -oE '\| grep [A-Za-z0-9_.-]+$' <<<"$step10" | sed -E 's/^\| grep //'
} | sort -u)
((${#patterns[@]} > 0)) || fail "Step 10 contains no grep match string; the burst-alert recipe is gone or no longer greps."

# --- The code side: the emitted burst line ----------------------------------
# defaultBurstRecorder emits `logger.warn({ <key>: burst }, "<message>")`.
# Extract both halves from the emitting call; a missing line means the burst
# record is no longer emitted at all, which is exactly the broken-alert case
# this gate exists for, so that is a drift failure (exit 1), not setup breakage.
mapfile -t code_keys < <(sed -n 's/.*logger\.warn({ *\([A-Za-z0-9_]*\) *: *burst *}.*$/\1/p' "$EMITTING_CODE")
mapfile -t code_messages < <(sed -n 's/.*logger\.warn({[^}]*: *burst *}, *"\([^"]*\)".*$/\1/p' "$EMITTING_CODE")

((${#code_keys[@]} == 1)) || fail "expected exactly one burst logger.warn({ <key>: burst }, ...) line in cas-auth.ts, found ${#code_keys[@]} — the burst record is renamed, reshaped, or gone."
((${#code_messages[@]} == 1)) || fail "expected exactly one burst logger.warn message in cas-auth.ts, found ${#code_messages[@]}."
code_key="${code_keys[0]}"
code_message="${code_messages[0]}"

# --- Direction 1: every runbook match string must be emitted by the code ----
for pattern in "${patterns[@]}"; do
    grep -qF -- "$pattern" "$EMITTING_CODE" \
        || fail "Step 10 greps for '$pattern', which never appears in cas-auth.ts — the operator's alert can never fire."
done

# --- Direction 2: the watchdog must grep for exactly the emitted key --------
# Direct equality, not membership in the section's pattern set: the manual
# diagnostic grep further down must not be able to satisfy the alert check
# while the watchdog itself matches a string the server never emits.
[[ "$watchdog_pattern" == "$code_key" ]] \
    || fail "the watchdog greps for '$watchdog_pattern' but cas-auth.ts emits the burst key '$code_key' — the operator's alert can never fire."

grep -qF -- "$code_message" <<<"$step10" \
    || fail "cas-auth.ts emits the burst message \"$code_message\", which no longer appears in Step 10 — the sample log line is stale."

echo "BURST_ALERT_LOG_KEY_OK key=$code_key patterns=${#patterns[@]}"

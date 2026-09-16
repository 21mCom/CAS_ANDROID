#!/usr/bin/env bash
set -euo pipefail

# CI/dev-only parity check: prove the two tool-requirements.json validators
# accept and reject the SAME set of declarations.
#
# The kit carries two independent validators over the same declaration file:
#
#   - Get-ToolRequirements in scripts/cas-tool-requirements.ps1, the shared
#     PowerShell parser dot-sourced by every Windows entry point;
#   - load_pinned_device_constants in scripts/measure-gate0a.sh, the Gate 0A
#     Bash harness's own parse-and-validate.
#
# If the two drift apart (one accepts a missing jdk section or a platform /
# apiLevel mismatch the other rejects), a kit could pass on the Windows
# workstation and fail in the field harness, or vice versa. This script runs a
# shared fixture set (scripts/fixtures/tool-requirements-parity/) through BOTH
# validators and fails unless every fixture's verdict matches its expectation —
# which means the two sides agree with each other. A deliberate one-sided
# behavior change must turn this check red; the windows-test-kit-entrypoints
# workflow proves that with a negative step.
#
# This script is deliberately NOT part of the packaged field kit (like
# generate-gate0a-hardware-report-fixture.sh): it runs the validators from a
# kit root passed with --kit-root, so CI points it at the packaged ZIP the
# field actually receives.
#
# The Bash validator intentionally supports only the kit's canonical
# one-field-per-line declaration shape (see its own comment); every fixture
# uses that shape, so "invalid" fixtures are invalid in ways both validators
# are expected to catch.
#
# Usage: scripts/check-tool-requirements-parity.sh [--kit-root DIR]
# Prints: TOOLREQ_PARITY_OK fixtures=<n> kit=<dir>

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly FIXTURE_DIR="$REPO_ROOT/scripts/fixtures/tool-requirements-parity"

KIT_ROOT="$REPO_ROOT/artifacts/covert-alert-system/android-test-package"
while (($#)); do
    case "$1" in
        --kit-root)
            (($# >= 2)) || { echo "--kit-root requires a directory" >&2; exit 2; }
            KIT_ROOT="$2"
            shift
            ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

readonly PS_PARSER="$KIT_ROOT/scripts/cas-tool-requirements.ps1"
readonly BASH_HARNESS="$KIT_ROOT/scripts/measure-gate0a.sh"
[[ -f "$PS_PARSER" ]] || { echo "PowerShell parser not found: $PS_PARSER" >&2; exit 2; }
[[ -f "$BASH_HARNESS" ]] || { echo "Bash harness not found: $BASH_HARNESS" >&2; exit 2; }
[[ -d "$FIXTURE_DIR" ]] || { echo "Fixture directory not found: $FIXTURE_DIR" >&2; exit 2; }

# name|expected verdict (accept|reject); an empty name means "declaration file
# is missing", which both validators must reject without a fixture on disk.
readonly FIXTURES=(
    "valid.json|accept"
    "invalid-json.json|reject"
    "platform-mismatch.json|reject"
    "missing-jdk.json|reject"
    "missing-androidsdk.json|reject"
    "apilevel-zero.json|reject"
    "jdk-zero.json|reject"
    "buildtools-not-version.json|reject"
    "|reject"
)
readonly MISSING_FILE_PATH="$FIXTURE_DIR/no-such-declaration.json"
[[ ! -e "$MISSING_FILE_PATH" ]] || { echo "Test setup broken: $MISSING_FILE_PATH must not exist" >&2; exit 2; }

# ---------------------------------------------------------------------------
# PowerShell side: one pwsh/powershell.exe invocation evaluates every fixture
# through the kit's own Get-ToolRequirements and prints one ACCEPT/REJECT line
# per fixture, in order.
# ---------------------------------------------------------------------------
PWSH_BIN="${PARITY_PWSH:-}"
if [[ -z "$PWSH_BIN" ]]; then
    if command -v pwsh >/dev/null 2>&1; then
        PWSH_BIN="pwsh"
    elif command -v powershell.exe >/dev/null 2>&1; then
        PWSH_BIN="powershell.exe"
    else
        echo "Neither pwsh nor powershell.exe is available; the PowerShell validator cannot be exercised." >&2
        exit 2
    fi
fi

# Windows PowerShell cannot read MSYS /c/... paths; convert when cygpath
# exists (Git Bash on the CI runner). Locally (Linux pwsh) paths pass through.
to_ps_path() {
    if command -v cygpath >/dev/null 2>&1; then
        cygpath -w "$1"
    else
        printf '%s\n' "$1"
    fi
}

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PS_LIST_FILE="$WORK_DIR/fixtures.txt"
: > "$PS_LIST_FILE"
BASH_FIXTURE_PATHS=()
FIXTURE_NAMES=()
FIXTURE_EXPECTED=()
for entry in "${FIXTURES[@]}"; do
    name="${entry%%|*}"
    expected="${entry#*|}"
    if [[ -n "$name" ]]; then
        fixture_path="$FIXTURE_DIR/$name"
        [[ -f "$fixture_path" ]] || { echo "Fixture listed but missing on disk: $fixture_path" >&2; exit 2; }
        label="$name"
    else
        fixture_path="$MISSING_FILE_PATH"
        label="(missing declaration file)"
    fi
    FIXTURE_NAMES+=("$label")
    FIXTURE_EXPECTED+=("$expected")
    BASH_FIXTURE_PATHS+=("$fixture_path")
    printf '%s\n' "$(to_ps_path "$fixture_path")" >> "$PS_LIST_FILE"
done

PS_DRIVER="$WORK_DIR/parity-driver.ps1"
cat > "$PS_DRIVER" <<'PS1'
param([string]$ParserPath, [string]$ListFile)
$ErrorActionPreference = 'Stop'
. $ParserPath
Get-Content -LiteralPath $ListFile | ForEach-Object {
    $result = Get-ToolRequirements -Path $_
    if ($null -eq $result) { Write-Output 'REJECT' } else { Write-Output 'ACCEPT' }
}
PS1

set +e
ps_output="$("$PWSH_BIN" -NoLogo -NoProfile -NonInteractive -File "$(to_ps_path "$PS_DRIVER")" \
    -ParserPath "$(to_ps_path "$PS_PARSER")" -ListFile "$(to_ps_path "$PS_LIST_FILE")" 2>&1)"
ps_code=$?
set -e
printf '%s\n' "$ps_output"
if [[ $ps_code -ne 0 ]]; then
    echo "The PowerShell validator run failed outright (exit $ps_code)." >&2
    exit 1
fi

mapfile -t PS_VERDICTS < <(printf '%s\n' "$ps_output" | tr -d '\r' | grep -E '^(ACCEPT|REJECT)$' || true)
if ((${#PS_VERDICTS[@]} != ${#FIXTURES[@]})); then
    echo "The PowerShell validator produced ${#PS_VERDICTS[@]} verdict(s) for ${#FIXTURES[@]} fixture(s); the driver or parser is broken." >&2
    exit 1
fi

# ---------------------------------------------------------------------------
# Bash side: source the harness's own load_pinned_device_constants (extracted
# the way generate-gate0a-hardware-report-fixture.sh extracts write_report)
# and run it against every fixture. Exit 0 = accept, exit 2 = reject; any
# other exit is a harness bug, not a verdict.
# ---------------------------------------------------------------------------
EXTRACTED="$WORK_DIR/load_pinned_device_constants.sh"
sed -n '/^load_pinned_device_constants() {$/,/^}$/p' "$BASH_HARNESS" > "$EXTRACTED"
grep -q '^load_pinned_device_constants() {$' "$EXTRACTED" || { echo "Failed to extract load_pinned_device_constants() from $BASH_HARNESS" >&2; exit 1; }
bash -n "$EXTRACTED" || { echo "Extracted load_pinned_device_constants() has a syntax error" >&2; exit 1; }

bash_verdict() {
    local fixture="$1"
    (
        set -euo pipefail
        TOOL_REQUIREMENTS_JSON="$fixture"
        die() { exit 2; }
        PINNED_AVD=""
        EMULATOR_API=""
        MIN_PHYSICAL_API=""
        # shellcheck disable=SC1090
        source "$EXTRACTED"
        load_pinned_device_constants
    ) >/dev/null 2>&1
    local code=$?
    case "$code" in
        0) printf 'ACCEPT' ;;
        2) printf 'REJECT' ;;
        *)
            printf 'ERROR(exit %s)' "$code"
            ;;
    esac
}

# set -e interacts with command substitution in bash_verdict's callers; the
# subshell's non-zero exits must be captured, so guard the whole call.
run_bash_verdict() {
    set +e
    local verdict
    verdict="$(bash_verdict "$1")"
    set -e
    printf '%s' "$verdict"
}

# ---------------------------------------------------------------------------
# Compare: every fixture must match its expectation on BOTH sides.
# ---------------------------------------------------------------------------
echo "tool-requirements validator parity (kit: $KIT_ROOT)"
failures=0
for ((i = 0; i < ${#FIXTURES[@]}; i++)); do
    name="${FIXTURE_NAMES[$i]}"
    expected="${FIXTURE_EXPECTED[$i]}"
    ps_verdict="${PS_VERDICTS[$i]}"
    bash_side="$(run_bash_verdict "${BASH_FIXTURE_PATHS[$i]}")"
    expected_upper="${expected^^}"
    if [[ "$ps_verdict" == "$expected_upper" && "$bash_side" == "$expected_upper" ]]; then
        printf '  OK       %s: expected=%s powershell=%s bash=%s\n' "$name" "$expected" "$ps_verdict" "$bash_side"
    else
        printf '  MISMATCH %s: expected=%s powershell=%s bash=%s\n' "$name" "$expected" "$ps_verdict" "$bash_side"
        failures=$((failures + 1))
    fi
done

if ((failures > 0)); then
    echo "TOOLREQ_PARITY_FAILED: $failures of ${#FIXTURES[@]} fixture(s) disagree; the PowerShell parser and the Bash harness no longer validate tool-requirements.json identically." >&2
    exit 1
fi
echo "TOOLREQ_PARITY_OK fixtures=${#FIXTURES[@]} kit=$KIT_ROOT"

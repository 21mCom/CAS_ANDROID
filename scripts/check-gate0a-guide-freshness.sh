#!/usr/bin/env bash
set -euo pipefail

# CI/dev-only freshness check: prove the committed Gate 0A run-guide PDF still
# matches its generator source.
#
# package-mvp-handoff.ps1 ships the committed
# artifacts/covert-alert-system/public/gate0a-run-guide.pdf, and the
# mvp-handoff-freshness job proves the handoff ZIP matches that committed PDF —
# but nothing else proves the committed PDF still matches
# artifacts/covert-alert-system/scripts/generate-gate0a-guide-readable.mjs.
# Editing the generator (or the guide markup inside it) without regenerating
# leaves a stale guide in every future handoff while the freshness gate stays
# green. This script closes that gap: it regenerates the guide to a scratch
# file and compares RENDERED CONTENT (page count plus per-page extracted text)
# against the committed PDF.
#
# PDF bytes are not deterministic across Chromium runs (creation timestamps,
# object IDs), so the comparison deliberately never looks at bytes. It
# compares two canonical renderings of each page instead:
#
#   1. Extracted text (pdftotext, whitespace collapsed) — catches content and
#      wording drift, including pagination shifts that move text across pages.
#   2. Rendered pixels (pdftoppm at a fixed DPI, compared channel-by-channel
#      with a small tolerance) — catches visual drift that leaves the text
#      layer untouched: safety-significant colors, borders, backgrounds, font
#      sizing, and layout geometry.
#
# A pagination regression (content spilling onto an extra page) changes the
# page count, the per-page text, AND the rendered pixels, so every drift
# class turns this check red. Deliberate source edits without regeneration —
# both a text edit and a CSS-only color change — must turn this check red;
# the windows-test-kit-entrypoints workflow proves both with negative steps.
#
# Requirements: node, python3 (stdlib only), pdftotext/pdfinfo/pdftoppm
# (poppler-utils), and a Chromium/Chrome binary. The binary is resolved from
# $CHROMIUM_PATH, then the Replit default /repl/tools/bin/chromium, then
# google-chrome / chromium on PATH — the same override the generator itself
# honors. Both PDFs are rasterized by the SAME pdftoppm in one run, and the
# guide's fonts are subset-embedded in the PDF, so identical content renders
# pixel-identically; the tolerance below only absorbs residual anti-aliasing
# noise. CI installs fonts-liberation (metric-compatible with the guide's
# Arial/Helvetica stack) so the fresh regeneration lays out identically to
# the committed PDF.
#
# Usage: scripts/check-gate0a-guide-freshness.sh
# Prints: GATE0A_GUIDE_FRESHNESS_OK pages=<n> pdf=<path>
# On drift: GATE0A_GUIDE_FRESHNESS_FAILED naming the differing pages, exit 1.

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly GENERATOR="$REPO_ROOT/artifacts/covert-alert-system/scripts/generate-gate0a-guide-readable.mjs"
readonly COMMITTED_PDF="$REPO_ROOT/artifacts/covert-alert-system/public/gate0a-run-guide.pdf"

[[ -f "$GENERATOR" ]] || { echo "Generator not found: $GENERATOR" >&2; exit 2; }
[[ -f "$COMMITTED_PDF" ]] || { echo "Committed guide not found: $COMMITTED_PDF" >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo "node is required for this check." >&2; exit 2; }
command -v pdftotext >/dev/null 2>&1 || { echo "pdftotext (poppler-utils) is required for this check." >&2; exit 2; }
command -v pdfinfo >/dev/null 2>&1 || { echo "pdfinfo (poppler-utils) is required for this check." >&2; exit 2; }
command -v pdftoppm >/dev/null 2>&1 || { echo "pdftoppm (poppler-utils) is required for this check." >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "python3 is required for this check." >&2; exit 2; }

if [[ -n "${CHROMIUM_PATH:-}" ]]; then
    :
elif [[ -x /repl/tools/bin/chromium ]]; then
    export CHROMIUM_PATH=/repl/tools/bin/chromium
else
    for candidate in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$candidate" >/dev/null 2>&1; then
            export CHROMIUM_PATH="$(command -v "$candidate")"
            break
        fi
    done
fi
[[ -n "${CHROMIUM_PATH:-}" ]] || { echo "No Chromium/Chrome binary found; set CHROMIUM_PATH." >&2; exit 2; }

SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT
readonly FRESH_PDF="$SCRATCH/gate0a-run-guide-fresh.pdf"

node "$GENERATOR" "$FRESH_PDF" >/dev/null
[[ -s "$FRESH_PDF" ]] || { echo "The generator reported success but $FRESH_PDF is missing or empty." >&2; exit 2; }

page_count() {
    pdfinfo "$1" | sed -n 's/^Pages:[[:space:]]*//p'
}

# Whitespace-collapsed per-page text: tolerant of extractor spacing noise,
# strict about actual words and which page they land on.
page_text() {
    pdftotext -f "$2" -l "$2" "$1" - 2>/dev/null | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//'
}

fresh_pages="$(page_count "$FRESH_PDF")"
committed_pages="$(page_count "$COMMITTED_PDF")"
[[ "$fresh_pages" =~ ^[0-9]+$ ]] || { echo "pdfinfo could not read the fresh PDF." >&2; exit 2; }
[[ "$committed_pages" =~ ^[0-9]+$ ]] || { echo "pdfinfo could not read the committed PDF." >&2; exit 2; }

if [[ "$fresh_pages" -ne "$committed_pages" ]]; then
    echo "GATE0A_GUIDE_FRESHNESS_FAILED: page count differs (committed=$committed_pages, regenerated=$fresh_pages)." >&2
    echo "The committed guide is stale relative to its generator. Regenerate it with:" >&2
    echo "  pnpm --filter @workspace/covert-alert-system run generate:gate0a" >&2
    exit 1
fi

differing=()
for ((page = 1; page <= committed_pages; page++)); do
    if [[ "$(page_text "$FRESH_PDF" "$page")" != "$(page_text "$COMMITTED_PDF" "$page")" ]]; then
        differing+=("$page")
    fi
done

if ((${#differing[@]} > 0)); then
    echo "GATE0A_GUIDE_FRESHNESS_FAILED: rendered text differs on page(s): ${differing[*]} (of $committed_pages)." >&2
    echo "The committed guide is stale relative to its generator. Regenerate it with:" >&2
    echo "  pnpm --filter @workspace/covert-alert-system run generate:gate0a" >&2
    exit 1
fi

# --- Stage 2: rendered-pixel comparison -------------------------------------
# Text extraction cannot see visual drift: a safety-significant color, border,
# background, font size, or layout change can leave every extracted word and
# the page count untouched. Rasterize both PDFs with the same pdftoppm at a
# fixed DPI and compare pixels. Both rasterizations happen in this run and the
# guide's fonts are subset-embedded in each PDF, so identical content renders
# pixel-identically (observed: zero differing pixels between same-source
# regenerations).
#
# The noise budget is therefore a small ABSOLUTE pixel count per page, not a
# percentage: a whole-page fraction would let localized drift through (a 1px
# footer rule recolor changes ~700 pixels per page — invisible to a 0.2%
# budget on a ~1M-pixel page, but ten times over this budget). CHANNEL_THRESHOLD
# stays low so subtle color shifts count. The budget only absorbs residual
# anti-aliasing noise if the regeneration toolchain's font build differs from
# the one that produced the committed PDF; if a future toolchain legitimately
# exceeds it, regenerate and recommit the PDF from that toolchain.
readonly RASTER_DPI=100
readonly CHANNEL_THRESHOLD=8
readonly MAX_DIFF_PIXELS=64

# Compares two binary PPM (P6) rasters; prints the differing-pixel count
# and exits 1 when the images are not comparable (dimension/parse mismatch).
compare_ppm() {
    python3 - "$1" "$2" <<'PYEOF'
import sys

def read_ppm(path):
    with open(path, "rb") as handle:
        data = handle.read()
    tokens = []
    idx = 0
    while len(tokens) < 4:
        while idx < len(data) and data[idx:idx+1].isspace():
            idx += 1
        if data[idx:idx+1] == b"#":
            while idx < len(data) and data[idx:idx+1] != b"\n":
                idx += 1
            continue
        start = idx
        while idx < len(data) and not data[idx:idx+1].isspace():
            idx += 1
        tokens.append(data[start:idx])
    idx += 1  # single whitespace after maxval
    magic, width, height, maxval = tokens[0], int(tokens[1]), int(tokens[2]), int(tokens[3])
    if magic != b"P6" or maxval != 255:
        raise SystemExit(f"unsupported PPM format in {path}")
    pixels = data[idx:]
    if len(pixels) != width * height * 3:
        raise SystemExit(f"truncated PPM raster in {path}")
    return width, height, pixels

w1, h1, p1 = read_ppm(sys.argv[1])
w2, h2, p2 = read_ppm(sys.argv[2])
if (w1, h1) != (w2, h2):
    raise SystemExit(f"page geometry differs: {w1}x{h1} vs {w2}x{h2}")
threshold = int(sys.argv[3]) if len(sys.argv) > 3 else 8
differing = 0
for offset in range(0, len(p1), 3):
    if (abs(p1[offset] - p2[offset]) > threshold
            or abs(p1[offset+1] - p2[offset+1]) > threshold
            or abs(p1[offset+2] - p2[offset+2]) > threshold):
        differing += 1
print(differing)
PYEOF
}

pixel_differing=()
for ((page = 1; page <= committed_pages; page++)); do
    pdftoppm -f "$page" -l "$page" -r "$RASTER_DPI" -singlefile "$FRESH_PDF" "$SCRATCH/fresh-page" 2>/dev/null
    pdftoppm -f "$page" -l "$page" -r "$RASTER_DPI" -singlefile "$COMMITTED_PDF" "$SCRATCH/committed-page" 2>/dev/null
    [[ -s "$SCRATCH/fresh-page.ppm" && -s "$SCRATCH/committed-page.ppm" ]] || {
        echo "pdftoppm could not rasterize page $page of one of the PDFs." >&2; exit 2;
    }
    if ! differing_pixels="$(compare_ppm "$SCRATCH/fresh-page.ppm" "$SCRATCH/committed-page.ppm" "$CHANNEL_THRESHOLD")"; then
        echo "GATE0A_GUIDE_FRESHNESS_FAILED: page $page rasters are not comparable: $differing_pixels" >&2
        echo "The committed guide is stale relative to its generator. Regenerate it with:" >&2
        echo "  pnpm --filter @workspace/covert-alert-system run generate:gate0a" >&2
        exit 1
    fi
    if ((differing_pixels > MAX_DIFF_PIXELS)); then
        pixel_differing+=("$page")
        echo "page $page: $differing_pixels pixels differ (noise budget: $MAX_DIFF_PIXELS)" >&2
    fi
    rm -f "$SCRATCH/fresh-page.ppm" "$SCRATCH/committed-page.ppm"
done

if ((${#pixel_differing[@]} > 0)); then
    echo "GATE0A_GUIDE_FRESHNESS_FAILED: rendered pixels differ on page(s): ${pixel_differing[*]} (of $committed_pages)." >&2
    echo "The committed guide is visually stale relative to its generator (color, border, background, font, or layout drift). Regenerate it with:" >&2
    echo "  pnpm --filter @workspace/covert-alert-system run generate:gate0a" >&2
    exit 1
fi

echo "GATE0A_GUIDE_FRESHNESS_OK pages=$committed_pages pdf=$COMMITTED_PDF"

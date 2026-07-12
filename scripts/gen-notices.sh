#!/usr/bin/env bash
# Generate THIRD_PARTY_NOTICES.txt by concatenating license texts of the
# Go and npm dependencies that get bundled into the Tokify binary.
#
# Requires:
#   - go-licenses          (go install github.com/google/go-licenses@latest)
#   - license-checker      (npm install -g license-checker-rseidelsohn)
#   - jq
#
# Output: writes THIRD_PARTY_NOTICES.txt to the path given as $1
#         (default: ./THIRD_PARTY_NOTICES.txt at repo root).

set -euo pipefail

OUT="${1:-$(pwd)/THIRD_PARTY_NOTICES.txt}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$REPO_ROOT/cmd/tock-desktop/frontend"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

for tool in go-licenses license-checker-rseidelsohn jq; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "missing required tool: $tool" >&2
        exit 1
    fi
done

{
    echo "Tokify — Third-party notices"
    echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo ""
    echo "Tokify itself is licensed under GPL-3.0-or-later (see LICENSE)."
    echo "This file lists the third-party software bundled into the Tokify binary"
    echo "and reproduces their license texts as required by those licenses."
    echo ""
    echo "================================================================"
    echo "Go dependencies"
    echo "================================================================"
    echo ""
} > "$OUT"

cd "$REPO_ROOT"
go-licenses save ./cmd/tock-desktop \
    --save_path="$TMP/go" \
    --force \
    --ignore github.com/kriuchkov/tock 2>/dev/null

find "$TMP/go" -type f | sort | while read -r f; do
    pkg="${f#$TMP/go/}"
    pkg="${pkg%/*}"
    {
        echo "---- $pkg ----"
        cat "$f"
        echo ""
        echo ""
    } >> "$OUT"
done

{
    echo "================================================================"
    echo "NPM dependencies (frontend)"
    echo "================================================================"
    echo ""
} >> "$OUT"

cd "$FRONTEND_DIR"
license-checker-rseidelsohn \
    --production \
    --excludePrivatePackages \
    --json > "$TMP/npm.json"

jq -r 'to_entries
       | map(select(.key | startswith("frontend@") | not))
       | sort_by(.key)
       | .[]
       | "\(.key)\t\(.value.licenses // "UNKNOWN")\t\(.value.licenseFile // "")"' \
    "$TMP/npm.json" \
| while IFS=$'\t' read -r pkg license file; do
    {
        echo "---- $pkg ($license) ----"
        if [ -n "$file" ] && [ -f "$file" ]; then
            cat "$file"
        else
            echo "(no license file shipped; declared license: $license)"
        fi
        echo ""
        echo ""
    } >> "$OUT"
done

echo "Wrote $OUT"

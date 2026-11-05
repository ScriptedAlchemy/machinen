#!/usr/bin/env bash
# Build the fixture tool into the directory given as $1.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runner="$(cd "${here}/../.." && pwd)"
out="${1:?usage: build.sh <output-dir>}"

mkdir -p "${out}"
swiftc \
  -target arm64-apple-macos13.0 \
  -framework Virtualization \
  -framework Foundation \
  -o "${out}/prepare-bundle" \
  "${runner}/Sources/RunnerCore.swift" \
  "${here}/main.swift"
codesign \
  --force \
  --sign - \
  --entitlements "${runner}/entitlements.plist" \
  --options runtime \
  "${out}/prepare-bundle"

#!/usr/bin/env bash
# Build and run the runner's native self-check. Signed with the runner's own
# entitlements, because configuration validation depends on them.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
binary="${work}/machinen-vz-runner-test"

swiftc \
  -target arm64-apple-macos13.0 \
  -framework Virtualization \
  -framework Foundation \
  -o "${binary}" \
  "${here}/Sources/RunnerCore.swift" \
  "${here}/Tests/main.swift"

codesign \
  --force \
  --sign - \
  --entitlements "${here}/entitlements.plist" \
  --options runtime \
  "${binary}"

"${binary}"

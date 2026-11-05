#!/usr/bin/env bash
# Build and sign machinen-vz-runner.
#
# The runner needs the virtualization entitlement. Ad-hoc signing is enough
# for local use; distribution needs a Developer ID identity, supplied
# through MACHINEN_VZ_SIGN_IDENTITY.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${here}/bin"
identity="${MACHINEN_VZ_SIGN_IDENTITY:--}"
binary="${out}/machinen-vz-runner"

mkdir -p "${out}"

swiftc \
  -O \
  -target arm64-apple-macos13.0 \
  -framework Virtualization \
  -framework Foundation \
  -o "${binary}" \
  "${here}/Sources/RunnerCore.swift" \
  "${here}/Sources/main.swift"

codesign \
  --force \
  --sign "${identity}" \
  --entitlements "${here}/entitlements.plist" \
  --options runtime \
  "${binary}"

codesign --verify --strict "${binary}"
if ! codesign --display --entitlements - --xml "${binary}" 2>/dev/null |
  grep -q "com.apple.security.virtualization"; then
  echo "error: ${binary} is missing the virtualization entitlement" >&2
  exit 1
fi
"${binary}" --version

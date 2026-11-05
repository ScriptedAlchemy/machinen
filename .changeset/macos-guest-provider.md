---
"@machinen/cli": minor
"@machinen/runtime": minor
"@machinen/native-arm64-darwin": minor
---

Add opt-in macOS guests. `boot({ guestOS: "macos", detached: true })` and
`machinen boot --guest-os macos --detach` boot a prepared VM bundle through a
signed Swift Virtualization.framework runner and drive it over key-only SSH. Each
boot runs from an APFS clone with its own identity and MAC address, so the bundle
is never written to and guest changes do not persist.

Linux remains the default and its boot path is unchanged. A macOS guest
dispatches before kernel, DTB, initramfs, rootdisk, gvproxy, and vsock setup,
so none of that work runs for it.

macOS guests refuse snapshot, fork, restore, memory stats, PTYs, and persistent
sessions with `PROVIDER_UNSUPPORTED_OPERATION`. Apple saved state is encrypted
to the originating host, and there is no guest session service.

Fix process start times on Darwin. `ps` reports them month-first on en_US hosts,
which the native helper could not parse, so identity checks fell back to the
process name alone and `readProcessIdentity` rejected the helper's response.

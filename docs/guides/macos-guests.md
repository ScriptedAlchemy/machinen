# Run a macOS guest

Machinen can boot a macOS guest from a bundle you prepared in advance, using
Apple's Virtualization.framework. You drive the guest over SSH with the same
`machinen exec` and `machinen stop` you use for Linux VMs.

This is a smaller surface than a Linux VM. There is no snapshot, fork, restore,
live mount, port forward, or interactive session, and Machinen does not install
macOS for you. See [What is not supported](#what-is-not-supported).

## Requirements

- An Apple silicon Mac. macOS guests do not run on Intel or Linux hosts.
- A prepared bundle, described below, on the same APFS volume as your home
  directory. Each boot clones it, and clones cannot cross volumes. If the bundle
  lives elsewhere, set `MACHINEN_MACOS_INSTANCES_DIR` to a directory on its volume.
- An SSH key the guest already trusts.

macOS allows at most two macOS guests to run at once on one host.

## Boot, use, stop

```bash
machinen boot --guest-os macos --detach \
  --name mac \
  --macos-bundle ~/bundles/macos-26 \
  --ssh-key ~/bundles/macos-26/ssh/id_ed25519 \
  --ssh-user admin

machinen exec mac -- uname -a
machinen stop mac
```

`--detach` is required. A macOS guest has no console to attach to, and its runner
process outlives the command that started it.

`boot` returns once a command has succeeded in the guest over SSH, not when the VM
has merely started. A cold boot usually takes a minute or two, and the wait is
capped at five minutes.

The same thing from TypeScript:

```ts
import { boot } from "@machinen/runtime";

const vm = await boot({
  guestOS: "macos",
  detached: true,
  name: "mac",
  macos: {
    source: { kind: "prepared-bundle", path: "/path/to/bundle" },
    ssh: { user: "admin", identityFile: "/path/to/id_ed25519" },
  },
});

const { stdout } = await vm.exec("sw_vers -productVersion");
await vm.writeFile("/tmp/payload.bin", Buffer.from([0, 1, 2, 3]), { mode: 0o644 });
await vm.kill();
```

## Bundle format

A bundle is a directory containing `config.json` and the files it names. Relative
paths resolve against the bundle.

```json
{
  "diskImage": "disk.img",
  "auxiliaryStorage": "aux.img",
  "hardwareModel": "hardwareModel.bin"
}
```

| Member             | What it is                                                                     |
| ------------------ | ------------------------------------------------------------------------------ |
| `diskImage`        | The guest's raw disk image, with macOS installed and set up as described below |
| `auxiliaryStorage` | The `VZMacAuxiliaryStorage` file created when the guest was installed          |
| `hardwareModel`    | `VZMacHardwareModel.dataRepresentation`, written to a file                     |

IPSW files, Tart images, and `.vzvm` paths are refused by name, because none of
them is a bundle.

### The bundle is never written to

Every boot makes its own instance under `~/.machinen/macos-instances/`: an APFS
clone of the disk and auxiliary storage, a new machine identity, and a new MAC
address. The guest runs from that instance, which costs almost no disk until the
guest changes something.

The instance is deleted when the guest stops, so **changes inside a guest do not
persist between boots**. To change what every guest starts with, change the bundle.

A runner holds an exclusive lock on its instance, so one instance can never be
booted twice.

### What the guest needs

Set these up once in the guest before you use it as a bundle:

- Setup Assistant finished, with a user account.
- Remote Login on.
- The user's `~/.ssh/authorized_keys` holding your public key. Password
  authentication is never used.
- For a clean shutdown, a sudoers rule that lets the user run
  `/sbin/shutdown` without a password. Without one, `machinen stop` falls back to a
  power-button request, then a forced power-off once its grace period runs out.

`packages/native-arm64-darwin/vz-runner/tools/prepare-bundle/` has the tools used
to produce the bundle Machinen's own tests run against: one lays an Apple restore
image onto a new bundle, and one boots it with a VNC server so you can get through
Setup Assistant. The VNC server uses a private Apple API, so it is test tooling,
not a supported feature.

## How the guest is reached

### Address

The guest gets its address from the host's DHCP server, on the network
Virtualization.framework creates. Machinen gives each instance a new MAC address
and finds that address in `/var/db/dhcpd_leases`, so a lease can only belong to
this boot.

If that cannot work for your setup, pass the address with `--ssh-host`, or set
`macos.ssh.host` in the API. That skips discovery entirely.

### Host key

The first connection, during `boot`, records the key the guest presents in a
`known_hosts` file inside the instance. Every later connection requires that same
key, including from other processes, and fails with `PROVIDER_TRANSPORT_FAILED`
if it differs.

Clones share the bundle's SSH host keys, since they are copies of its disk. The
pinned key therefore identifies "a guest from this bundle". What ties a command to
one specific guest is a check that its runner process is still the one that was
started, which runs before every command.

### Credentials

Authentication is by key only. Machinen passes the key to `ssh` by path and never
reads it. The path is recorded in the registry so later commands can reconnect
without repeating it, and the key's contents are never stored or logged.

To use a different key for one command, set `MACHINEN_MACOS_SSH_KEY`, or pass
`identityFile` to `attach()`.

Your own `~/.ssh/config` is ignored, so nothing in it can redirect or change these
connections.

## Running commands

Commands run under `/bin/sh -c` in the guest, whatever the user's login shell is.
That matches Linux guests. The environment is what `sshd` gives a non-interactive
session, so a tool installed by a shell profile may not be on `PATH`. Set it in the
command if you need to:

```bash
machinen exec mac -- 'PATH=/opt/homebrew/bin:$PATH brew --version'
```

Stdout, stderr, and the exit code all come through unchanged.

`vm.writeFile()` streams the bytes over the SSH channel, so binary content of any
size is safe. It creates parent directories by default, which `recursive: false`
turns off.

## Stopping

`machinen stop` escalates only as far as it has to:

1. Asks the guest to shut down, over SSH.
2. Sends the runner `SIGTERM`, which makes a power-button request. The guest stays
   up and gets 60 seconds to stop.
3. Sends the runner `SIGUSR1`, which powers the VM off.
4. Sends the runner `SIGKILL`.

Before each signal it checks that the PID still belongs to the runner it started,
so it cannot signal an unrelated process that inherited the PID.

`machinen stop --force` goes straight to `SIGKILL`. Either way, the instance and
registry entry are removed afterward.

If a runner dies on its own, the next `machinen ls` or `machinen gc` removes its
registry entry and instance.

## What is not supported

These fail with `PROVIDER_UNSUPPORTED_OPERATION`. They do not silently do something
else.

| Operation                                                            | Why                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `snapshot`, `fork`, `restore`                                        | Apple's saved state is encrypted to the host that made it, so it is not a portable bundle |
| `memoryStats`                                                        | The counters come from the Linux balloon driver                                           |
| `execPty`, `exec --tty`, `attach`, `sessions`                        | These need a session service in the guest, which macOS guests do not have                 |
| Attached boot (no `--detach`)                                        | There is no console to attach to                                                          |
| `--mount`, `--mount-live`, `-p`, `--nested`, and the Linux CPU flags | These are implemented by the Linux guest stack                                            |

Machinen does not install macOS. An IPSW has to be turned into a bundle first.

## Troubleshooting

The runner's log and last status are in the instance directory, which `machinen ls
--json` and the registry entry point to. Boot failures include the end of the log.

| Error                                                       | Likely cause                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `PROVIDER_IMAGE_INVALID`: `cannot clone`                    | The bundle and instance directory are on different volumes, or the volume is not APFS |
| `PROVIDER_READINESS_FAILED`: `never received a DHCP lease`  | The guest did not finish booting, or did not start its network                        |
| `PROVIDER_TRANSPORT_FAILED`: `Permission denied`            | The key is not in the guest's `authorized_keys`, or `--ssh-user` is wrong             |
| `PROVIDER_TRANSPORT_FAILED`: `Host key verification failed` | Something other than the booted guest answered at this address                        |
| `PROVIDER_TRANSPORT_FAILED`: `never answered over SSH`      | Remote Login is off in the bundle                                                     |
| `BOOT_VMM_MISSING`                                          | The runner is not built. Run `packages/native-arm64-darwin/vz-runner/build.sh`        |

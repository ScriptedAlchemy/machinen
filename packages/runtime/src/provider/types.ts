// Guest OS, provider, and capability model.
//
// Two independent axes. `GuestOS` is what the caller asked to run and is
// what gates guest-OS-specific operations. `ProviderId` is how that guest
// is hosted and is what dispatch keys on. Keeping them separate matters
// because `VmstateBackend` already conflates the host VMM with the guest
// platform, and that conflation is what makes a macOS guest unrepresentable
// today.

export type GuestOS = "linux" | "macos";

export type ProviderId = "machinen-hvf" | "machinen-kvm" | "apple-vz";

/**
 * What a selected provider actually implements. Every field is a plain
 * boolean so a caller can branch without probing, and so a capability the
 * provider lacks fails at the call site with a typed error instead of
 * degrading into a partial result.
 */
export interface GuestCapabilities {
  /** Run a one-shot command and return its streams plus exit code. */
  exec: boolean;
  /** Open an interactive PTY through `vm.execPty`. */
  pty: boolean;
  /**
   * Named sessions that survive a disconnect and can be reattached.
   * Distinct from `pty`, which is per-connection.
   */
  persistentSessions: boolean;
  /** Push and pull files. */
  files: boolean;
  /** Whole-guest snapshot, including memory state. */
  snapshot: boolean;
  /** Snapshot plus restore into a sibling guest, live. */
  fork: boolean;
  /** Restore a snapshot bundle into a new guest. */
  restore: boolean;
  /** Cold clone of a stopped image with a fresh machine identity. */
  clone: boolean;
  /** Host directory sharing. */
  mounts: boolean;
  /** Host to guest port forwarding. */
  portForward: boolean;
  /** Guest memory counters. */
  memoryStats: boolean;
  /** Same-host suspend and resume. */
  suspend: boolean;
  /** Guest OS installation from a vendor image. */
  install: boolean;
}

export const LINUX_CAPABILITIES: GuestCapabilities = {
  exec: true,
  pty: true,
  persistentSessions: true,
  files: true,
  snapshot: true,
  fork: true,
  restore: true,
  clone: false,
  mounts: true,
  portForward: true,
  memoryStats: true,
  suspend: false,
  install: true,
};

/**
 * The macOS MVP over a prepared bundle. Everything that depends on guest
 * memory state or a Linux guest agent is false, so those calls refuse
 * rather than pretend.
 */
export const MACOS_CAPABILITIES: GuestCapabilities = {
  exec: true,
  pty: false,
  persistentSessions: false,
  files: true,
  snapshot: false,
  fork: false,
  restore: false,
  clone: false,
  mounts: false,
  portForward: false,
  memoryStats: false,
  suspend: false,
  install: false,
};

export const GUEST_OS_VALUES: readonly GuestOS[] = ["linux", "macos"];
export const PROVIDER_VALUES: readonly ProviderId[] = ["machinen-hvf", "machinen-kvm", "apple-vz"];

/** Registry and API metadata for a guest. All fields optional on read. */
export interface GuestProviderInfo {
  guestOS: GuestOS;
  provider: ProviderId;
  capabilities: GuestCapabilities;
  /**
   * Opaque provider-side reference. For the macOS provider this is the
   * absolute path of the prepared VM bundle the guest was cloned from.
   */
  providerRef?: string;
}

/**
 * Non-secret state a second process needs to rejoin a macOS guest. Holds
 * paths and addresses only: the identity file is recorded by path, never by
 * content, and the known_hosts file is what keeps the host key pinned across
 * processes.
 */
export interface MacosRegistryState {
  /** Prepared bundle this instance was cloned from. Never written to. */
  baseBundlePath: string;
  /** Per-boot clone the runner owns. Removed when the guest stops. */
  instanceDir: string;
  statusPath: string;
  logPath: string;
  knownHostsPath: string;
  macAddress: string;
  sshUser: string;
  sshPort: number;
  identityFile: string;
  /** Guest address. Absent until the guest has been found on the network. */
  sshHost?: string;
}

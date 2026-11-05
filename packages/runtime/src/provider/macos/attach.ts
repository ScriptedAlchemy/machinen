// Reconstruct a macOS handle from the registry.
//
// This is the path a second process takes after a boot. It rejoins the guest
// with the state the boot persisted: the host key the boot pinned, the instance
// it created, and the identity of the runner it started. Anything that no
// longer holds is refused rather than re-established.

import { BootError, ExecError, RegistryError } from "../../errors.ts";
import type { RegistryEntry } from "../../registry.ts";
import type { VmHandle } from "../../vm-handle.ts";
import { MACOS_CAPABILITIES, type MacosRegistryState } from "../types.ts";
import {
  assertRunnerLive,
  stopMacosGuest,
  waitForRunnerExit,
  type RunnerIdentity,
} from "./control.ts";
import { createMacosHandle } from "./handle.ts";
import { createMacosTransport, hasPinnedHostKey, type MacosTransport } from "./ssh.ts";

interface MacosAttachOptions {
  entry: RegistryEntry;
  /** SSH identity file. Defaults to the one the guest was booted with. */
  identityFile?: string;
  /** Guest user name. Defaults to the user the guest was booted with. */
  user?: string;
}

export async function attachMacosGuest(opts: MacosAttachOptions): Promise<VmHandle> {
  const { entry } = opts;
  const state = entry.macos;
  if (!state || !entry.vmmExe) {
    throw new RegistryError(
      "REGISTRY_VM_NOT_FOUND",
      `macOS registry entry ${entry.pid} has no provider state to rejoin the guest with.`,
    );
  }
  const identity: RunnerIdentity = {
    pid: entry.pid,
    exe: entry.vmmExe,
    startedAt: entry.startedAt,
  };
  assertRunnerLive(identity);
  const transport = state.sshHost
    ? pinnedTransport(opts, state, state.sshHost)
    : stillBootingTransport(entry.pid);
  return createMacosHandle({
    pid: entry.pid,
    name: entry.name,
    transport,
    capabilities: entry.capabilities ?? MACOS_CAPABILITIES,
    assertLive: () => assertRunnerLive(identity),
    wait: () => waitForRunnerExit(identity, state.statusPath),
    kill: () => stopMacosGuest({ identity, transport, instanceDir: state.instanceDir }),
  });
}

function pinnedTransport(
  opts: MacosAttachOptions,
  state: MacosRegistryState,
  host: string,
): MacosTransport {
  if (!hasPinnedHostKey(state.knownHostsPath)) {
    throw new ExecError(
      "PROVIDER_TRANSPORT_FAILED",
      `no pinned host key for this guest at ${state.knownHostsPath}. ` +
        "Trusting a new key here would let another machine answer for it, so attach refuses.",
    );
  }
  return createMacosTransport({
    user: opts.user ?? state.sshUser,
    host,
    port: state.sshPort,
    identityFile: opts.identityFile ?? process.env.MACHINEN_MACOS_SSH_KEY ?? state.identityFile,
    knownHostsPath: state.knownHostsPath,
    hostKeyPolicy: "pinned",
  });
}

/** A guest still booting can be stopped by signal, but has nothing to talk to yet. */
function stillBootingTransport(pid: number): MacosTransport {
  const refuse = (): never => {
    throw new BootError(
      "PROVIDER_READINESS_FAILED",
      `macOS guest ${pid} is still booting and has no address yet.`,
    );
  };
  return {
    exec: async () => refuse(),
    writeFile: async () => refuse(),
  };
}

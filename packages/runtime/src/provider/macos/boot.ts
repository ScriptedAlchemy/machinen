// macOS guest boot.
//
// Reached from `boot()` only after the provider selector picks `apple-vz`,
// so no Linux asset work has run. Order is deliberate: validate everything
// cheap, clone the bundle, start the runner and register it straight away so a
// crash here cannot strand a running guest, then wait for a real readiness
// signal, which is a command succeeding over SSH. Waits use referenced timers,
// because the runner is unreferenced and nothing else keeps a CLI process alive.

import { rmSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { BootError, RegistryError, isMachinenError } from "../../errors.ts";
import { readProcessIdentity } from "../../pid-validate.ts";
import { claimName, findEntry, patchEntry, removeEntry, writeEntry } from "../../registry.ts";
import type { VmHandle } from "../../vm-handle.ts";
import { assertProviderHostSupported, type ProviderSelection } from "../select.ts";
import { MACOS_CAPABILITIES, type MacosRegistryState } from "../types.ts";
import { waitForGuestAddress } from "./address.ts";
import {
  resolveMacosBundle,
  validateMacosResources,
  validateMacosSsh,
  type MacosBootOptions,
  type MacosBundle,
} from "./config.ts";
import {
  assertRunnerLive,
  stopMacosGuest,
  waitForRunnerExit,
  type RunnerIdentity,
} from "./control.ts";
import { createMacosHandle } from "./handle.ts";
import { createMacosInstance, type MacosInstance } from "./instance.ts";
import {
  createMachineIdentity,
  resolveVzRunnerBinary,
  spawnRunner,
  type SpawnedRunner,
} from "./runner.ts";
import { describeRunnerLog, waitForRunnerRunning } from "./runner-status.ts";
import { createMacosTransport, type MacosTransport } from "./ssh.ts";
import type { BootOptions } from "../../vm/boot.ts";

/** Cold boot of a fresh clone, including its first SSH answer. */
const DEFAULT_READINESS_TIMEOUT_MS = 300_000;
const ABORT_WAIT_MS = 5_000;
const SSH_RETRY_MS = 1_000;

export async function bootMacosGuest(
  opts: BootOptions,
  selection: ProviderSelection,
): Promise<VmHandle> {
  assertProviderHostSupported(selection);
  const macos = requireMacosOptions(opts);
  rejectLinuxOnlyOptions(opts);
  rejectAttachedBoot(opts);
  validateMacosSsh(macos.ssh);
  const resources = validateMacosResources(macos);
  const base = resolveMacosBundle(macos.source, opts.cwd);
  assertNameFree(opts.name);
  const binary = resolveVzRunnerBinary();

  const instance = createMacosInstance({
    base,
    createIdentity: (path) => createMachineIdentity(binary, path),
  });
  let runner: SpawnedRunner | undefined;
  try {
    runner = spawnRunner({ binary, instance, ...resources });
    const identity = captureRunnerIdentity(runner.pid, binary);
    const state = providerState(macos, base, instance);
    registerGuest({ opts, base, instance, state, identity, memoryMib: resources.memoryMib });
    const transport = await waitUntilReachable({ macos, instance, runner, identity, state });
    return createMacosHandle({
      pid: runner.pid,
      name: opts.name,
      transport,
      assertLive: () => assertRunnerLive(identity),
      wait: () => waitForRunnerExit(identity, instance.statusPath),
      kill: () => stopMacosGuest({ identity, transport, instanceDir: instance.dir }),
    });
  } catch (err) {
    await abortBoot(runner, instance);
    throw err;
  }
}

function requireMacosOptions(opts: BootOptions): MacosBootOptions {
  if (!opts.macos) {
    throw new BootError(
      "PROVIDER_IMAGE_INVALID",
      'guestOS "macos" requires a `macos` configuration block with a prepared bundle and SSH settings.',
    );
  }
  return opts.macos;
}

const LINUX_ONLY_MACOS_OPTIONS: ReadonlyArray<{
  name: string;
  present: (opts: BootOptions) => boolean;
}> = [
  { name: "snapshot", present: (o) => o.snapshot !== undefined && o.snapshot !== false },
  { name: "mount", present: (o) => o.mount !== undefined },
  { name: "liveMounts", present: (o) => (o.liveMounts ?? []).length > 0 },
  { name: "portForward", present: (o) => (o.portForward ?? []).length > 0 },
  { name: "nested", present: (o) => Boolean(o.nested) },
  { name: "rootDisk", present: (o) => o.rootDisk !== undefined },
  { name: "kernel/dtb", present: (o) => o.kernel !== undefined || o.dtb !== undefined },
  { name: "image", present: (o) => o.image !== undefined },
  { name: "cmd", present: (o) => (o.cmd ?? []).length > 0 },
];

/**
 * Refuse Linux-only options before spawning. Silently ignoring them would
 * produce a guest that does not match what the caller asked for.
 */
function rejectLinuxOnlyOptions(opts: BootOptions): void {
  const rejected = LINUX_ONLY_MACOS_OPTIONS.filter((entry) => entry.present(opts)).map(
    (entry) => entry.name,
  );
  if (rejected.length === 0) {
    return;
  }
  throw new BootError(
    "PROVIDER_UNSUPPORTED_OPERATION",
    `guestOS "macos" does not support ${rejected.join(", ")}. ` +
      "A macOS guest boots a prepared bundle and is driven over SSH.",
  );
}

/**
 * A macOS guest has no console to attach to, and its runner deliberately
 * outlives the process that started it, so an attached boot could only pretend.
 */
function rejectAttachedBoot(opts: BootOptions): void {
  if (!opts.detached) {
    throw new BootError(
      "PROVIDER_UNSUPPORTED_OPERATION",
      'guestOS "macos" only supports detached boots. Pass `detached: true`, ' +
        "then drive the guest with exec and stop it with kill.",
    );
  }
}

function assertNameFree(name: string | undefined): void {
  if (name && findEntry({ name })) {
    throw nameInUse(name);
  }
}

function nameInUse(name: string): RegistryError {
  return new RegistryError(
    "REGISTRY_NAME_IN_USE",
    `boot: name ${JSON.stringify(name)} is already held by a live VM.`,
  );
}

/**
 * Record what the OS reports for the runner rather than what was asked for.
 * Later liveness checks compare against the same source, so the check cannot
 * disagree with itself about how the executable's name is reported.
 */
function captureRunnerIdentity(pid: number, binary: string): RunnerIdentity {
  const observed = readProcessIdentity(pid);
  return {
    pid,
    exe: observed?.exeBase ?? binary,
    startedAt: observed?.startedAtMs ?? Date.now(),
  };
}

function providerState(
  macos: MacosBootOptions,
  base: MacosBundle,
  instance: MacosInstance,
): MacosRegistryState {
  return {
    baseBundlePath: base.path,
    instanceDir: instance.dir,
    statusPath: instance.statusPath,
    logPath: instance.logPath,
    knownHostsPath: instance.knownHostsPath,
    macAddress: instance.macAddress,
    sshUser: macos.ssh.user,
    sshPort: macos.ssh.port ?? 22,
    identityFile: macos.ssh.identityFile,
  };
}

function registerGuest(args: {
  opts: BootOptions;
  base: MacosBundle;
  instance: MacosInstance;
  state: MacosRegistryState;
  identity: RunnerIdentity;
  memoryMib: number;
}): void {
  const { opts, identity, state } = args;
  if (opts.name && !claimName(opts.name, identity.pid)) {
    throw nameInUse(opts.name);
  }
  writeEntry({
    pid: identity.pid,
    name: opts.name,
    // No vsock UDS exists for this provider. An empty string would look like a
    // broken bridge, so this names the SSH endpoint instead.
    socketPath: sshEndpoint(state),
    vmmExe: identity.exe,
    startedAt: identity.startedAt,
    memoryCeilingMib: args.memoryMib,
    guestOS: "macos",
    provider: "apple-vz",
    providerRef: args.base.path,
    capabilities: MACOS_CAPABILITIES,
    macos: state,
    cleanupPaths: [args.instance.dir],
  });
}

function sshEndpoint(state: MacosRegistryState): string {
  return `${state.sshUser}@${state.sshHost ?? "pending"}:${state.sshPort}`;
}

async function waitUntilReachable(args: {
  macos: MacosBootOptions;
  instance: MacosInstance;
  runner: SpawnedRunner;
  identity: RunnerIdentity;
  state: MacosRegistryState;
}): Promise<MacosTransport> {
  const { macos, instance, runner, identity, state } = args;
  const timeoutMs = macos.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const isAlive = () => runner.child.exitCode === null && runner.child.signalCode === null;

  await waitForRunnerRunning({
    statusPath: instance.statusPath,
    timeoutMs,
    isAlive,
    logPath: instance.logPath,
  });
  const host =
    macos.ssh.host ??
    (await waitForGuestAddress({ macAddress: instance.macAddress, deadline, isAlive }));
  const located = { ...state, sshHost: host };
  patchEntry(identity.pid, { socketPath: sshEndpoint(located), macos: located });

  writeFileSync(instance.knownHostsPath, "", { flag: "a", mode: 0o600 });
  const endpoint = {
    user: state.sshUser,
    host,
    port: state.sshPort,
    identityFile: state.identityFile,
    knownHostsPath: instance.knownHostsPath,
  };
  await assertSshReady({
    transport: createMacosTransport({ ...endpoint, hostKeyPolicy: "trust-on-first-use" }),
    deadline,
    isAlive,
    logPath: instance.logPath,
  });
  return createMacosTransport({ ...endpoint, hostKeyPolicy: "pinned" });
}

async function assertSshReady(args: {
  transport: MacosTransport;
  deadline: number;
  isAlive: () => boolean;
  logPath: string;
}): Promise<void> {
  let lastError: unknown;
  while (Date.now() < args.deadline && args.isAlive()) {
    try {
      const result = await args.transport.exec("true", {
        connectTimeoutMs: 5_000,
        execTimeoutMs: 15_000,
      });
      if (result.exitCode === 0) {
        return;
      }
      lastError = new Error(result.stderr || `ssh exited ${result.exitCode}`);
    } catch (err) {
      if (isMachinenError(err) && !err.retryable) {
        throw err;
      }
      lastError = err;
    }
    await delay(SSH_RETRY_MS);
  }
  throw new BootError(
    "PROVIDER_TRANSPORT_FAILED",
    "macOS guest never answered over SSH. Check the guest's Remote Login setting, " +
      `the identity file, and the reported address. Last error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }${describeRunnerLog(args.logPath)}`,
    { cause: lastError },
  );
}

/**
 * Undo a failed boot. The runner has to be gone before its instance is removed,
 * since it holds the disk open and may still be writing to it.
 */
async function abortBoot(
  runner: SpawnedRunner | undefined,
  instance: MacosInstance,
): Promise<void> {
  if (runner) {
    await killAndWait(runner);
    removeEntry(runner.pid);
  }
  rmSync(instance.dir, { recursive: true, force: true });
}

async function killAndWait(runner: SpawnedRunner): Promise<void> {
  const { child } = runner;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ABORT_WAIT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGKILL");
  });
}

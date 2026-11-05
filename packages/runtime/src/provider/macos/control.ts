// Runner identity and shutdown, shared by the booting and attaching handles.
//
// The runner is detached and this process may be a later one, so a PID alone
// proves nothing: it could have been recycled. Every destructive signal is
// preceded by a fresh identity check.
//
// Polling timers here stay referenced on purpose. Nothing else holds a CLI
// process open while it waits on a detached runner, so an unreferenced timer
// would let it exit mid-stop.

import { rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { ExecError } from "../../errors.ts";
import { validatePid, type PidStatus } from "../../pid-validate.ts";
import { removeEntry } from "../../registry.ts";
import { readRunnerStatus } from "./runner-status.ts";
import type { MacosTransport } from "./ssh.ts";

export interface RunnerIdentity {
  pid: number;
  /** Executable name the OS reported for the runner at spawn. */
  exe: string;
  /** Start time the OS reported for the runner at spawn, in ms. */
  startedAt: number;
}

export interface StopTimeouts {
  /** How long the guest gets to shut itself down. */
  gracefulMs: number;
  /** How long the runner gets to power the VM off when told to. */
  forceMs: number;
  /** How long the kernel gets after SIGKILL. */
  killMs: number;
  pollMs: number;
}

export const DEFAULT_STOP_TIMEOUTS: StopTimeouts = {
  gracefulMs: 60_000,
  forceMs: 15_000,
  killMs: 5_000,
  pollMs: 250,
};

const GUEST_SHUTDOWN_COMMAND = "sudo -n /sbin/shutdown -h now";
const GUEST_SHUTDOWN_TIMEOUT_MS = 15_000;

export function runnerLiveness(identity: RunnerIdentity): PidStatus {
  return validatePid(identity.pid, { vmmExe: identity.exe, startedAt: identity.startedAt });
}

/** Refuse to talk to a guest whose runner is gone or whose PID now belongs to something else. */
export function assertRunnerLive(identity: RunnerIdentity): void {
  const status = runnerLiveness(identity);
  if (status !== "alive") {
    throw new ExecError(
      "PROVIDER_TRANSPORT_FAILED",
      `macOS runner pid ${identity.pid} is ${status === "dead" ? "gone" : "no longer ours"}, ` +
        "so its guest is unreachable.",
    );
  }
}

export async function waitForRunnerExit(
  identity: RunnerIdentity,
  statusPath: string,
  pollMs: number = DEFAULT_STOP_TIMEOUTS.pollMs,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  while (runnerLiveness(identity) === "alive") {
    await delay(pollMs);
  }
  // The runner is not necessarily our child, so its exit code is not ours to
  // read. Its last status says how it ended.
  const state = readRunnerStatus(statusPath)?.state;
  if (state === "stopped") {
    return { code: 0, signal: null };
  }
  return { code: state === "failed" ? 1 : null, signal: null };
}

/**
 * Stop a guest: ask it to shut down, give it time, power it off, then kill the
 * runner. Each step only runs if the previous one did not end the runner, so a
 * guest that shuts down cleanly never sees the VM's power cut. The instance and
 * registry entry are released once the runner is gone.
 */
export async function stopMacosGuest(args: {
  identity: RunnerIdentity;
  transport: MacosTransport;
  instanceDir: string;
  timeouts?: StopTimeouts;
}): Promise<void> {
  const timeouts = args.timeouts ?? DEFAULT_STOP_TIMEOUTS;
  if (runnerLiveness(args.identity) === "alive") {
    await requestGuestShutdown(args.transport);
    await escalateUntilGone(args.identity, timeouts);
  }
  rmSync(args.instanceDir, { recursive: true, force: true });
  removeEntry(args.identity.pid);
}

async function requestGuestShutdown(transport: MacosTransport): Promise<void> {
  try {
    await transport.exec(GUEST_SHUTDOWN_COMMAND, {
      connectTimeoutMs: 5_000,
      execTimeoutMs: GUEST_SHUTDOWN_TIMEOUT_MS,
    });
  } catch {
    // Best effort. A guest with no sudo rule or no SSH still gets the
    // power-button request and, failing that, the forced stop.
  }
}

async function escalateUntilGone(identity: RunnerIdentity, timeouts: StopTimeouts): Promise<void> {
  const steps: ReadonlyArray<{ signal: NodeJS.Signals; budgetMs: number }> = [
    { signal: "SIGTERM", budgetMs: timeouts.gracefulMs },
    { signal: "SIGUSR1", budgetMs: timeouts.forceMs },
    { signal: "SIGKILL", budgetMs: timeouts.killMs },
  ];
  for (const step of steps) {
    if (runnerLiveness(identity) !== "alive") {
      return;
    }
    process.kill(identity.pid, step.signal);
    if (await waitUntilGone(identity, step.budgetMs, timeouts.pollMs)) {
      return;
    }
  }
  throw new ExecError(
    "EXEC_AGENT_TIMEOUT",
    `macOS runner pid ${identity.pid} survived SIGKILL. Its instance has been left in place.`,
  );
}

async function waitUntilGone(
  identity: RunnerIdentity,
  budgetMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (runnerLiveness(identity) !== "alive") {
      return true;
    }
    await delay(pollMs);
  }
  return runnerLiveness(identity) !== "alive";
}

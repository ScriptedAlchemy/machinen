// Runner status file reader.
//
// The Swift runner writes a small JSON document as it moves through its
// lifecycle. The runtime polls it instead of inferring readiness from a
// successful spawn, because `start()` returning is not proof that the
// guest is reachable.

import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { BootError } from "../../errors.ts";

type RunnerState = "starting" | "running" | "stopping" | "stopped" | "failed";

interface RunnerStatus {
  state: RunnerState;
  /** MAC address of the guest's network device. */
  macAddress?: string;
  /** Human-readable failure detail. Never contains secret material. */
  error?: string;
  /** Who ended the guest: `guest` for a clean shutdown, `forced` otherwise. */
  stopReason?: string;
  /** ms epoch the status was written. */
  updatedAt?: number;
}

const VALID_STATES: readonly RunnerState[] = [
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
];

const LOG_TAIL_BYTES = 2048;

/** Read and validate a status file. Returns undefined when absent. */
export function readRunnerStatus(path: string): RunnerStatus | undefined {
  if (!existsSync(path)) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const state = record.state;
  if (typeof state !== "string" || !(VALID_STATES as readonly string[]).includes(state)) {
    return undefined;
  }
  const status: RunnerStatus = { state: state as RunnerState };
  for (const field of ["macAddress", "error", "stopReason"] as const) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) {
      status[field] = value;
    }
  }
  if (typeof record.updatedAt === "number") {
    status.updatedAt = record.updatedAt;
  }
  return status;
}

/** The end of the runner log, framed for an error message. Empty when absent. */
export function describeRunnerLog(logPath: string | undefined): string {
  if (!logPath || !existsSync(logPath)) {
    return "";
  }
  const text = readFileSync(logPath, "utf8").slice(-LOG_TAIL_BYTES).trim();
  return text ? `\nrunner log:\n${text}` : "";
}

/**
 * Poll until the runner reports `running` or the deadline passes. A
 * `failed` status short-circuits, and so does a dead runner.
 */
export async function waitForRunnerRunning(args: {
  statusPath: string;
  timeoutMs: number;
  pollMs?: number;
  isAlive: () => boolean;
  logPath?: string;
}): Promise<RunnerStatus> {
  const deadline = Date.now() + args.timeoutMs;
  const pollMs = args.pollMs ?? 100;
  let last: RunnerStatus | undefined;
  while (Date.now() < deadline) {
    const status = readRunnerStatus(args.statusPath);
    if (status) {
      last = status;
      if (status.state === "running") {
        return status;
      }
      if (status.state === "failed") {
        throw new BootError(
          "PROVIDER_READINESS_FAILED",
          `macOS runner failed before readiness. ${status.error ?? "no detail reported"}` +
            describeRunnerLog(args.logPath),
        );
      }
    }
    if (!args.isAlive()) {
      throw new BootError(
        "PROVIDER_READINESS_FAILED",
        `macOS runner exited before reporting readiness. ` +
          `Last state ${last?.state ?? "unreported"}.${describeRunnerLog(args.logPath)}`,
      );
    }
    await delay(pollMs);
  }
  throw new BootError(
    "PROVIDER_READINESS_FAILED",
    `macOS runner did not reach readiness within ${args.timeoutMs}ms. ` +
      `Last state ${last?.state ?? "unreported"}.${describeRunnerLog(args.logPath)}`,
  );
}

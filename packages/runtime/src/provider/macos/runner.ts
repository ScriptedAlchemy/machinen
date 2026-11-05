// Spawn and lifecycle for the Swift Virtualization.framework runner.
//
// One runner process per VM, so the registry PID is a real per-VM PID. The
// runner is always detached: it gets its own session and writes to a log file
// rather than pipes, so no live stream ties it to the process that started it.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { arch as osArch, platform as osPlatform } from "node:os";

import { BootError } from "../../errors.ts";
import type { MacosInstance } from "./instance.ts";

const require_ = createRequire(import.meta.url);

interface RunnerSpawnOptions {
  /** Absolute path to the built runner executable. */
  binary: string;
  instance: MacosInstance;
  memoryMib: number;
  cpuCount: number;
}

export interface SpawnedRunner {
  child: ChildProcess;
  pid: number;
}

/**
 * Resolve the runner executable from the native package, honoring the same
 * override style the VMM uses so tests and dev builds can point elsewhere.
 */
export function resolveVzRunnerBinary(): string {
  const override = process.env.MACHINEN_VZ_RUNNER;
  if (override) {
    if (!existsSync(override)) {
      throw new BootError(
        "BOOT_VMM_MISSING",
        `MACHINEN_VZ_RUNNER is set to ${override}, but that file does not exist.`,
      );
    }
    return override;
  }
  const key = `${osArch()}-${osPlatform()}`;
  const pkgName = `@machinen/native-${key}`;
  try {
    const mod = require_(pkgName) as { vzRunner?: string };
    if (!mod.vzRunner || !existsSync(mod.vzRunner)) {
      throw new BootError(
        "BOOT_VMM_MISSING",
        `${pkgName} is installed but its VZ runner is missing at ${mod.vzRunner ?? "<unset>"}. ` +
          "Build it with packages/native-arm64-darwin/vz-runner/build.sh.",
      );
    }
    return mod.vzRunner;
  } catch (err) {
    if (err instanceof BootError) {
      throw err;
    }
    throw new BootError(
      "BOOT_VMM_MISSING",
      "no macOS VZ runner found. Build it with " +
        "`packages/native-arm64-darwin/vz-runner/build.sh`, or set MACHINEN_VZ_RUNNER.",
      { cause: err },
    );
  }
}

/** Have the runner create a new machine identity, since only it can make a valid one. */
export function createMachineIdentity(binary: string, path: string): void {
  const result = spawnSync(binary, ["--create-identity", path], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new BootError(
      "PROVIDER_IMAGE_INVALID",
      `could not create a machine identity at ${path}. ${
        result.error?.message ?? result.stderr.trim()
      }`,
      { cause: result.error },
    );
  }
}

export function spawnRunner(opts: RunnerSpawnOptions): SpawnedRunner {
  const log = openSync(opts.instance.logPath, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(
      opts.binary,
      [
        "--bundle",
        opts.instance.dir,
        "--status-file",
        opts.instance.statusPath,
        "--memory-mib",
        String(opts.memoryMib),
        "--cpus",
        String(opts.cpuCount),
        "--mac-address",
        opts.instance.macAddress,
      ],
      { detached: true, stdio: ["ignore", log, log] },
    );
  } finally {
    closeSync(log);
  }
  // A failed spawn surfaces as an `error` event with no pid. Without a listener
  // that event would crash the host process instead of failing this boot.
  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });
  if (child.pid === undefined) {
    throw new BootError(
      "PROVIDER_READINESS_FAILED",
      `macOS runner ${opts.binary} failed to spawn.${spawnError ? ` ${spawnError.message}` : ""}`,
      { cause: spawnError },
    );
  }
  child.unref();
  return { child, pid: child.pid };
}

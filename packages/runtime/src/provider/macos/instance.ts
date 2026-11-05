// Per-boot working copy of a prepared bundle.
//
// A prepared bundle is an input, not a disk the guest owns. Booting one
// directly would write through it, and booting it twice would corrupt it, so
// every boot gets an APFS clone with its own identity and MAC address. The
// clone costs almost nothing until the guest diverges, and it is discarded when
// the guest stops.

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BootError } from "../../errors.ts";
import { registryRoot } from "../../registry.ts";
import { cloneFile } from "./clone.ts";
import type { MacosBundle } from "./config.ts";

export interface MacosInstance {
  dir: string;
  statusPath: string;
  logPath: string;
  knownHostsPath: string;
  macAddress: string;
}

const MEMBERS = {
  diskImage: "disk.img",
  auxiliaryStorage: "aux.img",
  hardwareModel: "hardwareModel.bin",
  machineIdentifier: "machineIdentifier.bin",
} as const;

/** Directory holding per-boot clones. Must share an APFS volume with the bundle. */
export function macosInstancesRoot(): string {
  return (
    process.env.MACHINEN_MACOS_INSTANCES_DIR ?? join(dirname(registryRoot()), "macos-instances")
  );
}

/** A random locally administered unicast address, in the form VZ and bootpd use. */
export function generateMacAddress(): string {
  const bytes = randomBytes(6);
  bytes[0] = (bytes[0]! & 0xfe) | 0x02;
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
}

/**
 * Clone `base` into a new instance directory. `createIdentity` writes a new
 * machine identity, because two guests sharing one must not run concurrently.
 */
export function createMacosInstance(args: {
  base: MacosBundle;
  createIdentity: (path: string) => void;
}): MacosInstance {
  const dir = join(macosInstancesRoot(), randomBytes(8).toString("hex"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    cloneMember(args.base.diskImage, join(dir, MEMBERS.diskImage), args.base.path);
    cloneMember(args.base.auxiliaryStorage, join(dir, MEMBERS.auxiliaryStorage), args.base.path);
    cloneMember(args.base.hardwareModel, join(dir, MEMBERS.hardwareModel), args.base.path);
    args.createIdentity(join(dir, MEMBERS.machineIdentifier));
    writeFileSync(join(dir, "config.json"), JSON.stringify(MEMBERS), { mode: 0o600 });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    dir,
    statusPath: join(dir, "status.json"),
    logPath: join(dir, "runner.log"),
    knownHostsPath: join(dir, "known_hosts"),
    macAddress: generateMacAddress(),
  };
}

function cloneMember(source: string, destination: string, bundlePath: string): void {
  try {
    cloneFile(source, destination);
  } catch (err) {
    throw new BootError(
      "PROVIDER_IMAGE_INVALID",
      `cannot clone ${source} into ${destination}. macOS guests boot from an APFS clone of ` +
        `the bundle at ${bundlePath}, so the bundle and the instance directory must share an ` +
        "APFS volume. Move the bundle, or point MACHINEN_MACOS_INSTANCES_DIR at its volume.",
      { cause: err },
    );
  }
}

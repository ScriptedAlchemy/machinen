// Find a guest on the host's NAT network.
//
// Virtualization.framework's NAT attachment hands out addresses through the
// host's bootpd, which records them in a world-readable lease file. Every
// instance gets a new MAC address, so a matching lease can only belong to this
// guest, never to an earlier boot of the same bundle.

import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

import { BootError } from "../../errors.ts";

export const DHCP_LEASES_PATH = "/var/db/dhcpd_leases";

/** bootpd writes octets without leading zeros, so `02:0a` appears as `2:a`. */
export function normalizeMacAddress(mac: string): string {
  return mac
    .trim()
    .toLowerCase()
    .split(":")
    .map((octet) => octet.replace(/^0+(?=.)/, ""))
    .join(":");
}

/** The newest lease for `mac` in the bootpd lease file, if there is one. */
export function findLeaseAddress(leases: string, mac: string): string | undefined {
  const wanted = normalizeMacAddress(mac);
  let best: { address: string; expires: number } | undefined;
  for (const block of leases.matchAll(/\{([^}]*)\}/g)) {
    const fields = parseLeaseBlock(block[1]!);
    if (fields.get("hw_address")?.split(",").pop() !== wanted) {
      continue;
    }
    const address = fields.get("ip_address");
    const expires = Number(fields.get("lease") ?? 0);
    if (address && (!best || expires >= best.expires)) {
      best = { address, expires };
    }
  }
  return best?.address;
}

function parseLeaseBlock(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of block.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  return fields;
}

/** Poll the lease file until the guest appears, its runner dies, or time runs out. */
export async function waitForGuestAddress(args: {
  macAddress: string;
  deadline: number;
  isAlive: () => boolean;
  leasesPath?: string;
  pollMs?: number;
}): Promise<string> {
  const leasesPath = args.leasesPath ?? DHCP_LEASES_PATH;
  while (Date.now() < args.deadline) {
    if (!args.isAlive()) {
      throw new BootError(
        "PROVIDER_READINESS_FAILED",
        `macOS runner exited before guest ${args.macAddress} appeared on the network.`,
      );
    }
    const address = readLeaseAddress(leasesPath, args.macAddress);
    if (address) {
      return address;
    }
    await delay(args.pollMs ?? 500);
  }
  throw new BootError(
    "PROVIDER_READINESS_FAILED",
    `macOS guest ${args.macAddress} never received a DHCP lease in ${leasesPath}. ` +
      "Check that the guest finished booting, or pass its address with --ssh-host.",
  );
}

function readLeaseAddress(leasesPath: string, macAddress: string): string | undefined {
  if (!existsSync(leasesPath)) {
    return undefined;
  }
  return findLeaseAddress(readFileSync(leasesPath, "utf8"), macAddress);
}

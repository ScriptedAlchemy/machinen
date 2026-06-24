import { existsSync, readFileSync } from "node:fs";
import { arch as osArch, homedir } from "node:os";
import { join, resolve } from "node:path";

import { ProvisionError } from "./errors.ts";

/**
 * Resolve the path to the base rootfs tarball. Fallback chain:
 * explicit → `MACHINEN_ASSETS_DIR/<arch rootfs>` → `@machinen/cli`
 * cache at `<base>/rootfs.tar.gz`.
 *
 * @throws {ProvisionError} PROVISION_BASE_NOT_FOUND |
 *   PROVISION_ASSETS_DIR_INVALID
 */
export function resolveBaseRootfs(explicit?: string, cwd: string = process.cwd()): string {
  const spec = baseAssetSpec();
  return resolveBaseAsset(
    {
      kind: "base rootfs",
      param: "base",
      assetsDirName: spec.rootfsAsset,
      cliCacheName: "rootfs.tar.gz",
      missingCode: "PROVISION_BASE_NOT_FOUND",
    },
    explicit,
    cwd,
  );
}

/**
 * Resolve the path to the guest kernel image. Same fallback chain as
 * `resolveBaseRootfs`: explicit → `MACHINEN_ASSETS_DIR/<arch kernel>` →
 * `@machinen/cli` cache at `<base>/Image`.
 *
 * @throws {ProvisionError} PROVISION_KERNEL_NOT_FOUND |
 *   PROVISION_ASSETS_DIR_INVALID
 */
export function resolveBaseKernel(explicit?: string, cwd: string = process.cwd()): string {
  const spec = baseAssetSpec();
  return resolveBaseAsset(
    {
      kind: "kernel image",
      param: "kernel",
      assetsDirName: spec.kernelAsset,
      cliCacheName: "Image",
      missingCode: "PROVISION_KERNEL_NOT_FOUND",
    },
    explicit,
    cwd,
  );
}

/**
 * Resolve the path to the guest DTB. amd64 guests do not use a DTB unless
 * the caller passes one explicitly. arm64 follows the same fallback chain as
 * `resolveBaseRootfs`: explicit → `MACHINEN_ASSETS_DIR/virt-arm64.dtb` →
 * `@machinen/cli` cache at `<base>/virt.dtb`.
 *
 * @throws {ProvisionError} PROVISION_DTB_NOT_FOUND |
 *   PROVISION_ASSETS_DIR_INVALID
 */
export function resolveBaseDtb(explicit?: string, cwd: string = process.cwd()): string | undefined {
  if (!explicit && guestCpu() === "amd64") {
    return undefined;
  }
  const spec = baseAssetSpec();
  return resolveBaseAsset(
    {
      kind: "device tree blob",
      param: "dtb",
      assetsDirName: spec.dtbAsset ?? "virt-arm64.dtb",
      cliCacheName: "virt.dtb",
      missingCode: "PROVISION_DTB_NOT_FOUND",
    },
    explicit,
    cwd,
  );
}

type GuestCpu = "arm64" | "amd64";

function guestCpu(): GuestCpu {
  const override = process.env.MACHINEN_GUEST_ARCH;
  if (override === "arm64" || override === "amd64") {
    return override;
  }
  return osArch() === "x64" ? "amd64" : "arm64";
}

function baseAssetSpec(): {
  cpu: GuestCpu;
  kernelAsset: string;
  dtbAsset?: string;
  rootfsAsset: string;
} {
  return guestCpu() === "amd64"
    ? {
        cpu: "amd64",
        kernelAsset: "bzImage-x86_64",
        rootfsAsset: "rootfs-debian-amd64.tar.gz",
      }
    : {
        cpu: "arm64",
        kernelAsset: "Image-arm64",
        dtbAsset: "virt-arm64.dtb",
        rootfsAsset: "rootfs-debian-arm64.tar.gz",
      };
}

interface BaseAssetSpec {
  kind: string;
  param: string;
  assetsDirName: string;
  cliCacheName: string;
  missingCode:
    | "PROVISION_BASE_NOT_FOUND"
    | "PROVISION_KERNEL_NOT_FOUND"
    | "PROVISION_DTB_NOT_FOUND";
}

function resolveBaseAsset(spec: BaseAssetSpec, explicit: string | undefined, cwd: string): string {
  if (explicit) {
    const abs = resolve(cwd, explicit);
    if (!existsSync(abs)) {
      throw new ProvisionError(spec.missingCode, `${spec.kind} not found: ${abs}`);
    }
    return abs;
  }

  const assetsDir = process.env.MACHINEN_ASSETS_DIR;
  if (assetsDir) {
    const p = resolve(assetsDir, spec.assetsDirName);
    if (!existsSync(p)) {
      throw new ProvisionError(
        "PROVISION_ASSETS_DIR_INVALID",
        `MACHINEN_ASSETS_DIR=${assetsDir} does not contain ${spec.assetsDirName}`,
      );
    }
    return p;
  }

  const cached = join(cliCachedBaseDir(), spec.cliCacheName);
  if (existsSync(cached)) {
    return cached;
  }

  throw new ProvisionError(
    spec.missingCode,
    `${spec.kind} not found. Either:\n` +
      `  - pass \`${spec.param}\` explicitly, or\n` +
      `  - set MACHINEN_ASSETS_DIR to a directory containing ${spec.assetsDirName}, or\n` +
      `  - install @machinen/cli and run it once to populate ${cached}`,
  );
}

function cliCachedBaseDir(): string {
  const pkgPath = resolve(import.meta.dirname, "..", "package.json");
  const version = (JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string }).version;
  const spec = baseAssetSpec();
  return join(homedir(), ".machinen", `runtime-v${version}`, "bases", `debian-${spec.cpu}`);
}

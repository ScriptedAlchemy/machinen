// Runs the Swift runner's native self-check on hosts that can build it. This is
// what proves the guest configuration validates: compiling the runner and asking
// it for a version proves neither that nor that its status file works.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const canBuildRunner =
  process.platform === "darwin" &&
  process.arch === "arm64" &&
  spawnSync("swiftc", ["--version"]).status === 0;

describe.runIf(canBuildRunner)("machinen-vz-runner native checks", () => {
  it("passes its self-check", () => {
    const script = fileURLToPath(
      new URL("../../../native-arm64-darwin/vz-runner/test.sh", import.meta.url),
    );
    const result = spawnSync("bash", [script], { encoding: "utf8" });
    expect(result.stdout).toContain("all native checks passed");
    expect(result.status).toBe(0);
  }, 180_000);
});

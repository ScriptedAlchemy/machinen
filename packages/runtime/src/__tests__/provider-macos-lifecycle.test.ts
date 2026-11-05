// macOS guest lifecycle against a fake runner and a fake `ssh`, both real
// processes on PATH. No Virtualization.framework and no guest are involved, but
// the registry, process identity checks, signals, and cleanup are the real ones.

import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A cloning filesystem and a Darwin host are the two things CI does not have.
// Everything else below runs for real on Linux and macOS alike.
vi.mock("../provider/macos/clone.ts", () => ({
  cloneFile: (source: string, destination: string) => copyFileSync(source, destination),
}));
vi.mock("../provider/select.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../provider/select.ts")>()),
  assertProviderHostSupported: () => undefined,
}));

// Each boot and stop runs several real processes, which adds up on a busy host.
vi.setConfig({ testTimeout: 30_000 });

const { boot } = await import("../vm/boot.ts");
const { attach } = await import("../vm/attach.ts");
const { list, readEntry, findEntry } = await import("../registry.ts");
const { readProcessIdentity, validatePid } = await import("../pid-validate.ts");
const { assertRunnerLive, stopMacosGuest } = await import("../provider/macos/control.ts");
const { macosInstancesRoot } = await import("../provider/macos/instance.ts");

const FAKE_RUNNER = `#!/bin/bash
if [ "$1" = "--create-identity" ]; then
  if [ -e "$2" ]; then exit 2; fi
  echo identity > "$2"
  exit 0
fi
args="$*"
while [ $# -gt 0 ]; do
  case "$1" in
    --status-file) status="$2"; shift 2 ;;
    --mac-address) mac="$2"; shift 2 ;;
    --bundle) bundle="$2"; shift 2 ;;
    *) shift ;;
  esac
done
write() {
  printf '{"state":"%s","macAddress":"%s"%s}' "$1" "$mac" "$2" > "$status.tmp"
  mv "$status.tmp" "$status"
}
echo "$args" >> "$FAKE_RUNNER_ARGS_LOG"
case "$FAKE_RUNNER_MODE" in
  die)
    echo "fake runner exploded" >&2
    exit 2
    ;;
  report-failure)
    write failed ',"error":"the guest refused to start"'
    exit 1
    ;;
  never-ready)
    write starting
    ;;
  ignore-term)
    trap 'echo TERM >> "$FAKE_RUNNER_SIGNALS"' TERM
    trap 'echo USR1 >> "$FAKE_RUNNER_SIGNALS"; write stopped ",\\"stopReason\\":\\"forced\\""; exit 0' USR1
    write running
    ;;
  ignore-all)
    trap 'echo TERM >> "$FAKE_RUNNER_SIGNALS"' TERM
    trap 'echo USR1 >> "$FAKE_RUNNER_SIGNALS"' USR1
    write running
    ;;
  *)
    trap 'echo TERM >> "$FAKE_RUNNER_SIGNALS"; write stopped ",\\"stopReason\\":\\"guest\\""; exit 0' TERM
    trap 'echo USR1 >> "$FAKE_RUNNER_SIGNALS"; write stopped ",\\"stopReason\\":\\"forced\\""; exit 0' USR1
    write running
    ;;
esac
while :; do sleep 0.05; done
`;

// Runs the remote command locally. A rejected key and the pinned-key check
// behave the way real ssh does, so the boot and attach paths meet real failures.
const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$@" >> "$FAKE_SSH_LOG"
if [ -n "$FAKE_SSH_FAILURE" ]; then
  echo "$FAKE_SSH_FAILURE" >&2
  exit 255
fi
known_hosts=""
policy=""
for arg in "$@"; do
  case "$arg" in
    UserKnownHostsFile=*) known_hosts="\${arg#UserKnownHostsFile=}" ;;
    StrictHostKeyChecking=*) policy="\${arg#StrictHostKeyChecking=}" ;;
  esac
done
if [ "$policy" = "accept-new" ] && [ ! -s "$known_hosts" ]; then
  echo "fake-guest ssh-ed25519 AAAAkey" >> "$known_hosts"
fi
if [ ! -s "$known_hosts" ]; then
  echo "Host key verification failed." >&2
  exit 255
fi
for last in "$@"; do :; done
case "$last" in
  *shutdown*) echo shutdown >> "$FAKE_SSH_SHUTDOWN_LOG"; exit "\${FAKE_SSH_SHUTDOWN_EXIT:-1}" ;;
esac
eval "$last"
`;

let root: string;
let bundle: string;
let identityFile: string;
let signalsLog: string;
let sshLog: string;
const savedEnv = { ...process.env };
const spawned: ChildProcess[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "machinen-macos-life-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "machinen-vz-runner"), FAKE_RUNNER);
  writeFileSync(join(bin, "ssh"), FAKE_SSH);
  chmodSync(join(bin, "machinen-vz-runner"), 0o755);
  chmodSync(join(bin, "ssh"), 0o755);

  bundle = join(root, "base-bundle");
  mkdirSync(bundle);
  writeFileSync(join(bundle, "disk.img"), "base disk contents");
  writeFileSync(join(bundle, "aux.img"), "base aux contents");
  writeFileSync(join(bundle, "hardwareModel.bin"), "base hardware model");
  writeFileSync(
    join(bundle, "config.json"),
    JSON.stringify({
      diskImage: "disk.img",
      auxiliaryStorage: "aux.img",
      hardwareModel: "hardwareModel.bin",
    }),
  );
  identityFile = join(root, "id_ed25519");
  writeFileSync(identityFile, "PRIVATE-KEY-MATERIAL");
  signalsLog = join(root, "signals.log");
  sshLog = join(root, "ssh.log");

  process.env.PATH = `${bin}:${savedEnv.PATH}`;
  process.env.MACHINEN_REGISTRY_DIR = join(root, "registry", "vms");
  process.env.MACHINEN_VZ_RUNNER = join(bin, "machinen-vz-runner");
  process.env.FAKE_RUNNER_SIGNALS = signalsLog;
  process.env.FAKE_RUNNER_ARGS_LOG = join(root, "runner-args.log");
  process.env.FAKE_SSH_LOG = sshLog;
  process.env.FAKE_SSH_SHUTDOWN_LOG = join(root, "shutdown.log");
  delete process.env.FAKE_RUNNER_MODE;
  delete process.env.FAKE_SSH_FAILURE;
  delete process.env.MACHINEN_MACOS_INSTANCES_DIR;
  delete process.env.MACHINEN_MACOS_SSH_KEY;
});

afterEach(async () => {
  for (const entry of list()) {
    try {
      process.kill(entry.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  for (const child of spawned.splice(0)) {
    child.kill("SIGKILL");
  }
  process.env = { ...savedEnv };
  rmSync(root, { recursive: true, force: true });
});

function bootOptions(overrides: Record<string, unknown> = {}) {
  return {
    guestOS: "macos" as const,
    detached: true,
    name: "mac-test",
    macos: {
      source: { kind: "prepared-bundle" as const, path: bundle },
      ssh: { user: "vmuser", identityFile, host: "127.0.0.1" },
      readinessTimeoutMs: 15_000,
    },
    ...overrides,
  };
}

function instances(): string[] {
  const dir = macosInstancesRoot();
  return existsSync(dir) ? readdirSync(dir) : [];
}

function signals(): string[] {
  return existsSync(signalsLog) ? readFileSync(signalsLog, "utf8").trim().split("\n") : [];
}

async function waitForDeath(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid ${pid} did not die`);
}

function bundleFingerprint(): string {
  return readdirSync(bundle)
    .sort()
    .map((name) => {
      const stat = statSync(join(bundle, name));
      return `${name}:${stat.size}:${stat.mtimeMs}:${readFileSync(join(bundle, name), "utf8")}`;
    })
    .join("\n");
}

describe("macOS boot", () => {
  it("refuses an attached boot before spawning anything", async () => {
    const err = await boot(bootOptions({ detached: false })).catch((e) => e);
    expect(err.code).toBe("PROVIDER_UNSUPPORTED_OPERATION");
    expect(err.message).toContain("detached");
    expect(instances()).toEqual([]);
  });

  it("registers a real runner identity, never key material", async () => {
    const vm = await boot(bootOptions());
    const entry = readEntry(vm.pid)!;
    expect(entry.guestOS).toBe("macos");
    expect(entry.provider).toBe("apple-vz");
    expect(entry.providerRef).toBe(bundle);
    expect(entry.capabilities?.pty).toBe(false);
    expect(entry.vmmExe).toBe(readProcessIdentity(vm.pid)!.exeBase);
    expect(entry.startedAt).toBe(readProcessIdentity(vm.pid)!.startedAtMs);
    expect(entry.macos?.identityFile).toBe(identityFile);
    expect(entry.macos?.sshHost).toBe("127.0.0.1");
    expect(entry.macos?.macAddress).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
    const meta = readFileSync(
      join(process.env.MACHINEN_REGISTRY_DIR!, String(vm.pid), "meta.json"),
    );
    expect(meta.toString()).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(readFileSync(entry.macos!.logPath, "utf8")).not.toContain("PRIVATE-KEY-MATERIAL");
    expect(readFileSync(sshLog, "utf8")).not.toContain("PRIVATE-KEY-MATERIAL");
  });

  it("boots from a clone with its own identity and leaves the base untouched", async () => {
    const before = bundleFingerprint();
    const vm = await boot(bootOptions());
    const { instanceDir } = readEntry(vm.pid)!.macos!;
    expect(instanceDir.startsWith(bundle)).toBe(false);
    expect(readFileSync(join(instanceDir, "disk.img"), "utf8")).toBe("base disk contents");
    expect(readFileSync(join(instanceDir, "machineIdentifier.bin"), "utf8")).toBe("identity\n");
    const config = JSON.parse(readFileSync(join(instanceDir, "config.json"), "utf8"));
    expect(config.machineIdentifier).toBe("machineIdentifier.bin");

    writeFileSync(join(instanceDir, "disk.img"), "guest wrote here");
    await vm.kill();
    expect(bundleFingerprint()).toBe(before);
    expect(existsSync(join(bundle, "machineIdentifier.bin"))).toBe(false);
  });

  it("gives concurrent guests separate instances, MAC addresses, and PIDs", async () => {
    const first = await boot(bootOptions({ name: "mac-a" }));
    const second = await boot(bootOptions({ name: "mac-b" }));
    const a = readEntry(first.pid)!.macos!;
    const b = readEntry(second.pid)!.macos!;
    expect(first.pid).not.toBe(second.pid);
    expect(a.instanceDir).not.toBe(b.instanceDir);
    expect(a.macAddress).not.toBe(b.macAddress);
    expect(a.knownHostsPath).not.toBe(b.knownHostsPath);
    await first.kill();
    await second.kill();
  });

  it("refuses a name already held by a live guest, before cloning", async () => {
    const vm = await boot(bootOptions());
    const before = instances();
    const err = await boot(bootOptions()).catch((e) => e);
    expect(err.code).toBe("REGISTRY_NAME_IN_USE");
    expect(instances()).toEqual(before);
    await vm.kill();
  });

  it("leaves no runner, entry, or instance when the runner dies", async () => {
    process.env.FAKE_RUNNER_MODE = "die";
    const err = await boot(bootOptions()).catch((e) => e);
    expect(err.code).toBe("PROVIDER_READINESS_FAILED");
    expect(err.message).toContain("fake runner exploded");
    expect(instances()).toEqual([]);
    expect(list()).toEqual([]);
  });

  it("reports the runner's own failure", async () => {
    process.env.FAKE_RUNNER_MODE = "report-failure";
    const err = await boot(bootOptions()).catch((e) => e);
    expect(err.code).toBe("PROVIDER_READINESS_FAILED");
    expect(err.message).toContain("the guest refused to start");
    expect(instances()).toEqual([]);
  });

  it("kills the runner when it never becomes ready", async () => {
    process.env.FAKE_RUNNER_MODE = "never-ready";
    const options = bootOptions();
    options.macos.readinessTimeoutMs = 300;
    const err = await boot(options).catch((e) => e);
    expect(err.code).toBe("PROVIDER_READINESS_FAILED");
    expect(err.message).toContain("did not reach readiness");
    expect(instances()).toEqual([]);
    expect(list()).toEqual([]);
  });

  it("fails fast on a rejected key and leaves no runner behind", async () => {
    process.env.FAKE_SSH_FAILURE = "vmuser@127.0.0.1: Permission denied (publickey).";
    const started = Date.now();
    const err = await boot(bootOptions()).catch((e) => e);
    expect(err.code).toBe("PROVIDER_TRANSPORT_FAILED");
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(instances()).toEqual([]);
    expect(list()).toEqual([]);
  });

  it("is listed while it boots, so a crash here cannot strand it", async () => {
    process.env.FAKE_RUNNER_MODE = "never-ready";
    const options = bootOptions();
    options.macos.readinessTimeoutMs = 1_000;
    const pending = boot(options).catch((e) => e);
    await vi.waitFor(() => expect(findEntry({ name: "mac-test" })).toBeDefined(), {
      timeout: 900,
      interval: 20,
    });
    expect(findEntry({ name: "mac-test" })?.macos?.sshHost).toBeUndefined();
    await pending;
  });
});

describe("macOS attach", () => {
  it("rejoins from the registry using the key path and host key the boot recorded", async () => {
    const vm = await boot(bootOptions());
    const entry = readEntry(vm.pid)!;
    const pinned = readFileSync(entry.macos!.knownHostsPath, "utf8");
    expect(pinned).toContain("AAAAkey");

    const attached = await attach({ name: "mac-test" });
    await expect(attached.execRaw("echo hello")).resolves.toMatchObject({
      exitCode: 0,
      stdout: "hello\n",
    });
    expect(readFileSync(entry.macos!.knownHostsPath, "utf8")).toBe(pinned);
    const args = readFileSync(sshLog, "utf8").split("\n");
    expect(args.at(args.lastIndexOf("StrictHostKeyChecking=yes"))).toBe(
      "StrictHostKeyChecking=yes",
    );
    expect(args).toContain(`UserKnownHostsFile=${entry.macos!.knownHostsPath}`);
    expect(args).toContain(identityFile);
    await vm.kill();
  });

  it("refuses to attach when no host key was pinned", async () => {
    const vm = await boot(bootOptions());
    writeFileSync(readEntry(vm.pid)!.macos!.knownHostsPath, "");
    const err = await attach({ name: "mac-test" }).catch((e) => e);
    expect(err.code).toBe("PROVIDER_TRANSPORT_FAILED");
    expect(err.message).toContain("pinned host key");
    await vm.kill();
  });

  it("prefers an explicit identity file over the recorded one", async () => {
    const vm = await boot(bootOptions());
    const other = join(root, "other_key");
    const attached = await attach({ name: "mac-test", identityFile: other });
    await attached.execRaw("true");
    const args = readFileSync(sshLog, "utf8").split("\n");
    expect(args.at(args.lastIndexOf("-i") + 1)).toBe(other);
    await vm.kill();
  });

  it("can stop a guest that is still booting", async () => {
    process.env.FAKE_RUNNER_MODE = "never-ready";
    process.env.FAKE_SSH_LOG = sshLog;
    const options = bootOptions();
    options.macos.readinessTimeoutMs = 8_000;
    const pending = boot(options).catch((e) => e);
    await vi.waitFor(() => expect(findEntry({ name: "mac-test" })).toBeDefined(), {
      timeout: 5_000,
      interval: 20,
    });
    const attached = await attach({ name: "mac-test" });
    await expect(attached.execRaw("true")).rejects.toMatchObject({
      code: "PROVIDER_READINESS_FAILED",
    });
    process.kill(attached.pid, "SIGKILL");
    await pending;
  });

  it("refuses to run a command once the runner has died", async () => {
    const vm = await boot(bootOptions());
    const attached = await attach({ name: "mac-test" });
    process.kill(vm.pid, "SIGKILL");
    await waitForDeath(vm.pid);
    await expect(attached.execRaw("true")).rejects.toMatchObject({
      code: "PROVIDER_TRANSPORT_FAILED",
    });
  });
});

describe("macOS stop", () => {
  const FAST = { gracefulMs: 500, forceMs: 500, killMs: 2_000, pollMs: 20 };

  function identityOf(pid: number) {
    const entry = readEntry(pid)!;
    return { pid, exe: entry.vmmExe!, startedAt: entry.startedAt };
  }

  const noTransport = {
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    writeFile: async () => undefined,
  };

  it("stops gracefully, without cutting power, and releases everything", async () => {
    const vm = await boot(bootOptions());
    const { instanceDir, statusPath } = readEntry(vm.pid)!.macos!;
    const waited = vm.wait();
    await stopMacosGuest({
      identity: identityOf(vm.pid),
      transport: noTransport,
      instanceDir: `${instanceDir}-not-yet`,
      timeouts: FAST,
    });
    expect(signals()).toEqual(["TERM"]);
    expect(existsSync(statusPath)).toBe(true);
    expect(JSON.parse(readFileSync(statusPath, "utf8")).stopReason).toBe("guest");
    expect(await waited).toEqual({ code: 0, signal: null });
    expect(readEntry(vm.pid)).toBeUndefined();
  });

  it("asks the guest to shut down before signalling the runner", async () => {
    const vm = await boot(bootOptions());
    await vm.kill();
    expect(readFileSync(process.env.FAKE_SSH_SHUTDOWN_LOG!, "utf8")).toContain("shutdown");
    expect(signals()).toEqual(["TERM"]);
    expect(instances()).toEqual([]);
    expect(list()).toEqual([]);
    expect(findEntry({ name: "mac-test" })).toBeUndefined();
  });

  it("forces the VM off only after the guest has had its chance", async () => {
    process.env.FAKE_RUNNER_MODE = "ignore-term";
    const vm = await boot(bootOptions());
    const { instanceDir, statusPath } = readEntry(vm.pid)!.macos!;
    const started = Date.now();
    await stopMacosGuest({
      identity: identityOf(vm.pid),
      transport: noTransport,
      instanceDir: `${instanceDir}-not-yet`,
      timeouts: FAST,
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(FAST.gracefulMs);
    expect(signals()).toEqual(["TERM", "USR1"]);
    expect(JSON.parse(readFileSync(statusPath, "utf8")).stopReason).toBe("forced");
  });

  it("kills a runner that ignores both requests", async () => {
    process.env.FAKE_RUNNER_MODE = "ignore-all";
    const vm = await boot(bootOptions());
    const { instanceDir } = readEntry(vm.pid)!.macos!;
    await stopMacosGuest({
      identity: identityOf(vm.pid),
      transport: noTransport,
      instanceDir,
      timeouts: FAST,
    });
    expect(signals()).toEqual(["TERM", "USR1"]);
    expect(existsSync(instanceDir)).toBe(false);
    await waitForDeath(vm.pid);
  });

  it("never signals a recycled pid", async () => {
    const stranger = spawn("sleep", ["30"], { stdio: "ignore" });
    spawned.push(stranger);
    const instanceDir = join(root, "stale-instance");
    mkdirSync(instanceDir);
    await stopMacosGuest({
      // The pid is alive, but it is not the process this identity recorded.
      identity: { pid: stranger.pid!, exe: "machinen-vz-runner", startedAt: 1 },
      transport: noTransport,
      instanceDir,
      timeouts: FAST,
    });
    expect(stranger.exitCode).toBeNull();
    expect(stranger.signalCode).toBeNull();
    expect(() => process.kill(stranger.pid!, 0)).not.toThrow();
    expect(existsSync(instanceDir)).toBe(false);
  });

  it("reclaims the instance of a guest whose runner died on its own", async () => {
    const vm = await boot(bootOptions());
    const { instanceDir } = readEntry(vm.pid)!.macos!;
    process.kill(vm.pid, "SIGKILL");
    await waitForDeath(vm.pid);
    expect(list()).toEqual([]);
    expect(existsSync(instanceDir)).toBe(false);
    expect(readEntry(vm.pid)).toBeUndefined();
  });
});

describe("macOS runner identity", () => {
  async function spawnNamedRunner(): Promise<{ child: ChildProcess; path: string }> {
    // A real process the OS reports under the runner's name, so this checks what
    // the OS actually says rather than the shape of a record. Linux reads the
    // executable's path, which takes a copy. macOS reads argv[0], and its launch
    // constraints would kill a relocated copy of a system binary.
    const path = join(root, "machinen-vz-runner");
    const sleep = "/bin/sleep";
    if (process.platform !== "darwin") {
      copyFileSync(sleep, path);
      chmodSync(path, 0o755);
    }
    const child =
      process.platform === "darwin"
        ? spawn(sleep, ["30"], { stdio: "ignore", argv0: path })
        : spawn(path, ["30"], { stdio: "ignore" });
    spawned.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    return { child, path };
  }

  it("reports the runner's real name and start time", async () => {
    const { child } = await spawnNamedRunner();
    const before = Date.now();
    const identity = readProcessIdentity(child.pid!)!;
    expect(identity.exeBase).toBe("machinen-vz-runner");
    expect(typeof identity.startedAtMs).toBe("number");
    expect(Math.abs(identity.startedAtMs! - before)).toBeLessThan(10_000);
  });

  it("is alive while the recorded identity matches", async () => {
    const { child, path } = await spawnNamedRunner();
    const { startedAtMs } = readProcessIdentity(child.pid!)!;
    expect(validatePid(child.pid!, { vmmExe: path, startedAt: startedAtMs })).toBe("alive");
    expect(() =>
      assertRunnerLive({ pid: child.pid!, exe: path, startedAt: startedAtMs! }),
    ).not.toThrow();
  });

  it("is recycled when a different executable holds the pid", async () => {
    const { child } = await spawnNamedRunner();
    const { startedAtMs } = readProcessIdentity(child.pid!)!;
    expect(validatePid(child.pid!, { vmmExe: "not-the-runner", startedAt: startedAtMs })).toBe(
      "recycled",
    );
  });

  it("is recycled when the same name started at another time", async () => {
    const { child, path } = await spawnNamedRunner();
    const { startedAtMs } = readProcessIdentity(child.pid!)!;
    const stale = startedAtMs! - 3_600_000;
    expect(validatePid(child.pid!, { vmmExe: path, startedAt: stale })).toBe("recycled");
    expect(() => assertRunnerLive({ pid: child.pid!, exe: path, startedAt: stale })).toThrow(
      /no longer ours/,
    );
  });

  it("is dead once the process exits", async () => {
    const { child, path } = await spawnNamedRunner();
    const { startedAtMs } = readProcessIdentity(child.pid!)!;
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    expect(validatePid(child.pid!, { vmmExe: path, startedAt: startedAtMs })).toBe("dead");
  });
});

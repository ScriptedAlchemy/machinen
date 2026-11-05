// SSH transport behavior against a fake `ssh` on PATH. The fake evaluates the
// remote command with a real shell, the way a guest's login shell would, so
// quoting, binary streams, exit codes, and host-key policy are all exercised for
// real. Only the network hop is missing.

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findLeaseAddress,
  normalizeMacAddress,
  waitForGuestAddress,
} from "../provider/macos/address.ts";
import { createMacosHandle } from "../provider/macos/handle.ts";
import { generateMacAddress } from "../provider/macos/instance.ts";
import {
  createMacosTransport,
  hasPinnedHostKey,
  type HostKeyPolicy,
} from "../provider/macos/ssh.ts";
import { MACOS_CAPABILITIES } from "../provider/types.ts";

const FAKE_SSH = `#!/bin/sh
printf '%s\\n' "$@" >> "$FAKE_SSH_LOG"
printf -- '--\\n' >> "$FAKE_SSH_LOG"
known_hosts=""
policy=""
for arg in "$@"; do
  case "$arg" in
    UserKnownHostsFile=*) known_hosts="\${arg#UserKnownHostsFile=}" ;;
    StrictHostKeyChecking=*) policy="\${arg#StrictHostKeyChecking=}" ;;
  esac
done
if [ -n "$FAKE_SSH_FAILURE" ]; then
  echo "$FAKE_SSH_FAILURE" >&2
  exit 255
fi
presented="fake-guest ssh-ed25519 \${FAKE_SSH_HOST_KEY:-AAAAkey}"
if [ -s "$known_hosts" ]; then
  if ! grep -qxF "$presented" "$known_hosts"; then
    echo "@@@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @@@" >&2
    echo "Host key verification failed." >&2
    exit 255
  fi
elif [ "$policy" = "accept-new" ]; then
  echo "$presented" >> "$known_hosts"
else
  echo "Host key verification failed." >&2
  exit 255
fi
for last in "$@"; do :; done
eval "$last"
`;

let root: string;
let logPath: string;
let knownHostsPath: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "machinen-macos-ssh-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ssh"), FAKE_SSH);
  chmodSync(join(bin, "ssh"), 0o755);
  logPath = join(root, "ssh.log");
  knownHostsPath = join(root, "known_hosts");
  writeFileSync(knownHostsPath, "");
  process.env.PATH = `${bin}:${savedEnv.PATH}`;
  process.env.FAKE_SSH_LOG = logPath;
  delete process.env.FAKE_SSH_FAILURE;
  delete process.env.FAKE_SSH_HOST_KEY;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.env = { ...savedEnv };
});

function transport(hostKeyPolicy: HostKeyPolicy = "trust-on-first-use") {
  return createMacosTransport({
    user: "vmuser",
    host: "192.168.64.9",
    port: 2222,
    identityFile: join(root, "id_ed25519"),
    knownHostsPath,
    hostKeyPolicy,
  });
}

function loggedArguments(): string[] {
  return readFileSync(logPath, "utf8").split("\n");
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

describe("macOS SSH invocation", () => {
  it("is key-only, non-interactive, and ignores the user's ssh configuration", async () => {
    await transport().exec("true");
    const args = loggedArguments();
    for (const expected of [
      "BatchMode=yes",
      "PasswordAuthentication=no",
      "KbdInteractiveAuthentication=no",
      "IdentitiesOnly=yes",
      "IdentityAgent=none",
      "GlobalKnownHostsFile=/dev/null",
      `UserKnownHostsFile=${knownHostsPath}`,
    ]) {
      expect(args).toContain(expected);
    }
    expect(args[args.indexOf("-F") + 1]).toBe("none");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
    expect(args[args.indexOf("-i") + 1]).toBe(join(root, "id_ed25519"));
    expect(args).toContain("vmuser@192.168.64.9");
  });

  it("never reads the identity file itself", async () => {
    // The file does not exist. Passing it by path has to be enough.
    await expect(transport().exec("true")).resolves.toMatchObject({ exitCode: 0 });
    expect(existsSync(join(root, "id_ed25519"))).toBe(false);
  });
});

describe("macOS host key trust", () => {
  it("records the key on first use and accepts it once pinned", async () => {
    expect(hasPinnedHostKey(knownHostsPath)).toBe(false);
    await transport("trust-on-first-use").exec("true");
    expect(hasPinnedHostKey(knownHostsPath)).toBe(true);
    await expect(transport("pinned").exec("true")).resolves.toMatchObject({ exitCode: 0 });
  });

  it("refuses an unknown key when pinned", async () => {
    const err = await transport("pinned")
      .exec("true")
      .catch((e) => e);
    expect(err.code).toBe("PROVIDER_TRANSPORT_FAILED");
    expect(err.retryable).toBe(false);
  });

  it("refuses a changed key, and does not treat it as retryable", async () => {
    await transport("trust-on-first-use").exec("true");
    process.env.FAKE_SSH_HOST_KEY = "AAAAother";
    const err = await transport("pinned")
      .exec("true")
      .catch((e) => e);
    expect(err.code).toBe("PROVIDER_TRANSPORT_FAILED");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("Host key verification failed");
  });
});

describe("macOS SSH failure classification", () => {
  it("treats a rejected key as a fatal transport failure", async () => {
    process.env.FAKE_SSH_FAILURE = "vmuser@192.168.64.9: Permission denied (publickey).";
    const err = await transport()
      .exec("true")
      .catch((e) => e);
    expect(err.code).toBe("PROVIDER_TRANSPORT_FAILED");
    expect(err.retryable).toBe(false);
  });

  it.each([
    "ssh: connect to host 192.168.64.9 port 2222: Connection refused",
    "ssh: connect to host 192.168.64.9 port 2222: Operation timed out",
    "ssh: connect to host 192.168.64.9 port 2222: No route to host",
    "kex_exchange_identification: Connection closed by remote host",
  ])("treats %s as retryable", async (failure) => {
    process.env.FAKE_SSH_FAILURE = failure;
    const err = await transport()
      .exec("true")
      .catch((e) => e);
    expect(err.code).toBe("PROVIDER_TRANSPORT_FAILED");
    expect(err.retryable).toBe(true);
  });

  it("reports a guest command that exits 255 as that command's exit code", async () => {
    const result = await transport().exec("exit 255");
    expect(result.exitCode).toBe(255);
  });
});

describe("macOS exec", () => {
  it("keeps stdout, stderr, and the exit code apart", async () => {
    const result = await transport().exec("echo out; echo err >&2; exit 7");
    expect(result).toEqual({ exitCode: 7, stdout: "out\n", stderr: "err\n" });
  });

  it("streams through callbacks without buffering a second copy", async () => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const result = await transport().exec("echo out; echo err >&2", {
      onStdout: (chunk) => out.push(chunk),
      onStderr: (chunk) => err.push(chunk),
    });
    expect(Buffer.concat(out).toString()).toBe("out\n");
    expect(Buffer.concat(err).toString()).toBe("err\n");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("delivers binary stdout intact through the streaming callback", async () => {
    const source = join(root, "binary.bin");
    const payload = randomBytes(256 * 1024);
    writeFileSync(source, payload);
    const chunks: Buffer[] = [];
    await transport().exec(`cat '${source}'`, { onStdout: (chunk) => chunks.push(chunk) });
    expect(sha256(Buffer.concat(chunks))).toBe(sha256(payload));
  });

  it("runs under sh -c regardless of the guest user's shell", async () => {
    const result = await transport().exec("echo \"quoted 'value' $((1 + 2))\"");
    expect(result.stdout).toBe("quoted 'value' 3\n");
    expect(loggedArguments().some((arg) => arg.startsWith("/bin/sh -c "))).toBe(true);
  });

  it("times out instead of hanging", async () => {
    const err = await transport()
      .exec("sleep 30", { execTimeoutMs: 100 })
      .catch((e) => e);
    expect(err.code).toBe("EXEC_AGENT_TIMEOUT");
  });
});

describe("macOS writeFile", () => {
  it("round-trips multi-megabyte binary content", async () => {
    const target = join(root, "guest", "nested", "payload.bin");
    const payload = randomBytes(8 * 1024 * 1024);
    await transport().writeFile(target, payload);
    expect(sha256(readFileSync(target))).toBe(sha256(payload));
  });

  it("does not put file contents on the command line", async () => {
    const target = join(root, "secret.txt");
    await transport().writeFile(target, "marker-that-must-stay-out-of-argv");
    expect(readFileSync(target, "utf8")).toBe("marker-that-must-stay-out-of-argv");
    expect(readFileSync(logPath, "utf8")).not.toContain("marker-that-must-stay-out-of-argv");
  });

  it("creates an empty file for a zero-byte write", async () => {
    const target = join(root, "empty.bin");
    await transport().writeFile(target, Buffer.alloc(0));
    expect(statSync(target).size).toBe(0);
  });

  it.each([
    "with space.txt",
    "it's quoted.txt",
    'dollar$(touch pwned)".txt',
    "-leading-dash.txt",
    "new\nline.txt",
  ])("handles the file name %j", async (name) => {
    const target = join(root, name);
    await transport().writeFile(target, "content");
    expect(readFileSync(target, "utf8")).toBe("content");
    expect(existsSync(join(process.cwd(), "pwned"))).toBe(false);
  });

  it("creates parent directories by default and not with recursive: false", async () => {
    const created = join(root, "made", "file.txt");
    await transport().writeFile(created, "x");
    expect(readFileSync(created, "utf8")).toBe("x");

    const refused = join(root, "absent", "file.txt");
    const err = await transport()
      .writeFile(refused, "x", { recursive: false })
      .catch((e) => e);
    expect(err.code).toBe("EXEC_NONZERO_EXIT");
    expect(existsSync(join(root, "absent"))).toBe(false);
  });

  it("applies a mode and appends on request", async () => {
    const target = join(root, "script.sh");
    await transport().writeFile(target, "one\n", { mode: 0o750 });
    expect(statSync(target).mode & 0o7777).toBe(0o750);
    await transport().writeFile(target, "two\n", { append: true });
    expect(readFileSync(target, "utf8")).toBe("one\ntwo\n");
  });

  it.each([-1, 0o10000, 1.5, Number.NaN])("refuses the mode %s before connecting", async (mode) => {
    const err = await transport()
      .writeFile(join(root, "x"), "x", { mode })
      .catch((e) => e);
    expect(err.code).toBe("PROVIDER_UNSUPPORTED_OPERATION");
    expect(existsSync(logPath)).toBe(false);
  });

  it("refuses an unusable path before connecting", async () => {
    const err = await transport()
      .writeFile("", "x")
      .catch((e) => e);
    expect(err.code).toBe("PROVIDER_UNSUPPORTED_OPERATION");
    expect(existsSync(logPath)).toBe(false);
  });

  it("reports a failed write as an error", async () => {
    const err = await transport()
      .writeFile("/nonexistent-root-dir/file.txt", "x", { recursive: false })
      .catch((e) => e);
    expect(err.code).toBe("EXEC_NONZERO_EXIT");
  });
});

describe("macOS handle refusals", () => {
  function handle(assertLive: () => void = () => undefined) {
    return createMacosHandle({
      pid: 1234,
      transport: transport(),
      assertLive,
      wait: async () => ({ code: 0, signal: null }),
      kill: async () => undefined,
    });
  }

  it("declares no PTY, and refuses one without recommending an impossible flag", () => {
    expect(MACOS_CAPABILITIES.pty).toBe(false);
    let thrown: { code?: string; message?: string } = {};
    try {
      handle().execPty("sh", {} as never);
    } catch (err) {
      thrown = err as typeof thrown;
    }
    expect(thrown.code).toBe("PROVIDER_UNSUPPORTED_OPERATION");
    expect(thrown.message).not.toContain("machinen exec --tty");
  });

  it("refuses persistent sessions with a typed error rather than a missing method", async () => {
    const vm = handle();
    await expect(vm.listSessions!()).rejects.toMatchObject({
      code: "PROVIDER_UNSUPPORTED_OPERATION",
    });
    await expect(vm.killSession!("default")).rejects.toMatchObject({
      code: "PROVIDER_UNSUPPORTED_OPERATION",
    });
  });

  it("refuses commands and writes once the runner is no longer the booted one", async () => {
    const gone = Object.assign(new Error("runner gone"), { code: "PROVIDER_TRANSPORT_FAILED" });
    const vm = handle(() => {
      throw gone;
    });
    await expect(vm.execRaw("true")).rejects.toBe(gone);
    await expect(vm.writeFile(join(root, "x"), "x")).rejects.toBe(gone);
    expect(existsSync(logPath)).toBe(false);
  });
});

describe("macOS guest address discovery", () => {
  const LEASES = `{
	name=older-boot
	ip_address=192.168.64.3
	hw_address=1,2:a:0:1:0:ff
	identifier=1,2:a:0:1:0:ff
	lease=0x60000000
}
{
	name=this-guest
	ip_address=192.168.64.7
	hw_address=1,2:a:0:1:0:ff
	identifier=1,2:a:0:1:0:ff
	lease=0x70000000
}
{
	name=other
	ip_address=192.168.64.8
	hw_address=1,2:a:0:1:0:fe
	identifier=1,2:a:0:1:0:fe
	lease=0x70000000
}
`;

  it("normalizes octets the way bootpd writes them", () => {
    expect(normalizeMacAddress("02:0A:00:01:00:FF")).toBe("2:a:0:1:0:ff");
  });

  it("finds the newest lease for a MAC with leading zeros", () => {
    expect(findLeaseAddress(LEASES, "02:0a:00:01:00:ff")).toBe("192.168.64.7");
  });

  it("does not match another guest's lease", () => {
    expect(findLeaseAddress(LEASES, "02:0a:00:01:00:aa")).toBeUndefined();
  });

  it("waits for a lease to appear", async () => {
    const leasesPath = join(root, "leases");
    const pending = waitForGuestAddress({
      macAddress: "02:0a:00:01:00:ff",
      deadline: Date.now() + 2_000,
      isAlive: () => true,
      leasesPath,
      pollMs: 10,
    });
    setTimeout(() => writeFileSync(leasesPath, LEASES), 50);
    await expect(pending).resolves.toBe("192.168.64.7");
  });

  it("gives up when the runner dies, and names the override when time runs out", async () => {
    const leasesPath = join(root, "leases");
    await expect(
      waitForGuestAddress({
        macAddress: "02:0a:00:01:00:ff",
        deadline: Date.now() + 2_000,
        isAlive: () => false,
        leasesPath,
      }),
    ).rejects.toMatchObject({ code: "PROVIDER_READINESS_FAILED" });
    const err = await waitForGuestAddress({
      macAddress: "02:0a:00:01:00:ff",
      deadline: Date.now() + 30,
      isAlive: () => true,
      leasesPath,
      pollMs: 5,
    }).catch((e) => e);
    expect(err.code).toBe("PROVIDER_READINESS_FAILED");
    expect(err.message).toContain("--ssh-host");
  });

  it("generates locally administered unicast addresses", () => {
    for (let i = 0; i < 32; i++) {
      const mac = generateMacAddress();
      expect(mac).toMatch(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/);
      const first = Number.parseInt(mac.slice(0, 2), 16);
      expect(first & 0x01).toBe(0);
      expect(first & 0x02).toBe(0x02);
    }
  });
});

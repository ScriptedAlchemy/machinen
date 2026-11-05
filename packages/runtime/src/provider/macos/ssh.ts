// SSH transport for macOS guests.
//
// Key-based only. Every invocation runs with `BatchMode=yes` so a missing key
// fails instead of falling back to an interactive password prompt, reads no
// user or system ssh configuration, and checks the host key against a per-VM
// known_hosts file. The key is passed by path, so key material never reaches
// argv, logs, or the registry.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

import { ExecError } from "../../errors.ts";
import type { VsockExecOptions, VsockExecResult } from "../../exec.ts";
import type { WriteFileOptions } from "../../vm-handle.ts";

/**
 * `trust-on-first-use` records the key a new guest presents, which only the
 * boot that created the guest may do. `pinned` is every later connection: an
 * unknown or changed key fails.
 */
export type HostKeyPolicy = "trust-on-first-use" | "pinned";

export interface MacosTransport {
  exec(cmd: string, opts?: VsockExecOptions): Promise<VsockExecResult>;
  /** Stream `contents` to a guest file over the SSH channel. Binary safe. */
  writeFile(guestPath: string, contents: Buffer | string, opts?: WriteFileOptions): Promise<void>;
}

interface MacosTransportOptions {
  user: string;
  host: string;
  port: number;
  identityFile: string;
  knownHostsPath: string;
  hostKeyPolicy: HostKeyPolicy;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const STDERR_TAIL_BYTES = 16 * 1024;

/**
 * ssh exits 255 for its own failures, and a guest command can too, so the code
 * alone cannot tell them apart. These are ssh's own diagnostics. `retryable`
 * means the guest may simply not be up yet. The others will not fix themselves.
 */
const TRANSPORT_FAILURES: ReadonlyArray<{ pattern: RegExp; retryable: boolean }> = [
  { pattern: /Permission denied|Too many authentication failures/, retryable: false },
  {
    pattern: /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/,
    retryable: false,
  },
  {
    pattern:
      /^ssh: |Connection (refused|timed out|closed|reset)|kex_exchange_identification|No route to host|Operation timed out/m,
    retryable: true,
  },
];

export function createMacosTransport(opts: MacosTransportOptions): MacosTransport {
  const target = `${opts.user}@${opts.host}`;
  const common = sshArguments(opts);
  return {
    exec(cmd, execOpts) {
      return runSsh(common, target, cmd, execOpts);
    },
    async writeFile(guestPath, contents, writeOpts) {
      const script = writeFileScript(guestPath, writeOpts);
      const result = await runSsh(common, target, script, {
        // ServerAlive notices a dead guest, and a large file has no sensible ceiling.
        execTimeoutMs: null,
        input: typeof contents === "string" ? Buffer.from(contents) : contents,
      });
      if (result.exitCode !== 0) {
        throw new ExecError(
          "EXEC_NONZERO_EXIT",
          `writeFile failed (code ${result.exitCode}): ${guestPath}\nstderr:\n${result.stderr}`,
        );
      }
    },
  };
}

/** Whether the boot that created this guest pinned a host key. */
export function hasPinnedHostKey(knownHostsPath: string): boolean {
  return existsSync(knownHostsPath) && readFileSync(knownHostsPath, "utf8").trim().length > 0;
}

function sshArguments(opts: MacosTransportOptions): string[] {
  const options = [
    "BatchMode=yes",
    "PasswordAuthentication=no",
    "KbdInteractiveAuthentication=no",
    "IdentitiesOnly=yes",
    "IdentityAgent=none",
    `StrictHostKeyChecking=${opts.hostKeyPolicy === "pinned" ? "yes" : "accept-new"}`,
    `UserKnownHostsFile=${opts.knownHostsPath}`,
    "GlobalKnownHostsFile=/dev/null",
    "LogLevel=ERROR",
    "ServerAliveInterval=15",
    "ServerAliveCountMax=3",
  ];
  return [
    "-F",
    "none",
    "-T",
    ...options.flatMap((option) => ["-o", option]),
    "-p",
    String(opts.port),
    "-i",
    opts.identityFile,
  ];
}

interface SshRunOptions extends VsockExecOptions {
  /** Bytes to feed the remote command's stdin. */
  input?: Buffer;
}

function runSsh(
  common: string[],
  target: string,
  cmd: string,
  opts: SshRunOptions = {},
): Promise<VsockExecResult> {
  return new Promise((resolve, reject) => {
    const connectSeconds = Math.ceil((opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS) / 1000);
    const child = spawn(
      "ssh",
      // The exec contract is `sh -c`, whatever login shell the guest user has.
      [
        ...common,
        "-o",
        `ConnectTimeout=${connectSeconds}`,
        target,
        `/bin/sh -c ${shellQuote(cmd)}`,
      ],
      { stdio: [opts.input ? "pipe" : "ignore", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let stderrTail = "";
    let settled = false;
    const timer = startTimeout(opts.execTimeoutMs, () => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(
        new ExecError("EXEC_AGENT_TIMEOUT", `macOS SSH exec timed out: ${cmd}`, {
          retryable: true,
        }),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (opts.onStdout) {
        opts.onStdout(chunk);
      } else {
        out.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
      if (opts.onStderr) {
        opts.onStderr(chunk);
      } else {
        err.push(chunk);
      }
    });
    if (opts.input && child.stdin) {
      // ssh dying mid-write surfaces through its exit code below.
      child.stdin.on("error", () => undefined);
      child.stdin.end(opts.input);
    }
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      stopTimeout(timer);
      reject(
        new ExecError("PROVIDER_TRANSPORT_FAILED", `macOS SSH transport failed: ${error.message}`, {
          retryable: true,
          cause: error,
        }),
      );
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      stopTimeout(timer);
      const failure = code === 255 ? classifySshFailure(stderrTail) : undefined;
      if (failure) {
        reject(failure);
        return;
      }
      resolve({
        exitCode: code ?? 255,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
      });
    });
  });
}

function classifySshFailure(stderr: string): ExecError | undefined {
  const match = TRANSPORT_FAILURES.find((entry) => entry.pattern.test(stderr));
  if (!match) {
    return undefined;
  }
  return new ExecError(
    "PROVIDER_TRANSPORT_FAILED",
    `macOS SSH transport failed: ${stderr.trim()}`,
    {
      retryable: match.retryable,
    },
  );
}

function writeFileScript(guestPath: string, opts: WriteFileOptions = {}): string {
  assertWritableTarget(guestPath, opts.mode);
  const target = shellQuote(guestPath);
  const steps = [
    "set -e",
    ...(opts.recursive === false ? [] : [`mkdir -p -- ${shellQuote(posix.dirname(guestPath))}`]),
    `cat ${opts.append ? ">>" : ">"} ${target}`,
    // BSD chmod only takes options before the mode, so `--` has to come first.
    ...(opts.mode === undefined ? [] : [`chmod -- ${opts.mode.toString(8)} ${target}`]),
  ];
  return steps.join("\n");
}

function assertWritableTarget(guestPath: string, mode: number | undefined): void {
  if (guestPath.length === 0 || guestPath.includes("\0")) {
    throw new ExecError(
      "PROVIDER_UNSUPPORTED_OPERATION",
      `writeFile: ${JSON.stringify(guestPath)} is not a usable guest path.`,
    );
  }
  if (mode !== undefined && !isFileMode(mode)) {
    throw new ExecError(
      "PROVIDER_UNSUPPORTED_OPERATION",
      `writeFile: mode must be an integer between 0 and 0o7777, got ${String(mode)}.`,
    );
  }
}

function isFileMode(mode: number): boolean {
  return Number.isInteger(mode) && mode >= 0 && mode <= 0o7777;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function startTimeout(ms: number | null | undefined, onTimeout: () => void): NodeJS.Timeout | null {
  if (ms === null || ms === Infinity) {
    return null;
  }
  const timer = setTimeout(onTimeout, ms ?? DEFAULT_EXEC_TIMEOUT_MS);
  timer.unref?.();
  return timer;
}

function stopTimeout(timer: NodeJS.Timeout | null): void {
  if (timer) {
    clearTimeout(timer);
  }
}

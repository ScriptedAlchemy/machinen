// VmHandle for a macOS guest.
//
// Implements the shared handle surface and refuses, with a typed error,
// every operation the provider does not implement. The refusal is per
// call rather than a missing property, so a caller learns the reason
// instead of hitting `undefined is not a function`.

import { PassThrough } from "node:stream";

import { ExecError } from "../../errors.ts";
import type { VsockExecOptions, VsockExecPtyHandle, VsockExecPtyOptions } from "../../exec.ts";
import type { VmHandle, MemoryStats } from "../../vm-handle.ts";
import { MACOS_CAPABILITIES, type GuestCapabilities } from "../types.ts";
import type { MacosTransport } from "./ssh.ts";

interface MacosHandleOptions {
  pid: number;
  name?: string;
  transport: MacosTransport;
  capabilities?: GuestCapabilities;
  /** Throws when the runner behind this handle is no longer the one that was booted. */
  assertLive: () => void;
  /** Resolves when the runner process exits. */
  wait: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Shut the guest down, escalating as needed, and release its instance. */
  kill: () => Promise<void>;
}

export function createMacosHandle(opts: MacosHandleOptions): VmHandle {
  const capabilities = opts.capabilities ?? MACOS_CAPABILITIES;
  const exec = (cmd: string, execOpts?: VsockExecOptions) => {
    opts.assertLive();
    return opts.transport.exec(cmd, execOpts);
  };

  return {
    pid: opts.pid,
    name: opts.name,
    // A macOS guest has no VMM console streams in this process. Empty
    // streams keep the property contract without implying data.
    stdin: inertStream(),
    stdout: inertStream(),
    stderr: inertStream(),

    wait: opts.wait,
    kill: opts.kill,
    async detach() {
      // The runner is always detached, so this handle holds nothing to release.
    },
    async output() {
      return "";
    },
    async errorOutput() {
      return "";
    },

    async exec(cmd, execOpts) {
      const result = await exec(cmd, execOpts);
      if (result.exitCode !== 0) {
        throw new ExecError(
          "EXEC_NONZERO_EXIT",
          `vm.exec failed (code ${result.exitCode}): ${cmd}\nstderr:\n${result.stderr}`,
        );
      }
      return result;
    },
    async execRaw(cmd, execOpts) {
      return exec(cmd, execOpts);
    },

    execPty(_cmd: string, _ptyOpts: VsockExecPtyOptions): VsockExecPtyHandle {
      throw unsupported(
        "execPty",
        "this provider has no PTY transport. Run commands without --tty.",
      );
    },

    async listSessions() {
      throw unsupported(
        "listSessions",
        "persistent sessions need a guest session service, which macOS guests do not have.",
      );
    },

    async killSession() {
      throw unsupported(
        "killSession",
        "persistent sessions need a guest session service, which macOS guests do not have.",
      );
    },

    async writeFile(guestPath, contents, writeOpts) {
      if (!capabilities.files) {
        throw unsupported("writeFile", "this provider has no file transport.");
      }
      opts.assertLive();
      await opts.transport.writeFile(guestPath, contents, writeOpts);
    },

    async memoryStats(): Promise<MemoryStats> {
      throw unsupported(
        "memoryStats",
        "guest memory counters come from the Linux balloon device and do not exist for a macOS guest.",
      );
    },

    async snapshot() {
      throw unsupported(
        "snapshot",
        "macOS guest snapshots are not implemented. Apple saved state is encrypted to the " +
          "originating host, so it is not a portable snapshot.",
      );
    },

    async fork() {
      throw unsupported(
        "fork",
        "live fork is not implemented for macOS guests. Cold cloning is a separate future capability.",
      );
    },
  };
}

function unsupported(method: string, detail: string): Error {
  return new ExecError(
    "PROVIDER_UNSUPPORTED_OPERATION",
    `vm.${method}: unsupported for a macOS guest. ${detail}`,
  );
}

function inertStream(): PassThrough {
  const stream = new PassThrough();
  stream.end();
  return stream;
}

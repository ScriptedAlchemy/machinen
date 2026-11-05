// machinen-vz-runner
//
// One process per macOS guest. Owns the Virtualization.framework lifetime for
// a prepared VM bundle and reports lifecycle state through a JSON status file
// so the TypeScript runtime can wait for a real readiness signal instead of
// inferring it from a successful spawn.
//
// This binary never handles credentials, never opens a network listener, and
// never installs a guest. It boots the bundle it is pointed at, read-write,
// which is why the runtime only ever points it at a per-boot clone.
//
// Signals:
//   SIGTERM, SIGINT  ask the guest to stop (power-button style). Never cuts
//                    power; the runner stays up until the guest actually stops.
//   SIGUSR1          force the VM off, the equivalent of pulling the plug.

import Foundation
import Virtualization

struct RunnerArguments {
    enum Mode {
        case boot
        case preflight
    }

    var mode: Mode
    var bundlePath: String
    var memoryMib: UInt64
    var cpuCount: Int
    var statusPath: String?
    var macAddress: String?

    static let usage = """
    usage: machinen-vz-runner --bundle <dir> --status-file <path> \
    [--memory-mib <n>] [--cpus <n>] [--mac-address <aa:bb:cc:dd:ee:ff>]
           machinen-vz-runner --bundle <dir> --preflight [--memory-mib <n>] [--cpus <n>]
           machinen-vz-runner --create-identity <path>
           machinen-vz-runner --version
    """

    static func parse(_ argv: [String]) throws -> RunnerArguments {
        var bundlePath: String?
        var memoryMib: UInt64 = 4096
        var cpuCount = 4
        var statusPath: String?
        var macAddress: String?
        var mode = Mode.boot

        var index = 1
        func value(of flag: String) throws -> String {
            guard index + 1 < argv.count else {
                throw RunnerError.usage("\(flag) needs a value")
            }
            index += 1
            return argv[index]
        }
        while index < argv.count {
            let flag = argv[index]
            switch flag {
            case "--version":
                print("machinen-vz-runner \(RunnerVersion.value)")
                exit(0)
            case "--help":
                print(usage)
                exit(0)
            case "--create-identity":
                try createMachineIdentifier(at: try value(of: flag))
                exit(0)
            case "--preflight":
                mode = .preflight
            case "--bundle":
                bundlePath = try value(of: flag)
            case "--memory-mib":
                guard let parsed = UInt64(try value(of: flag)), parsed >= 2048 else {
                    throw RunnerError.usage("--memory-mib must be an integer >= 2048")
                }
                memoryMib = parsed
            case "--cpus":
                guard let parsed = Int(try value(of: flag)), parsed >= 1 else {
                    throw RunnerError.usage("--cpus must be an integer >= 1")
                }
                cpuCount = parsed
            case "--status-file":
                statusPath = try value(of: flag)
            case "--mac-address":
                macAddress = try value(of: flag)
            default:
                throw RunnerError.usage("unknown argument \(flag)")
            }
            index += 1
        }

        guard let bundlePath else { throw RunnerError.usage("--bundle is required") }
        if mode == .boot, statusPath == nil {
            throw RunnerError.usage("--status-file is required")
        }
        return RunnerArguments(
            mode: mode,
            bundlePath: bundlePath,
            memoryMib: memoryMib,
            cpuCount: cpuCount,
            statusPath: statusPath,
            macAddress: macAddress
        )
    }
}

final class GuestRunner: NSObject, VZVirtualMachineDelegate {
    private let machine: VZVirtualMachine
    private let status: StatusWriter
    private let macAddress: String

    init(configuration: VZVirtualMachineConfiguration, macAddress: String, status: StatusWriter) {
        self.machine = VZVirtualMachine(configuration: configuration)
        self.macAddress = macAddress
        self.status = status
        super.init()
        machine.delegate = self
    }

    func start() {
        status.update(.starting, macAddress: macAddress)
        // startWithCompletionHandler is refined for Swift as an async function,
        // so the completion-handler form is reached through its
        // NS_REFINED_FOR_SWIFT name.
        machine.__start { error in
            if let error {
                self.finish(.failed, error: "start failed. \(error.localizedDescription)", code: 1)
            }
            // `start` returning proves the VM began, not that the guest is
            // reachable. The runtime proves readiness over SSH.
            self.status.update(.running)
        }
    }

    /// Ask the guest to shut down. Leaves the VM running: the delegate reports
    /// the stop when it really happens, and the caller decides when to give up
    /// and escalate to `forceStop`.
    func requestStop() {
        status.update(.stopping)
        guard machine.canRequestStop else {
            StatusWriter.logToStandardError("guest cannot accept a stop request in its current state")
            return
        }
        do {
            try machine.requestStop()
        } catch {
            StatusWriter.logToStandardError("stop request failed: \(error.localizedDescription)")
        }
    }

    func forceStop() {
        status.update(.stopping)
        machine.stop { error in
            if let error {
                self.finish(.failed, error: "force stop failed. \(error.localizedDescription)", code: 1)
            }
            self.finish(.stopped, stopReason: "forced", code: 0)
        }
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        finish(.failed, error: "guest stopped with an error. \(error.localizedDescription)", code: 1)
    }

    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        finish(.stopped, stopReason: "guest", code: 0)
    }

    private func finish(
        _ state: StatusWriter.State,
        error: String? = nil,
        stopReason: String? = nil,
        code: Int32
    ) -> Never {
        status.update(state, error: error, stopReason: stopReason)
        exit(code)
    }
}

var signalSources: [DispatchSourceSignal] = []

func installSignalHandlers(runner: GuestRunner) {
    // The runner logs to a file today, but a closed pipe must never be able to
    // take a running guest down with it.
    signal(SIGPIPE, SIG_IGN)
    let handlers: [(Int32, () -> Void)] = [
        (SIGTERM, runner.requestStop),
        (SIGINT, runner.requestStop),
        (SIGUSR1, runner.forceStop),
    ]
    for (signalNumber, handler) in handlers {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler(handler: handler)
        source.resume()
        signalSources.append(source)
    }
}

func runPreflight(_ arguments: RunnerArguments) throws {
    let bundle = try Bundle.load(path: arguments.bundlePath)
    _ = try makeGuestConfiguration(
        bundle: bundle,
        memoryMib: arguments.memoryMib,
        cpuCount: arguments.cpuCount,
        macAddress: try parseMacAddress(arguments.macAddress)
    )
    print("{\"ok\":true,\"bundle\":\"\(bundle.root.path)\"}")
}

func runGuest(_ arguments: RunnerArguments, statusPath: String) throws {
    let status = StatusWriter(path: statusPath)
    status.update(.starting)
    do {
        guard VZVirtualMachine.isSupported else {
            throw RunnerError.unsupportedHost("VZVirtualMachine reports no support on this host")
        }
        let bundle = try Bundle.load(path: arguments.bundlePath)
        // Held for the life of the process. Booting one disk twice corrupts it.
        let lock = try BundleLock.acquire(bundleRoot: bundle.root)
        let macAddress = try parseMacAddress(arguments.macAddress)
        let configuration = try makeGuestConfiguration(
            bundle: bundle,
            memoryMib: arguments.memoryMib,
            cpuCount: arguments.cpuCount,
            macAddress: macAddress
        )
        let runner = GuestRunner(
            configuration: configuration,
            macAddress: macAddress.string,
            status: status
        )
        installSignalHandlers(runner: runner)
        runner.start()
        withExtendedLifetime((lock, runner)) {
            RunLoop.main.run()
        }
    } catch {
        status.update(.failed, error: "\(error)")
        throw error
    }
}

func main() {
    do {
        let arguments = try RunnerArguments.parse(CommandLine.arguments)
        switch arguments.mode {
        case .preflight:
            try runPreflight(arguments)
        case .boot:
            try runGuest(arguments, statusPath: arguments.statusPath!)
        }
    } catch {
        StatusWriter.logToStandardError("\(error)")
        exit(2)
    }
}

main()

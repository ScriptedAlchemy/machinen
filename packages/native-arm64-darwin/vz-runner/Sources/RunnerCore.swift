// Shared runner pieces: status reporting, the prepared bundle, the exclusive
// lock, and the guest configuration. Kept out of main.swift so the native test
// harness in Tests/ exercises the same code the runner ships.

import Foundation
import Virtualization

#if !arch(arm64)
#error("machinen-vz-runner supports arm64 only")
#endif

enum RunnerVersion {
    static let value = "0.2.0"
}

enum RunnerError: Error, CustomStringConvertible {
    case usage(String)
    case unsupportedHost(String)
    case invalidBundle(String)
    case bundleLocked(String)
    case virtualization(String)

    var description: String {
        switch self {
        case .usage(let detail):
            return "usage error. \(detail)"
        case .unsupportedHost(let detail):
            return "unsupported host. \(detail)"
        case .invalidBundle(let detail):
            return "invalid bundle. \(detail)"
        case .bundleLocked(let detail):
            return "bundle in use. \(detail)"
        case .virtualization(let detail):
            return "virtualization failure. \(detail)"
        }
    }
}

/// Status writer. Replaces the whole document atomically so a reader never
/// observes a half-written file, and works whether or not the file exists yet.
final class StatusWriter {
    enum State: String {
        case starting
        case running
        case stopping
        case stopped
        case failed
    }

    private let url: URL
    private let diagnostics: (String) -> Void
    private var state: State = .starting
    private var macAddress: String?
    private var error: String?
    private var stopReason: String?

    init(path: String, diagnostics: @escaping (String) -> Void = StatusWriter.logToStandardError) {
        self.url = URL(fileURLWithPath: path)
        self.diagnostics = diagnostics
    }

    static func logToStandardError(_ message: String) {
        FileHandle.standardError.write(Data("machinen-vz-runner. \(message)\n".utf8))
    }

    func update(
        _ next: State,
        macAddress: String? = nil,
        error: String? = nil,
        stopReason: String? = nil
    ) {
        state = next
        self.macAddress = macAddress ?? self.macAddress
        self.error = error ?? self.error
        self.stopReason = stopReason ?? self.stopReason
        flush()
    }

    private func flush() {
        var payload: [String: Any] = [
            "state": state.rawValue,
            "updatedAt": Int(Date().timeIntervalSince1970 * 1000),
        ]
        payload["macAddress"] = macAddress
        payload["error"] = error
        payload["stopReason"] = stopReason
        do {
            let data = try JSONSerialization.data(withJSONObject: payload)
            try data.write(to: url, options: .atomic)
        } catch {
            // A failed write must not kill a guest that is otherwise running,
            // but it has to be visible: the runtime polls this file and would
            // otherwise only ever see a readiness timeout with no reason.
            diagnostics("could not write status file \(url.path): \(error.localizedDescription)")
        }
    }
}

/// The prepared bundle. Every member is declared by config.json so a directory
/// that merely looks like a bundle is refused with a reason.
struct Bundle {
    let root: URL
    let diskImage: URL
    let auxiliaryStorage: URL
    let hardwareModel: URL
    let machineIdentifier: URL

    static func load(path: String) throws -> Bundle {
        let root = URL(fileURLWithPath: path).standardizedFileURL
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: root.path, isDirectory: &isDirectory) else {
            throw RunnerError.invalidBundle("bundle not found at \(root.path)")
        }
        guard isDirectory.boolValue else {
            throw RunnerError.invalidBundle("bundle must be a directory at \(root.path)")
        }
        let configURL = root.appendingPathComponent("config.json")
        guard let data = try? Data(contentsOf: configURL) else {
            throw RunnerError.invalidBundle("missing config.json at \(configURL.path)")
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RunnerError.invalidBundle("config.json is not a JSON object")
        }
        func member(_ key: String) throws -> URL {
            guard let value = parsed[key] as? String, !value.isEmpty else {
                throw RunnerError.invalidBundle("config.json must name \(key)")
            }
            let url = value.hasPrefix("/")
                ? URL(fileURLWithPath: value)
                : root.appendingPathComponent(value)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw RunnerError.invalidBundle("\(key) points at \(url.path), which is missing")
            }
            return url
        }
        return Bundle(
            root: root,
            diskImage: try member("diskImage"),
            auxiliaryStorage: try member("auxiliaryStorage"),
            hardwareModel: try member("hardwareModel"),
            machineIdentifier: try member("machineIdentifier")
        )
    }
}

/// Exclusive per-bundle lock. `flock` is released by the kernel when the
/// process dies, so a crashed or SIGKILLed runner never strands the bundle.
final class BundleLock {
    private let descriptor: Int32

    private init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    deinit {
        close(descriptor)
    }

    static func acquire(bundleRoot: URL) throws -> BundleLock {
        let path = bundleRoot.appendingPathComponent(".machinen-runner.lock").path
        let descriptor = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            throw RunnerError.invalidBundle(
                "cannot open lock file \(path): \(String(cString: strerror(errno)))"
            )
        }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            let reason = String(cString: strerror(errno))
            close(descriptor)
            throw RunnerError.bundleLocked("another runner holds \(path): \(reason)")
        }
        return BundleLock(descriptor: descriptor)
    }
}

/// A stored identity is required. A bundle booted with a silently invented
/// identity is a different machine, and writing one would mutate the bundle.
func loadMachineIdentifier(from url: URL) throws -> VZMacMachineIdentifier {
    guard
        let data = try? Data(contentsOf: url),
        let identifier = VZMacMachineIdentifier(dataRepresentation: data)
    else {
        throw RunnerError.invalidBundle("\(url.path) is not a valid machine identifier")
    }
    return identifier
}

/// Create a new identity file. Refuses to overwrite: replacing the identity of
/// an existing guest must be a deliberate delete, not a side effect.
func createMachineIdentifier(at path: String) throws {
    do {
        try VZMacMachineIdentifier().dataRepresentation.write(
            to: URL(fileURLWithPath: path),
            options: .withoutOverwriting
        )
    } catch {
        throw RunnerError.invalidBundle(
            "cannot create machine identifier at \(path): \(error.localizedDescription)"
        )
    }
}

func parseMacAddress(_ value: String?) throws -> VZMACAddress {
    guard let value else {
        return VZMACAddress.randomLocallyAdministered()
    }
    guard let address = VZMACAddress(string: value) else {
        throw RunnerError.usage("--mac-address must look like aa:bb:cc:dd:ee:ff, got \(value)")
    }
    return address
}

/// The complete macOS guest configuration. There is no window, but a macOS
/// guest still needs its display and input devices present to boot normally,
/// so they are attached and simply never shown.
func makeGuestConfiguration(
    bundle: Bundle,
    memoryMib: UInt64,
    cpuCount: Int,
    macAddress: VZMACAddress
) throws -> VZVirtualMachineConfiguration {
    guard let model = VZMacHardwareModel(dataRepresentation: try Data(contentsOf: bundle.hardwareModel))
    else {
        throw RunnerError.invalidBundle("hardwareModel is not a valid VZMacHardwareModel")
    }
    guard model.isSupported else {
        throw RunnerError.unsupportedHost("the bundle hardware model is not supported by this host")
    }

    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel = model
    platform.machineIdentifier = try loadMachineIdentifier(from: bundle.machineIdentifier)
    platform.auxiliaryStorage = VZMacAuxiliaryStorage(url: bundle.auxiliaryStorage)

    let graphics = VZMacGraphicsDeviceConfiguration()
    graphics.displays = [
        VZMacGraphicsDisplayConfiguration(widthInPixels: 1920, heightInPixels: 1200, pixelsPerInch: 80)
    ]

    let network = VZVirtioNetworkDeviceConfiguration()
    network.attachment = VZNATNetworkDeviceAttachment()
    network.macAddress = macAddress

    let configuration = VZVirtualMachineConfiguration()
    configuration.bootLoader = VZMacOSBootLoader()
    configuration.platform = platform
    configuration.memorySize = memoryMib * 1024 * 1024
    configuration.cpuCount = cpuCount
    configuration.graphicsDevices = [graphics]
    configuration.keyboards = [VZUSBKeyboardConfiguration()]
    configuration.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    configuration.networkDevices = [network]
    configuration.storageDevices = [
        VZVirtioBlockDeviceConfiguration(
            attachment: try VZDiskImageStorageDeviceAttachment(url: bundle.diskImage, readOnly: false)
        )
    ]
    configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
    configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

    try configuration.validate()
    return configuration
}

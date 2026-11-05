// Native self-check for machinen-vz-runner.
//
// Compiled together with Sources/RunnerCore.swift and signed with the runner's
// entitlements, because `validate()` only passes for a correctly configured
// macOS guest in a correctly entitled process. `--version` proves neither.
// Exits non-zero on the first failure.

import Foundation
import Virtualization

var failures = 0

func check(_ name: String, _ condition: @autoclosure () throws -> Bool) {
    do {
        if try condition() {
            print("ok   \(name)")
            return
        }
        print("FAIL \(name)")
    } catch {
        print("FAIL \(name): \(error)")
    }
    failures += 1
}

let root = FileManager.default.temporaryDirectory
    .appendingPathComponent("machinen-vz-runner-test-\(UUID().uuidString)")
try! FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: root) }

func readStatus(_ path: String) throws -> [String: Any] {
    let data = try Data(contentsOf: URL(fileURLWithPath: path))
    return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
}

// MARK: Status file

do {
    let path = root.appendingPathComponent("status.json").path
    check("status file is absent before the first write", !FileManager.default.fileExists(atPath: path))
    let writer = StatusWriter(path: path) { print("unexpected diagnostic: \($0)"); failures += 1 }
    writer.update(.starting, macAddress: "02:00:00:00:00:01")
    check("first write creates a missing status file", try readStatus(path)["state"] as? String == "starting")
    writer.update(.running)
    check("second write replaces the file", try readStatus(path)["state"] as? String == "running")
    check("mac address is kept across updates", try readStatus(path)["macAddress"] as? String == "02:00:00:00:00:01")
    writer.update(.failed, error: "boom")
    check("errors are reported", try readStatus(path)["error"] as? String == "boom")
    let leftovers = try! FileManager.default.contentsOfDirectory(atPath: root.path)
        .filter { $0.hasPrefix("status.json") && $0 != "status.json" }
    check("atomic writes leave no temporary files", leftovers.isEmpty)
}

do {
    var diagnostics: [String] = []
    let path = root.appendingPathComponent("no-such-directory/status.json").path
    let writer = StatusWriter(path: path) { diagnostics.append($0) }
    writer.update(.starting)
    check("an unwritable status path is reported, not swallowed", diagnostics.count == 1)
    check("the diagnostic names the path", diagnostics.first?.contains(path) ?? false)
}

// MARK: Exclusive lock

do {
    let bundleRoot = root.appendingPathComponent("lock-bundle")
    try! FileManager.default.createDirectory(at: bundleRoot, withIntermediateDirectories: true)
    var held: BundleLock? = try! BundleLock.acquire(bundleRoot: bundleRoot)
    var refused = false
    do {
        _ = try BundleLock.acquire(bundleRoot: bundleRoot)
    } catch RunnerError.bundleLocked {
        refused = true
    }
    check("a second runner is refused while the bundle is locked", refused)
    withExtendedLifetime(held) { held = nil }
    check("the lock is released with its holder", (try? BundleLock.acquire(bundleRoot: bundleRoot)) != nil)
}

// MARK: Identity

do {
    let path = root.appendingPathComponent("identity.bin").path
    check("a new identity can be created", (try? createMachineIdentifier(at: path)) != nil)
    let original = try! Data(contentsOf: URL(fileURLWithPath: path))
    check("an existing identity is never overwritten", (try? createMachineIdentifier(at: path)) == nil)
    check("the identity bytes are untouched", try Data(contentsOf: URL(fileURLWithPath: path)) == original)
    check("a stored identity loads", (try? loadMachineIdentifier(from: URL(fileURLWithPath: path))) != nil)
    let bad = root.appendingPathComponent("bad-identity.bin")
    try! Data("not an identity".utf8).write(to: bad)
    check("a corrupt identity is refused", (try? loadMachineIdentifier(from: bad)) == nil)
}

// MARK: Bundle validation

do {
    let incomplete = root.appendingPathComponent("incomplete")
    try! FileManager.default.createDirectory(at: incomplete, withIntermediateDirectories: true)
    try! Data(#"{"diskImage":"disk.img"}"#.utf8).write(to: incomplete.appendingPathComponent("config.json"))
    try! Data().write(to: incomplete.appendingPathComponent("disk.img"))
    check("a bundle missing required members is refused", (try? Bundle.load(path: incomplete.path)) == nil)
}

// MARK: Guest configuration

// The hardware model is normally read from a restore image. This is the same
// document, built directly, so the check needs neither an IPSW nor a network.
func makeHardwareModel() -> VZMacHardwareModel? {
    let document: [String: Any] = [
        "DataRepresentationVersion": 1,
        "MinimumSupportedOS": [12, 0, 0],
        "PlatformVersion": 2,
    ]
    guard
        let data = try? PropertyListSerialization.data(fromPropertyList: document, format: .binary, options: 0)
    else {
        return nil
    }
    return VZMacHardwareModel(dataRepresentation: data)
}

if !VZVirtualMachine.isSupported {
    print("skip guest configuration: this host cannot run virtual machines")
} else if let model = makeHardwareModel(), model.isSupported {
    let bundleRoot = root.appendingPathComponent("config-bundle")
    try! FileManager.default.createDirectory(at: bundleRoot, withIntermediateDirectories: true)
    let disk = bundleRoot.appendingPathComponent("disk.img")
    FileManager.default.createFile(atPath: disk.path, contents: nil)
    let handle = try! FileHandle(forWritingTo: disk)
    try! handle.truncate(atOffset: 1 << 30)
    try! handle.close()
    _ = try! VZMacAuxiliaryStorage(
        creatingStorageAt: bundleRoot.appendingPathComponent("aux.img"),
        hardwareModel: model,
        options: []
    )
    try! model.dataRepresentation.write(to: bundleRoot.appendingPathComponent("hardwareModel.bin"))
    try! createMachineIdentifier(at: bundleRoot.appendingPathComponent("machineIdentifier.bin").path)
    try! Data(
        """
        {"diskImage":"disk.img","auxiliaryStorage":"aux.img",\
        "hardwareModel":"hardwareModel.bin","machineIdentifier":"machineIdentifier.bin"}
        """.utf8
    ).write(to: bundleRoot.appendingPathComponent("config.json"))

    let bundle = try! Bundle.load(path: bundleRoot.path)
    let mac = VZMACAddress(string: "02:00:00:00:00:02")!
    do {
        let configuration = try makeGuestConfiguration(
            bundle: bundle,
            memoryMib: 4096,
            cpuCount: 2,
            macAddress: mac
        )
        check("a complete configuration validates", true)
        check("the configuration boots macOS", configuration.bootLoader is VZMacOSBootLoader)
        check("the configuration has a display", !configuration.graphicsDevices.isEmpty)
        check("the configuration has a keyboard", !configuration.keyboards.isEmpty)
        check("the configuration has a pointer", !configuration.pointingDevices.isEmpty)
        check(
            "the configured MAC address is the requested one",
            (configuration.networkDevices.first?.macAddress.string ?? "") == mac.string
        )
        // Guards this test itself: it must fail for the defect it exists to catch.
        configuration.bootLoader = nil
        check("a configuration without a boot loader does not validate", (try? configuration.validate()) == nil)
    } catch {
        print("FAIL a complete configuration validates: \(error)")
        failures += 1
    }
} else {
    print("skip guest configuration: this host does not support the test hardware model")
}

if failures > 0 {
    print("\(failures) native check(s) failed")
    exit(1)
}
print("all native checks passed")

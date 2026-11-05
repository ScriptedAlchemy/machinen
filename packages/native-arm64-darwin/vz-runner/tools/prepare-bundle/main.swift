// prepare-bundle: fixture tooling for macOS guest bundles. Not shipped.
//
//   prepare-bundle install --ipsw <file> --bundle <dir> [--disk-gb <n>] [--memory-mib <n>] [--cpus <n>]
//   prepare-bundle setup-boot --bundle <dir> --vnc-info <file> [--memory-mib <n>] [--cpus <n>]
//
// `install` lays an Apple restore image onto a new bundle. `setup-boot` boots
// that bundle with a password-protected VNC server, because a fresh install
// stops at Setup Assistant and only a keyboard gets past it. VNC here relies on
// Apple's private _VZVNCServer, which is why it lives in this tool and never in
// the runner, which has no listener of any kind.

import Foundation
import Virtualization

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("prepare-bundle. \(message)\n".utf8))
    exit(1)
}

func flagValue(_ name: String) -> String? {
    guard let index = CommandLine.arguments.firstIndex(of: name), index + 1 < CommandLine.arguments.count else {
        return nil
    }
    return CommandLine.arguments[index + 1]
}

func requiredFlag(_ name: String) -> String {
    guard let value = flagValue(name) else { fail("\(name) is required") }
    return value
}

let memoryMib = UInt64(flagValue("--memory-mib") ?? "") ?? 4096
let cpuCount = Int(flagValue("--cpus") ?? "") ?? 4

func runInstall() {
    let ipsw = URL(fileURLWithPath: requiredFlag("--ipsw"))
    let bundleRoot = URL(fileURLWithPath: requiredFlag("--bundle"))
    let diskBytes = (UInt64(flagValue("--disk-gb") ?? "") ?? 64) * 1_000_000_000
    let names = (
        disk: "disk.img", aux: "aux.img", model: "hardwareModel.bin", identity: "machineIdentifier.bin"
    )

    VZMacOSRestoreImage.load(from: ipsw) { result in
        DispatchQueue.main.async {
            do {
                let image = try result.get()
                guard let requirements = image.mostFeaturefulSupportedConfiguration else {
                    fail("this host supports no configuration in \(ipsw.path)")
                }
                print("restore image: macOS \(image.operatingSystemVersion) build \(image.buildVersion)")
                try FileManager.default.createDirectory(at: bundleRoot, withIntermediateDirectories: false)

                let disk = bundleRoot.appendingPathComponent(names.disk)
                FileManager.default.createFile(atPath: disk.path, contents: nil)
                let handle = try FileHandle(forWritingTo: disk)
                try handle.truncate(atOffset: diskBytes)
                try handle.close()

                _ = try VZMacAuxiliaryStorage(
                    creatingStorageAt: bundleRoot.appendingPathComponent(names.aux),
                    hardwareModel: requirements.hardwareModel,
                    options: []
                )
                try requirements.hardwareModel.dataRepresentation.write(
                    to: bundleRoot.appendingPathComponent(names.model)
                )
                try createMachineIdentifier(at: bundleRoot.appendingPathComponent(names.identity).path)
                let config = [
                    "diskImage": names.disk,
                    "auxiliaryStorage": names.aux,
                    "hardwareModel": names.model,
                    "machineIdentifier": names.identity,
                ]
                try JSONSerialization.data(withJSONObject: config, options: [.prettyPrinted, .sortedKeys])
                    .write(to: bundleRoot.appendingPathComponent("config.json"))

                let bundle = try Bundle.load(path: bundleRoot.path)
                let machine = VZVirtualMachine(
                    configuration: try makeGuestConfiguration(
                        bundle: bundle,
                        memoryMib: max(memoryMib, requirements.minimumSupportedMemorySize / (1024 * 1024)),
                        cpuCount: max(cpuCount, requirements.minimumSupportedCPUCount),
                        macAddress: VZMACAddress.randomLocallyAdministered()
                    )
                )
                let installer = VZMacOSInstaller(virtualMachine: machine, restoringFromImageAt: ipsw)
                let observation = installer.progress.observe(\.fractionCompleted, options: [.new]) { progress, _ in
                    print(String(format: "progress %.1f%%", progress.fractionCompleted * 100))
                    fflush(stdout)
                }
                print("installing")
                fflush(stdout)
                installer.install { installResult in
                    withExtendedLifetime((machine, installer, observation)) {}
                    switch installResult {
                    case .success:
                        print("install complete")
                        exit(0)
                    case .failure(let error):
                        fail("install failed: \(error)")
                    }
                }
                retained = [machine, installer, observation]
            } catch {
                fail("\(error)")
            }
        }
    }
}

// Reached through the Objective-C runtime because these classes have no headers.
func startVncServer(machine: VZVirtualMachine, password: String) -> NSObject {
    guard
        let securityClass = NSClassFromString("_VZVNCAuthenticationSecurityConfiguration") as? NSObject.Type,
        let serverClass = NSClassFromString("_VZVNCServer") as? NSObject.Type
    else {
        fail("this macOS has no _VZVNCServer")
    }
    let security = securityClass.perform(NSSelectorFromString("alloc")).takeUnretainedValue()
    let initSecurity = NSSelectorFromString("initWithPassword:")
    typealias InitSecurity = @convention(c) (AnyObject, Selector, NSString) -> AnyObject
    let makeSecurity = unsafeBitCast(security.method(for: initSecurity), to: InitSecurity.self)
    let configured = makeSecurity(security, initSecurity, password as NSString)

    let server = serverClass.perform(NSSelectorFromString("alloc")).takeUnretainedValue()
    let initServer = NSSelectorFromString("initWithPort:queue:securityConfiguration:")
    typealias InitServer = @convention(c) (AnyObject, Selector, Int, DispatchQueue, AnyObject) -> AnyObject
    let makeServer = unsafeBitCast(server.method(for: initServer), to: InitServer.self)
    guard let instance = makeServer(server, initServer, 0, DispatchQueue.main, configured) as? NSObject else {
        fail("could not create the VNC server")
    }
    instance.setValue(machine, forKey: "virtualMachine")
    instance.perform(NSSelectorFromString("start"))
    return instance
}

final class SetupGuestDelegate: NSObject, VZVirtualMachineDelegate {
    func guestDidStop(_ virtualMachine: VZVirtualMachine) {
        print("guest stopped")
        exit(0)
    }

    func virtualMachine(_ virtualMachine: VZVirtualMachine, didStopWithError error: Error) {
        fail("guest stopped with an error: \(error)")
    }
}

func runSetupBoot() {
    let bundlePath = requiredFlag("--bundle")
    let infoPath = requiredFlag("--vnc-info")
    do {
        let bundle = try Bundle.load(path: bundlePath)
        let lock = try BundleLock.acquire(bundleRoot: bundle.root)
        let machine = VZVirtualMachine(
            configuration: try makeGuestConfiguration(
                bundle: bundle,
                memoryMib: memoryMib,
                cpuCount: cpuCount,
                macAddress: VZMACAddress.randomLocallyAdministered()
            )
        )
        let delegate = SetupGuestDelegate()
        machine.delegate = delegate
        machine.__start { error in
            if let error { fail("start failed: \(error)") }
            print("guest started")
            fflush(stdout)
        }
        let password = UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(8).lowercased()
        let server = startVncServer(machine: machine, password: String(password))
        retained = [machine, delegate, server, lock]

        // The server picks its port asynchronously.
        func publishPort(attempt: Int) {
            let port = (server.value(forKey: "port") as? NSNumber)?.intValue ?? 0
            if port == 0 {
                if attempt > 100 { fail("the VNC server never reported a port") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { publishPort(attempt: attempt + 1) }
                return
            }
            let info = "{\"port\":\(port),\"password\":\"\(password)\"}\n"
            FileManager.default.createFile(
                atPath: infoPath,
                contents: Data(info.utf8),
                attributes: [.posixPermissions: 0o600]
            )
            print("vnc listening on port \(port)")
            fflush(stdout)
        }
        publishPort(attempt: 0)

        signal(SIGTERM, SIG_IGN)
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        term.setEventHandler { machine.stop { _ in exit(0) } }
        term.resume()
        retained.append(term)
    } catch {
        fail("\(error)")
    }
}

var retained: [Any] = []

switch CommandLine.arguments.dropFirst().first {
case "install":
    runInstall()
case "setup-boot":
    runSetupBoot()
default:
    fail("usage: prepare-bundle install|setup-boot ...")
}
RunLoop.main.run()

import Foundation
import XCTest
@testable import RippleKit

final class SystemTests: XCTestCase {
    func testPathsDecodesOnlyExecutionContractAndHonorsHome() throws {
        let data = Data(#"{"node":"/example/node","env":{"ELECTRON_RUN_AS_NODE":"1"},"cli":"/example/cli.js","router":{"ignored":true}}"#.utf8)
        var readURL: URL?
        let runtime = try CLIRuntime.discover(environment: ["CLAUDERIPPLE_HOME": "/example/home"], read: {
            readURL = $0
            return data
        }, exists: { _ in true })
        XCTAssertEqual(readURL?.path, "/example/home/paths.json")
        XCTAssertEqual(runtime.node, "/example/node")
        XCTAssertEqual(runtime.cli, "/example/cli.js")
        XCTAssertEqual(runtime.env?["ELECTRON_RUN_AS_NODE"], "1")
    }

    func testCLIOverrideUsesRecordedAbsoluteNodeNotGUIPath() throws {
        let data = Data(#"{"node":"/example/node","cli":"/missing/cli"}"#.utf8)
        let runtime = try CLIRuntime.discover(environment: ["CLAUDERIPPLE_APP_CLI": "/override/cli.ts"], read: { _ in data }, exists: { $0 != "/missing/cli" })
        XCTAssertEqual(runtime.cli, "/override/cli.ts")
        XCTAssertEqual(runtime.node, "/example/node")
    }

    func testMissingFilesAndRelativeRuntimeAreRejected() {
        for missing in ["paths.json", "/example/node", "/example/cli"] {
            XCTAssertThrowsError(try CLIRuntime.discover(environment: [:], read: { _ in
                Data(#"{"node":"/example/node","cli":"/example/cli"}"#.utf8)
            }, exists: { !$0.hasSuffix(missing) }))
        }
        XCTAssertThrowsError(try CLIRuntime.discover(environment: [:], read: { _ in
            Data(#"{"node":"node","cli":"cli.ts"}"#.utf8)
        }, exists: { _ in true })) { XCTAssertEqual($0 as? CLIError, .invalidPaths) }
    }

    func testLastJSONObjectIgnoresNoiseArraysAndStderr() throws {
        let text = "warning\r\n{\"mode\":\"mixed\"}\r\n[1,2]\n{\"mode\":\"direct\"}\nnot JSON\n"
        let doctor = try JSONDecoder().decode(Doctor.self, from: CLI.lastJSONObject(in: text))
        XCTAssertEqual(doctor.mode, "direct")
        XCTAssertEqual(try JSONDecoder().decode(Doctor.self, from: CLI.lastJSONObject(in: "{\n  \"mode\": \"ripple\"\n}")).mode, "ripple")
        for invalid in ["[]", "null", "noise", "{broken}"] { XCTAssertThrowsError(try CLI.lastJSONObject(in: invalid)) }
    }

    func testRecoveryFixturesAndRestartRequirement() throws {
        let doctor = try JSONDecoder().decode(Doctor.self, from: fixture("system-doctor"))
        XCTAssertEqual(doctor.mode, "mixed")
        XCTAssertEqual(doctor.supervisor?.programExists, false)
        XCTAssertEqual(doctor.problems?.first?.code, "supervisor-program-missing")
        let repair = try JSONDecoder().decode(RepairOutput.self, from: fixture("system-repair"))
        XCTAssertEqual(repair.ok, true)
        XCTAssertEqual(repair.doctor?.mode, "ripple")
        XCTAssertEqual(repair.detailLines.count, 2)
        let direct = try JSONDecoder().decode(DirectOutput.self, from: fixture("system-direct"))
        XCTAssertTrue(direct.requiresClaudeRestart)
        for text in [#"{"ok":false,"restartClaude":true}"#, #"{"ok":true}"#, "{}"] {
            XCTAssertFalse(try JSONDecoder().decode(DirectOutput.self, from: Data(text.utf8)).requiresClaudeRestart)
        }
        XCTAssertNil(try JSONDecoder().decode(Doctor.self, from: Data("{}".utf8)).mode)
    }

    func testUpdateKindsAndRunningGuard() throws {
        let update = try JSONDecoder().decode(UpdateCheck.self, from: fixture("system-update"))
        XCTAssertTrue(update.canUpdate)
        for kind in ["checkout", "packaged", "local", "future"] {
            let unsupported = try JSONDecoder().decode(UpdateCheck.self, from: Data("{\"current\":\"1\",\"latest\":\"2\",\"newer\":true,\"kind\":\"\(kind)\"}".utf8))
            XCTAssertFalse(unsupported.supportsUpdate)
            XCTAssertNotNil(unsupported.installationNote)
        }
        let running = try JSONDecoder().decode(UpdateCheck.self, from: Data(#"{"current":"1","latest":"2","newer":true,"kind":"script","running":true}"#.utf8))
        XCTAssertFalse(running.canUpdate)
    }

    func testProcessKeepsStreamsSeparateAndUsesArgumentsWithoutShell() async throws {
        let result = try await CLI.runExecutable("/usr/bin/printf", arguments: ["%s", "literal; $(not-a-command)\n{\"mode\":\"direct\"}\n"])
        XCTAssertTrue(result.ok)
        XCTAssertTrue(result.stdout.contains("$(not-a-command)"))
        XCTAssertEqual(result.stderr, "")
        XCTAssertEqual(try result.decode(Doctor.self).mode, "direct")
        let error = try await CLI.runExecutable("/bin/ls", arguments: ["/nonexistent-clauderipple-system-test"])
        XCTAssertFalse(error.ok)
        XCTAssertEqual(error.stdout, "")
        XCTAssertFalse(error.stderr.isEmpty)
    }

    func testProcessTimeoutAndCancellation() async throws {
        let timedOut = try await CLI.runExecutable("/bin/sleep", arguments: ["2"], timeout: 0.02)
        XCTAssertTrue(timedOut.timedOut)
        XCTAssertFalse(timedOut.ok)
        let task = Task { try await CLI.runExecutable("/bin/sleep", arguments: ["2"]) }
        try await Task.sleep(for: .milliseconds(20))
        task.cancel()
        do {
            let result = try await task.value
            XCTAssertTrue(result.cancelled)
            XCTAssertFalse(result.ok)
        } catch is CancellationError { /* Cancellation can arrive before Process starts. */ }
    }

    func testUpdateAndLogsRoutes() async throws {
        let text = try fixtureText("system-update")
        let client = MockRouter.client { request in
            if request.path == "/api/logs" { return .init(contentType: "text/plain", body: Data("example log".utf8)) }
            return .json(text)
        }
        let check = try await client.checkForUpdates()
        XCTAssertTrue(check.canUpdate)
        _ = try await client.startUpdate()
        let logs = try await client.recentRouterLogs()
        XCTAssertEqual(logs, "example log")
        let requests = MockRouter.requests()
        XCTAssertEqual(requests.map(\.method), ["GET", "POST", "GET"])
        XCTAssertEqual(requests.last?.query, "n=40")
        XCTAssertEqual(client.request("GET", "/api/update", query: [], body: nil, timeout: AdminClient.updateTimeout).timeoutInterval, 40)
    }
}

final class LaptopTests: XCTestCase {
    func testPowerDecodingAndWrites() async throws {
        let text = try fixtureText("power-status")
        let client = MockRouter.client { _ in .json(text) }
        let status = try await client.power()
        XCTAssertEqual(status.awake.battery?.percent, 76)
        XCTAssertNotNil(status.awake.untilDate)
        XCTAssertEqual(status.tether.stateTitle, "Watching Wi-Fi connectivity")
        _ = try await client.setTetherEnabled(false)
        _ = try await client.setAwakeMode(.on, until: Date(timeIntervalSince1970: 0))
        _ = try await client.setAwakeMode(.off)
        let requests = MockRouter.requests()
        XCTAssertEqual(requests[1].json?["tether"]?["enabled"]?.boolValue, false)
        XCTAssertEqual(requests[2].json?["awake"]?["until"]?.stringValue, "1970-01-01T00:00:00Z")
        XCTAssertEqual(requests[3].json?["awake"]?["until"], .null)
    }

    func testOldRouterPowerRouteMissingAnd501() async {
        let client = MockRouter.client { _ in .dashboardPage }
        do { _ = try await client.power(); XCTFail("expected routeMissing") }
        catch { XCTAssertEqual(error as? AdminError, .routeMissing(path: "/api/power")) }
        let unsupported = MockRouter.client { _ in .json(#"{"error":"power control not available"}"#, status: 501) }
        do { _ = try await unsupported.power(); XCTFail("expected 501") }
        catch { XCTAssertEqual(error as? AdminError, .http(status: 501, message: "power control not available")) }
    }

    func testEveryTetherStateHasHumanWording() {
        let states = ["off", "unsupported", "no-wifi-device", "watching", "no-wifi", "outage", "pinned", "joining-hotspot", "on-hotspot", "returning", "hotspot-not-visible", "join-failed", "needs-setup", "no-hotspot-ssid", "no-hotspot-profile", "needs-location"]
        for state in states { XCTAssertNotEqual(TetherStatus.title(for: state), state) }
        XCTAssertEqual(TetherStatus.title(for: "future-state"), "future-state")
    }

    func testSetupPollingStopsAtEitherTerminalOutcome() async throws {
        for ok in [true, false] {
            let client = MockRouter.client { _ in
                let count = MockRouter.requests().count
                return .json(count == 1 ? #"{"running":true,"startedAt":"2026-01-01T12:00:00Z"}"# : "{\"running\":false,\"ok\":\(ok),\"output\":\"Example result\"}")
            }
            let job = try await client.pollPowerSetup(interval: .zero) { _ in }
            XCTAssertEqual(job.ok, ok)
            XCTAssertFalse(job.shouldPoll)
            XCTAssertEqual(MockRouter.requests().count, 2)
        }
    }

    func testSetupPollingCancellationAndPostBody() async throws {
        let client = MockRouter.client { request in
            .json(request.method == "POST" ? #"{"started":true}"# : #"{"running":true}"#)
        }
        try await client.startPowerSetup(ssid: "Example Phone")
        XCTAssertEqual(MockRouter.requests().first?.json?["ssid"]?.stringValue, "Example Phone")
        let task = Task { try await client.pollPowerSetup(interval: .seconds(60)) { _ in } }
        try await Task.sleep(for: .milliseconds(20))
        task.cancel()
        do { _ = try await task.value; XCTFail("expected cancellation") } catch is CancellationError {}
    }
}

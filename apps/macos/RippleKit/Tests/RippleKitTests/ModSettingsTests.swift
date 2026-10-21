import XCTest
@testable import RippleKit

final class ModSettingsTests: XCTestCase {
    private func snapshot(_ name: String = "mod-older") throws -> ModSettingsSnapshot {
        try ModSettingsSnapshot(document: JSONValue(data: fixture(name)))
    }

    func testOldAndNewSnapshotsDoNotInventFields() throws {
        let old = try snapshot()
        let new = try snapshot("mod-newer")
        XCTAssertNil(old.settings["skin"])
        XCTAssertNil(old.settings["delegation"])
        XCTAssertEqual(new.settings["skin"], .string("flat"))
        XCTAssertEqual(new.settings["delegation"], .string("normal"))
        XCTAssertEqual(old.revision, 4)
        XCTAssertEqual(new.revision, 9)
    }

    func testUnknownFieldsAndNumberLiteralsRoundTrip() throws {
        let original = try snapshot()
        var editor = ModSettingsEditor(snapshot: original)
        editor.set(.int(2), at: ["bias"])
        let roundTrip = try JSONValue(data: editor.putBody().data())
        XCTAssertEqual(roundTrip["settings"]?["futureFeature"], original.settings["futureFeature"])
        XCTAssertTrue(roundTrip.serialized().contains("1e3"))
        XCTAssertNil(roundTrip["settings"]?["skin"])
        XCTAssertEqual(roundTrip["settings"]?.keys, original.settings.keys)
    }

    func testPutBodyHasSchemaSettingsAndReadRevisionOnly() throws {
        let editor = ModSettingsEditor(snapshot: try snapshot())
        let body = try editor.putBody()
        XCTAssertEqual(body.keys, ["schemaVersion", "settings", "revision"])
        XCTAssertEqual(body["schemaVersion"], .int(1))
        XCTAssertEqual(body["revision"], .int(4))
        XCTAssertEqual(body["settings"], editor.settings)
    }

    func testRebaseKeepsChangedPathsAndUnrelatedRemoteChanges() throws {
        let initial = try snapshot()
        var local = ModSettingsEditor(snapshot: initial)
        local.set(.int(2), at: ["bias"])
        local.set(.string("max"), at: ["futureFeature", "local"])
        var remote = initial.settings
        remote["keepWarm"] = .bool(true)
        remote.set(.string("remote"), at: ["futureFeature", "other"])
        local.rebase(on: ModSettingsSnapshot(settings: remote, revision: 5))
        XCTAssertEqual(local.settings["bias"], .int(2))
        XCTAssertEqual(local.settings["keepWarm"], .bool(true))
        XCTAssertEqual(local.settings["futureFeature"]?["other"], .string("remote"))
        XCTAssertEqual(local.settings["futureFeature"]?["local"], .string("max"))
        XCTAssertEqual(try local.putBody()["revision"], .int(5))
    }

    func testModeChangesAndArraysAreAtomicAndRemovalSurvives() throws {
        let before = try JSONValue(string: #"{"rule":{"mode":"old","a":1},"list":[1],"remove":true}"#)
        let after = try JSONValue(string: #"{"rule":{"mode":"ladder","rungs":{}},"list":[2]}"#)
        let remote = try JSONValue(string: #"{"rule":{"mode":"old","b":2},"list":[3],"remove":true,"keep":1}"#)
        let merged = ModSettingsEditor.applying(ModSettingsEditor.changes(from: before, to: after), to: remote)
        XCTAssertEqual(merged["rule"], after["rule"])
        XCTAssertEqual(merged["list"], after["list"])
        XCTAssertNil(merged["remove"])
        XCTAssertEqual(merged["keep"], .int(1))
    }

    func testAcknowledgeKeepsEditsMadeDuringSave() throws {
        let original = try snapshot()
        var editor = ModSettingsEditor(snapshot: original)
        editor.set(.int(1), at: ["bias"])
        let sent = editor.settings
        editor.set(.bool(true), at: ["keepWarm"])
        var normalized = sent
        normalized["serverAdded"] = .bool(true)
        editor.acknowledge(ModSettingsSnapshot(settings: normalized, revision: 5), sent: sent)
        XCTAssertEqual(editor.settings["bias"], .int(1))
        XCTAssertEqual(editor.settings["keepWarm"], .bool(true))
        XCTAssertEqual(editor.settings["serverAdded"], .bool(true))
        XCTAssertTrue(editor.isDirty)
    }

    func testEffortBoundsAreAlwaysOrdered() throws {
        var editor = ModSettingsEditor(snapshot: try snapshot("mod-newer"))
        editor.setEffortBound(.max, floor: true)
        XCTAssertEqual(editor.settings["floor"], .string("max"))
        XCTAssertEqual(editor.settings["ceiling"], .string("max"))
        editor.setEffortBound(.low, floor: false)
        XCTAssertEqual(editor.settings["floor"], .string("low"))
        XCTAssertEqual(editor.settings["ceiling"], .string("low"))
        editor.set(.string("max"), at: ["floor"])
        XCTAssertThrowsError(try editor.putBody())
    }

    func testRungAddReplaceMoveRemoveAndLastStepProtection() throws {
        let one = try JSONValue(string: #"{"target":{"agent":"one"},"effort":"low","future":true}"#)
        let two = try JSONValue(string: #"{"target":{"agent":"two"},"effort":"high"}"#)
        let first = JSONValue.array([one])
        let added = ModSettingsEditor.editing(first, .add(two))
        let moved = ModSettingsEditor.editing(added, .move(1, 0))
        XCTAssertEqual(moved, .array([two, one]))
        XCTAssertEqual(ModSettingsEditor.editing(moved, .remove(0)), first)
        XCTAssertEqual(ModSettingsEditor.editing(first, .remove(0)), first)
        XCTAssertEqual(ModSettingsEditor.editing(first, .move(0, -1)), first)
        XCTAssertEqual(ModSettingsEditor.editing(added, .replace(1, one)), .array([one, one]))
    }

    func testCredentialFieldsNestedInArraysAndSizeLimitAreRejected() throws {
        let secret = try JSONValue(string: #"{"unknown":[{"access_token":"made-up"}]}"#)
        XCTAssertThrowsError(try ModSettingsEditor.validate(secret))
        XCTAssertNoThrow(try ModSettingsEditor.validate(.object([("keepWarmMinTokens", .int(30000))])))
        XCTAssertThrowsError(try ModSettingsEditor.validate(.object([("large", .string(String(repeating: "x", count: ModSettingsEditor.maximumBytes)))])))
        XCTAssertThrowsError(try ModSettingsSnapshot(document: JSONValue(string: #"{"settings":{},"revision":-1}"#)))
        XCTAssertThrowsError(try ModSettingsSnapshot(document: JSONValue(string: #"{"settings":{},"revision":0.5}"#)))
    }

    func testModeCountAndNamesAreValidatedWithoutDroppingUnknownFields() throws {
        var editor = ModSettingsEditor(snapshot: try snapshot("mod-newer"))
        let mode = try XCTUnwrap(editor.settings["modes"]?[0])
        editor.set(.array(Array(repeating: mode, count: ModSettingsEditor.maximumModes)), at: ["modes"])
        XCTAssertNoThrow(try editor.putBody())
        editor.set(.array(Array(repeating: mode, count: ModSettingsEditor.maximumModes + 1)), at: ["modes"])
        XCTAssertThrowsError(try editor.putBody())
        var unnamed = mode
        unnamed["name"] = .string("   ")
        editor.set(.array([unnamed]), at: ["modes"])
        XCTAssertThrowsError(try editor.putBody())
        XCTAssertEqual(editor.settings["modes"]?[0]?["futureMode"], .string("kept"))
    }

    func testOptionsIncludeJudgeOnlyModelsAndAvailability() throws {
        let options = try JSONDecoder().decode(ModOptions.self, from: fixture("mod-options"))
        XCTAssertTrue(options.models.contains { $0.judgeOnly == true })
        let worker = try XCTUnwrap(options.workerChoices.first)
        XCTAssertFalse(worker.usable)
        XCTAssertEqual(worker.reason, "Sample quota exhausted")
        XCTAssertEqual(worker.billingTitle, "Pay per token")
        XCTAssertEqual(worker.availableEfforts, [.low, .high])
    }

    func testAllowListNewModelsAndLastSelectionProtection() throws {
        let options = try JSONDecoder().decode(ModOptions.self, from: fixture("mod-options"))
        var editor = ModSettingsEditor(snapshot: try snapshot())
        let choices = options.workerChoices.filter { $0.id != "general-purpose" }
        for choice in choices.dropFirst() { editor.setAllowed(choice, on: false, choices: choices) }
        editor.setAllowed(choices[0], on: false, choices: choices)
        XCTAssertTrue(ModSettingsEditor.isAllowed(choices[0], in: editor.settings))
        XCTAssertEqual(editor.settings["allow"]?.arrayValue?.count, 1)
        editor.set(.array([.string("old-catalog")]), at: ["allowKnown"])
        XCTAssertTrue(ModSettingsEditor.isAllowed(choices[1], in: editor.settings))
    }

    func testAPIUsesConflictBodyAndRevisionForRetry() async throws {
        let initial = try snapshot()
        var editor = ModSettingsEditor(snapshot: initial)
        editor.set(.int(2), at: ["bias"])
        var remote = initial.settings
        remote["keepWarm"] = .bool(true)
        let conflict = JSONValue.object([("settings", remote), ("revision", .int(8))]).serialized()
        let client = MockRouter.client { request in
            if request.json?["revision"] == .int(4) { return .json(conflict, status: 409) }
            return .json(JSONValue.object([("settings", request.json?["settings"] ?? .null), ("revision", .int(9))]).serialized())
        }
        let saved = try await client.saveModSettings(editor)
        XCTAssertEqual(saved.settings["bias"], .int(2))
        XCTAssertEqual(saved.settings["keepWarm"], .bool(true))
        XCTAssertEqual(MockRouter.requests().count, 2)
        XCTAssertEqual(MockRouter.requests().last?.json?["revision"], .int(8))
        XCTAssertTrue(MockRouter.requests().allSatisfy { $0.method == "PUT" && $0.path == "/api/mod-settings" })
    }

    func testThreeConflictAttemptsStopWithoutAnotherWrite() async throws {
        let original = try snapshot()
        let conflict = JSONValue.object([("settings", original.settings), ("revision", .int(5))]).serialized()
        let client = MockRouter.client { _ in .json(conflict, status: 409) }
        do {
            _ = try await client.saveModSettings(ModSettingsEditor(snapshot: original))
            XCTFail("expected conflict")
        } catch ModSaveError.conflict { } catch { XCTFail("unexpected \(error)") }
        XCTAssertEqual(MockRouter.requests().count, ModSettingsEditor.maximumSaveAttempts)
    }

    func testUnsupportedSchemaStopsImmediately() async throws {
        let client = MockRouter.client { _ in .json(#"{"error":"schema unsupported"}"#, status: 426) }
        do {
            _ = try await client.saveModSettings(ModSettingsEditor(snapshot: snapshot()))
            XCTFail("expected unsupported schema")
        } catch ModSaveError.unsupportedSchema { } catch { XCTFail("unexpected \(error)") }
        XCTAssertEqual(MockRouter.requests().count, 1)
    }

    func testReadsUseMockRouterOnly() async throws {
        let settings = try fixtureText("mod-older")
        let options = try fixtureText("mod-options")
        let client = MockRouter.client { .json($0.path == "/api/mod-options" ? options : settings) }
        let snapshot = try await client.modSettings()
        let catalog = try await client.modOptions()
        XCTAssertEqual(snapshot.revision, 4)
        XCTAssertEqual(catalog.agents.count, 1)
    }
}

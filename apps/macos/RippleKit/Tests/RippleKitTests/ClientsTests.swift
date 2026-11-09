import XCTest

@testable import RippleKit

final class ClientsTests: XCTestCase {
    func testSlotClearAndWorkerToolsTouchOnlyTheirPaths() throws {
        let original = try JSONValue(data: fixture("config-routing"))
        for slot in CliModelSlot.allCases {
            var edited = original
            ConfigEdits.setSlot(slot, model: "", in: &edited)
            var expected = original
            expected.set(.string(""), at: ["cli", "models", slot.rawValue])
            XCTAssertEqual(edited.serialized(), expected.serialized())
            XCTAssertEqual(edited.value(at: ["cli", "models", "futureSlot"])?.stringValue, "keep")
        }
        var edited = original
        ConfigEdits.setLimitWorkerTools(true, in: &edited)
        var expected = original
        expected.set(.bool(true), at: ["cli", "limitWorkerTools"])
        XCTAssertEqual(edited.serialized(), expected.serialized())
    }

    func testCliPathsCanBeCreatedWithoutRewritingOtherConfig() throws {
        var config = try JSONValue(string: #"{"providers":{"z":{},"a":{}},"routes":{},"unknown":1e3}"#)
        ConfigEdits.setSlot(.smallFast, model: "search-model", in: &config)
        XCTAssertEqual(
            config.serialized(), #"{"providers":{"z":{},"a":{}},"routes":{},"unknown":1e3,"cli":{"models":{"smallFast":"search-model"}}}"#)
    }

    func testWebSearchPreservesMaxResultsAndUnknownOptions() throws {
        let original = try JSONValue(data: fixture("config-routing"))
        var edited = original
        ConfigEdits.setWebSearch(SearchBackend(provider: "beta", model: "beta-search"), in: &edited)
        var expected = original
        expected.set(.string("beta"), at: ["webSearch", "provider"])
        expected.set(.string("beta-search"), at: ["webSearch", "model"])
        XCTAssertEqual(edited.serialized(), expected.serialized())
        ConfigEdits.setWebSearch(nil, in: &edited)
        expected["webSearch"] = nil
        XCTAssertEqual(edited.serialized(), expected.serialized())
    }

    func testPickerDeduplicatesRemovesOrphansAndPreservesAmbiguousAndPrefixRules() throws {
        let original = try JSONValue(data: fixture("config-routing"))
        var edited = original
        ConfigEdits.setPickerModel(provider: "beta", model: "beta-model", enabled: true, in: &edited)
        let extras = try XCTUnwrap(edited.value(at: ["cli", "extraModels"])?.arrayValue)
        XCTAssertEqual(extras.compactMap { $0["model"]?.stringValue }, ["alpha-model", "beta-model"])
        XCTAssertEqual(extras[0].serialized(), original.value(at: ["cli", "extraModels"])?[0]?.serialized())
        XCTAssertEqual(extras[1]["contextWindow"]?.intValue, 128000)
        XCTAssertEqual(edited["direct"]?.arrayValue?.compactMap { $0["prefix"]?.stringValue }, ["legacy-", "shared-model"])
        XCTAssertEqual(edited["direct"]?[0]?.serialized(), original["direct"]?[0]?.serialized())
        XCTAssertEqual(edited["direct"]?[1]?.serialized(), original["direct"]?[1]?.serialized())
        for key in original.keys where key != "cli" && key != "direct" {
            XCTAssertEqual(edited[key]?.serialized(), original[key]?.serialized(), key)
        }
        for key in original["cli"]?.keys ?? [] where key != "extraModels" {
            XCTAssertEqual(edited["cli"]?[key]?.serialized(), original["cli"]?[key]?.serialized(), key)
        }
    }

    func testPickerCreatesOnlyNeededAmbiguousRuleAndUntickingKeepsIt() throws {
        var config = try JSONValue(data: fixture("config-routing"))
        config["direct"] = .array([])
        ConfigEdits.setPickerModel(provider: "alpha", model: "shared-model", enabled: true, in: &config)
        XCTAssertEqual(config["direct"]?.arrayValue?.count, 1)
        XCTAssertEqual(config["direct"]?[0]?["provider"]?.stringValue, "alpha")
        ConfigEdits.setPickerModel(provider: "alpha", model: "shared-model", enabled: false, in: &config)
        XCTAssertEqual(config["direct"]?.arrayValue?.count, 1)
        XCTAssertFalse(
            config.value(at: ["cli", "extraModels"])?.arrayValue?.contains { $0["model"]?.stringValue == "shared-model" } ?? true)
    }

    func testPickerContextChangesOnlyThatEntriesWindow() throws {
        let original = try JSONValue(data: fixture("config-routing"))
        var config = original
        try ConfigEdits.setPickerContext(model: "alpha-model", window: 123000, in: &config)
        var expected = original
        var extras = try XCTUnwrap(expected.value(at: ["cli", "extraModels"])?.arrayValue)
        extras[0]["contextWindow"] = .int(123000)
        extras[2]["contextWindow"] = .int(123000)
        expected.set(.array(extras), at: ["cli", "extraModels"])
        XCTAssertEqual(config.serialized(), expected.serialized())
        XCTAssertThrowsError(try ConfigEdits.setPickerContext(model: "alpha-model", window: 0, in: &config))
    }

    func testCommandsSendExactEnabledBodiesAndLongPickerTimeout() async throws {
        let client = MockRouter.client { _ in .json(#"{"ok":true,"output":"done"}"#) }
        _ = try await client.setDesktopPicker(true)
        _ = try await client.setStatusMod(false)
        _ = try await client.setCodexIntegration(true)
        let requests = MockRouter.requests()
        XCTAssertEqual(requests.map(\.path), ["/api/picker", "/api/status-mod", "/api/codex"])
        XCTAssertEqual(requests.map(\.method), ["POST", "POST", "POST"])
        XCTAssertEqual(requests.compactMap { $0.json?.serialized() }, [#"{"enabled":true}"#, #"{"enabled":false}"#, #"{"enabled":true}"#])
        XCTAssertGreaterThan(AdminClient.pickerTimeout, AdminClient.writeTimeout)
        let request = client.request("POST", "/api/picker", query: [], body: nil, timeout: AdminClient.pickerTimeout)
        XCTAssertEqual(request.timeoutInterval, AdminClient.pickerTimeout)
    }

    func testCliFailureOutputIsNeverLost() async {
        let failedHTTP = MockRouter.client { _ in .json(#"{"ok":false,"output":"Keychain trust was cancelled"}"#, status: 500) }
        do {
            _ = try await failedHTTP.setDesktopPicker(true)
            XCTFail("expected failure")
        } catch { XCTAssertEqual(error as? AdminError, .http(status: 500, message: "Keychain trust was cancelled")) }
        let failedOK = MockRouter.client { _ in .json(#"{"ok":false,"output":"Could not install mod"}"#) }
        do {
            _ = try await failedOK.setStatusMod(true)
            XCTFail("expected failure")
        } catch { XCTAssertEqual(error as? AdminError, .http(status: 500, message: "Could not install mod")) }
    }

    func testCapabilitiesUseReportedSearchSupportAndDecodePickerInjection() async throws {
        let text = try fixtureText("clients-status")
        let client = MockRouter.client { _ in .json(text) }
        let capabilities = try await client.clientCapabilities()
        XCTAssertEqual(capabilities.pickerInjected, 2)
        XCTAssertEqual(capabilities.pickerLastAt, "2026-01-02T03:04:05.000Z")
        XCTAssertTrue(capabilities.canSearch(provider: "alpha", model: "any-model"))
        XCTAssertTrue(capabilities.canSearch(provider: "beta", model: "beta-search"))
        XCTAssertFalse(capabilities.canSearch(provider: "beta", model: "beta-model"))
        XCTAssertFalse(capabilities.canSearch(provider: "unknown", model: "beta-search"))
        let status = try RouterStatus(document: JSONValue(string: text))
        XCTAssertEqual(status.picker?.enabled, true)
        XCTAssertEqual(status.statusMod, false)
    }

    func testCodexReadDoesNotMutateIntegration() async throws {
        let client = MockRouter.client { _ in .json(#"{"enabled":true,"codexHome":"/test/codex","configPath":"/test/codex/config.toml"}"#) }
        let state = try await client.codexIntegration()
        XCTAssertTrue(state.enabled)
        XCTAssertEqual(state.configPath, "/test/codex/config.toml")
        XCTAssertEqual(MockRouter.requests().map(\.method), ["GET"])
    }
}

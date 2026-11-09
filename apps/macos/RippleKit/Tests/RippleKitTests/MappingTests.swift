import XCTest

@testable import RippleKit

final class MappingTests: XCTestCase {
    private func config() throws -> JSONValue { try JSONValue(data: fixture("config-routing")) }

    // Compare serialized subtrees, not JSONValue equality (which deliberately equates number forms).
    private func assertUntouched(
        _ original: JSONValue, _ edited: JSONValue, except keys: Set<String>, file: StaticString = #filePath, line: UInt = #line
    ) {
        XCTAssertEqual(original.keys, edited.keys, file: file, line: line)
        for key in original.keys where !keys.contains(key) {
            XCTAssertEqual(original[key]?.serialized(), edited[key]?.serialized(), key, file: file, line: line)
        }
    }

    func testRouteAddEditRenameRemovePreserveOrderAndUnknownBytes() throws {
        let original = try config()
        var edited = original
        let originalRoute = try XCTUnwrap(original["routes"]?["claude-source-a"])
        try ConfigEdits.apply(
            [
                .add(source: "claude-source-c", provider: "beta", model: "beta-model", effort: nil),
                .change(source: "claude-source-a", field: .model, value: .string("new-model")),
                .change(source: "claude-source-a", field: .effort, value: nil),
                .rename(source: "claude-source-a", destination: "claude-source-renamed"),
                .remove(source: "claude-source-c"),
            ], to: &edited)
        assertUntouched(original, edited, except: ["routes"])
        XCTAssertEqual(edited["providers"]?.keys, ["beta", "alpha", "ingress", "pool"])
        XCTAssertEqual(edited["routes"]?.keys, ["claude-source-renamed", "claude-source-b"])
        XCTAssertEqual(edited["routes"]?["claude-source-b"]?.serialized(), original["routes"]?["claude-source-b"]?.serialized())
        let route = try XCTUnwrap(edited["routes"]?["claude-source-renamed"])
        for key in originalRoute.keys where key != "effort" && key != "model" {
            XCTAssertEqual(route[key]?.serialized(), originalRoute[key]?.serialized(), key)
        }
        XCTAssertNil(route["effort"])
        XCTAssertEqual(route["model"]?.stringValue, "new-model")
        XCTAssertEqual(route.keys, originalRoute.keys.filter { $0 != "effort" })
    }

    func testOnlyEditedRouteFieldsAreRebasedOnFreshConfigAndWarningIsReturned() async throws {
        var fresh = try config()
        fresh.set(.string("concurrent-model"), at: ["routes", "claude-source-a", "model"])
        fresh.set(.number("9e3"), at: ["routes", "claude-source-a", "newServerField"])
        let text = fresh.serialized()
        let client = MockRouter.client { request in
            request.method == "GET" ? .json(text) : .json(#"{"ok":true,"warning":"CLI slots could not be synced"}"#)
        }
        let warning = try await client.editRoutes([.change(source: "claude-source-a", field: .effort, value: .string("low"))])
        XCTAssertEqual(warning, "CLI slots could not be synced")
        let requests = MockRouter.requests()
        XCTAssertEqual(requests.map(\.method), ["GET", "PUT"])
        XCTAssertEqual(requests.map(\.path), ["/api/config", "/api/config"])
        let written = try XCTUnwrap(requests.last?.json)
        var expected = fresh
        expected.set(.string("low"), at: ["routes", "claude-source-a", "effort"])
        XCTAssertEqual(written.serialized(), expected.serialized())
    }

    func testDuplicateAndMissingRoutesFailAtomically() throws {
        let original = try config()
        var edited = original
        XCTAssertThrowsError(
            try ConfigEdits.apply(
                [
                    .change(source: "claude-source-a", field: .effort, value: .string("low")),
                    .rename(source: "claude-source-a", destination: "claude-source-b"),
                ], to: &edited))
        XCTAssertEqual(edited.serialized(), original.serialized())
        XCTAssertThrowsError(
            try ConfigEdits.apply([.add(source: "claude-source-a", provider: "beta", model: "beta-model", effort: nil)], to: &edited))
        XCTAssertThrowsError(try ConfigEdits.apply([.change(source: "missing", field: .model, value: .string("x"))], to: &edited))
        XCTAssertEqual(edited.serialized(), original.serialized())
    }

    func testContextValidationAndRemoval() throws {
        var edited = try config()
        XCTAssertThrowsError(
            try ConfigEdits.apply([.change(source: "claude-source-a", field: .contextWindow, value: .int(0))], to: &edited))
        XCTAssertThrowsError(try ConfigEdits.contextWindow("1.5"))
        XCTAssertThrowsError(try ConfigEdits.contextWindow("-3"))
        XCTAssertNil(try ConfigEdits.contextWindow("  "))
        XCTAssertEqual(try ConfigEdits.contextWindow(" 128000 "), 128000)
        try ConfigEdits.apply([.change(source: "claude-source-a", field: .contextWindow, value: nil)], to: &edited)
        XCTAssertNil(edited["routes"]?["claude-source-a"]?["contextWindow"])
    }

    func testRoutingProjectionExcludesIngressOnlyProvidersAndKeepsOrder() throws {
        let projection = RoutingConfiguration(document: try config())
        XCTAssertEqual(projection.providers.map(\.id), ["beta", "alpha", "pool"])
        XCTAssertEqual(projection.routes.map(\.source), ["claude-source-a", "claude-source-b"])
        XCTAssertEqual(projection.pickerModels.filter { $0.id == "shared-model" }.map(\.provider), ["alpha"])
        XCTAssertEqual(Set(projection.pickerModels.map(\.id)).count, projection.pickerModels.count)
    }

    func testModelAndEffortCatalogsRespectExplicitEmptyLadders() async throws {
        let client = MockRouter.client { request in
            if request.path == "/api/claude-models" {
                return .json(#"{"models":[{"id":"claude-new","name":"New Claude"}],"source":"picker"}"#)
            }
            return .json(#"{"providers":{"beta":{"default":["high"],"models":{"shared-model":[]}},"alpha":{"default":["low","high"]}}}"#)
        }
        let models = try await client.claudeModels()
        XCTAssertEqual(models.models.first?.label, "New Claude")
        XCTAssertEqual(models.source, "picker")
        let efforts = try await client.effortLevels()
        let beta = RoutingConfiguration(document: try config()).providers[0]
        XCTAssertEqual(efforts.levels(provider: "beta", model: beta.models[0]), [])
        XCTAssertEqual(efforts.levels(provider: "beta", model: beta.models[1]), ["high"])
    }

    func testContextWindowsMissingOn095IsOptionalButOtherErrorsSurface() async throws {
        let old = MockRouter.client { _ in .dashboardPage }
        let missing = try await old.contextWindows()
        XCTAssertNil(missing)
        XCTAssertEqual(MockRouter.requests().first?.path, "/api/context-windows")
        let modern = MockRouter.client { _ in .json(#"{"windows":{"alpha-model":400000}}"#) }
        let windows = try await modern.contextWindows()
        XCTAssertEqual(windows?.windows["alpha-model"], 400000)
        let failed = MockRouter.client { _ in .json(#"{"error":"try later"}"#, status: 503) }
        do {
            _ = try await failed.contextWindows()
            XCTFail("expected error")
        } catch { XCTAssertEqual(error as? AdminError, .http(status: 503, message: "try later")) }
    }
}

import XCTest
@testable import RippleKit

final class AdminClientTests: XCTestCase {
    // WHY: the hardened admin API refuses a cross-site Sec-Fetch-Site and checks Origin on writes.
    // A native client passes by sending neither, and a loopback Host with the port.
    func testWritesSendNoOriginNorFetchMetadataAndALoopbackHost() async throws {
        let client = MockRouter.client { _ in .json(#"{"ok":true}"#) }
        try await client.setPreferredClaudeAccount("acct-2")
        let sent = try XCTUnwrap(MockRouter.requests().first)
        XCTAssertEqual(sent.method, "PUT")
        XCTAssertEqual(sent.path, "/api/claude-accounts")
        XCTAssertNil(sent.headers.first { $0.key.lowercased() == "origin" })
        XCTAssertNil(sent.headers.first { $0.key.lowercased() == "sec-fetch-site" })
        XCTAssertEqual(sent.json?["preferred"]?.stringValue, "acct-2")
        XCTAssertEqual(client.baseURL.host, "127.0.0.1")
    }

    func testPreferredNilSendsJSONNull() async throws {
        let client = MockRouter.client { _ in .json(#"{"ok":true}"#) }
        try await client.setPreferredClaudeAccount(nil)
        XCTAssertEqual(MockRouter.requests().first?.json?["preferred"], .null)
    }

    // WHY: a 0.9.x router serves its dashboard (HTTP 200 text/html) for routes it lacks. Treating
    // that as success would decode garbage; it must read as "this version lacks the route".
    func testHTMLAnswerIsRouteMissing() async {
        let client = MockRouter.client { _ in .dashboardPage }
        do {
            _ = try await client.limits()
            XCTFail("expected routeMissing")
        } catch {
            XCTAssertEqual(error as? AdminError, .routeMissing(path: "/api/limits"))
        }
    }

    func testRouterErrorTextIsKept() async {
        let client = MockRouter.client { _ in .json(#"{"error":"account is external"}"#, status: 409) }
        do {
            try await client.removeClaudeAccount("current")
            XCTFail("expected http error")
        } catch {
            XCTAssertEqual(error as? AdminError, .http(status: 409, message: "account is external"))
        }
    }

    func testTransportFailureIsOffline() async {
        let client = MockRouter.client { _ in nil }
        do {
            _ = try await client.status()
            XCTFail("expected offline")
        } catch {
            XCTAssertEqual(error as? AdminError, .offline)
        }
    }

    // WHY: ids go into the path; one with a reserved character must not change the route.
    func testPathSegmentsArePercentEncoded() async throws {
        let client = MockRouter.client { _ in .json(#"{"ok":true}"#) }
        try await client.removeChatGptAccount("a/b c")
        let sent = try XCTUnwrap(MockRouter.requests().first)
        XCTAssertEqual(sent.path, "/api/chatgpt-accounts/a/b c") // URL.path decodes for display
        XCTAssertNil(sent.query)
        XCTAssertEqual(sent.method, "DELETE")
    }

    // WHY: an older router ignores from/to and silently answers its last hour; the client must notice
    // (no `from` echoed) and ask for "since midnight" from the ring instead.
    func testTodaySummaryFallsBackToSinceOnOlderRouters() async throws {
        let client = MockRouter.client { request in
            .json(#"{"total":{"count":\#(request.query?.contains("since") == true ? 42 : 7),"ok":1,"failed":0,"input":0,"cached":0,"output":0,"cacheHitPercent":90,"avgMs":10},"providers":{}}"#)
        }
        let summary = try await client.summarySinceMidnight()
        XCTAssertEqual(summary.total.count, 42)
        XCTAssertFalse(summary.isRange)
        XCTAssertEqual(MockRouter.requests().count, 2)
    }

    func testTodaySummaryUsesRangeWhenEchoed() async throws {
        let client = MockRouter.client { _ in
            .json(#"{"total":{"count":5,"ok":5,"failed":0,"input":1,"cached":2,"cacheWrite":0,"output":3,"cacheHitPercent":66.7,"avgMs":12},"providers":{},"models":[],"earliest":null,"from":1,"to":2}"#)
        }
        let summary = try await client.summarySinceMidnight()
        XCTAssertTrue(summary.isRange)
        XCTAssertEqual(MockRouter.requests().count, 1)
    }
}

final class EndpointTests: XCTestCase {
    func testDefaultPortIsProxyPlusOne() {
        XCTAssertEqual(Endpoint.adminURL(configData: nil).absoluteString, "http://127.0.0.1:8791")
    }

    func testAdminPortFollowsListenPort() {
        let data = Data(#"{"listen":{"host":"127.0.0.1","port":9000},"providers":{"x":{"apiKey":"k"}}}"#.utf8)
        XCTAssertEqual(Endpoint.adminURL(configData: data).absoluteString, "http://127.0.0.1:9001")
    }

    func testExplicitAdminPortWins() {
        let data = Data(#"{"listen":{"port":9000},"admin":{"port":9100}}"#.utf8)
        XCTAssertEqual(Endpoint.adminURL(configData: data).absoluteString, "http://127.0.0.1:9100")
    }

    func testEnvironmentOverride() {
        XCTAssertEqual(Endpoint.adminURL(environment: [Endpoint.overrideEnvironmentKey: "http://127.0.0.1:5555"]).absoluteString,
                       "http://127.0.0.1:5555")
    }
}

final class AdminExchangeTests: XCTestCase {
    // WHY: PUT /api/mod-settings answers a stale revision with 409 and the current snapshot as the
    // body. The caller rebases on that body, so a non-2xx answer must not lose it.
    func testExchangeKeepsTheBodyOfAConflict() async throws {
        let client = MockRouter.client { _ in .json(#"{"settings":{"bias":1},"revision":7,"stored":true}"#, status: 409) }
        let answer = try await client.exchange("PUT", "/api/mod-settings", json: .object([("schemaVersion", .int(1))]))
        XCTAssertEqual(answer.status, 409)
        XCTAssertEqual(answer.document?["revision"]?.intValue, 7)
    }

    func testExchangeStillDetectsAMissingRoute() async {
        let client = MockRouter.client { _ in .dashboardPage }
        do {
            _ = try await client.exchange("PUT", "/api/mod-settings")
            XCTFail("expected routeMissing")
        } catch {
            XCTAssertEqual(error as? AdminError, .routeMissing(path: "/api/mod-settings"))
        }
    }
}

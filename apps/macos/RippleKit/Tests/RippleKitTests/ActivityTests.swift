import XCTest
@testable import RippleKit

final class ActivityTests: XCTestCase {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
        return calendar
    }

    private func date(_ value: String) -> Date {
        try! Date(value, strategy: .iso8601)
    }

    func testLegacyFixtureDefaultsAdditiveFields() throws {
        let summary = try JSONDecoder().decode(RequestSummary.self, from: fixture("activity-legacy"))
        XCTAssertFalse(summary.isRange)
        XCTAssertNil(summary.earliest)
        XCTAssertTrue(summary.models.isEmpty)
        XCTAssertEqual(summary.total.cacheWrite, 0)
        XCTAssertEqual(summary.total.count, 8)
    }

    func testRangeFixtureAndClientSideProviderFiltering() throws {
        let summary = try JSONDecoder().decode(RequestSummary.self, from: fixture("activity-range"))
        XCTAssertTrue(summary.isRange)
        XCTAssertNotNil(summary.to)
        XCTAssertEqual(summary.earliest, "2026-09-01T00:00:00.000Z")
        XCTAssertEqual(summary.bucket(for: nil), summary.total)
        XCTAssertEqual(summary.bucket(for: "sample-a")?.count, 7)
        XCTAssertEqual(summary.bucket(for: "sample-b")?.cacheHitPercent, 75)
        XCTAssertNil(summary.bucket(for: "absent"))
        XCTAssertEqual(summary.models(for: nil).count, 2)
        XCTAssertEqual(summary.models(for: "sample-a").map(\.model), ["example-large"])
        XCTAssertTrue(summary.models(for: "absent").isEmpty)
    }

    func testRequestFixturesAcceptBothStatusTypesAndMissingFields() throws {
        let rows = try JSONDecoder().decode(RecentRequests.self, from: fixture("activity-requests")).requests
        XCTAssertEqual(rows[0].status, .number(200))
        XCTAssertNotNil(rows[0].date)
        XCTAssertNil(rows[0].usage?.cacheWrite)
        XCTAssertEqual(rows[1].status, .text("draining"))
        XCTAssertNotNil(rows[1].date)
        XCTAssertEqual(rows[1].servedTier, "default")
        XCTAssertEqual(rows[1].usage?.cacheWrite, 10)
        XCTAssertEqual(rows[1].resent, true)
        XCTAssertEqual(rows[1].session, "example-session")
        XCTAssertNil(rows[2].date)
        XCTAssertNil(rows[2].ok)
        XCTAssertNil(rows[2].usage?.input)
        let empty = try JSONDecoder().decode(RequestRecord.self, from: Data("{}".utf8))
        XCTAssertFalse(empty.id.isEmpty)
    }

    func testPeriodQueriesUseLocalCalendarDays() {
        let now = date("2026-10-21T19:30:00Z")
        let expected: [(ActivityPeriod, String)] = [
            (.hour, "2026-10-21T18:30:00Z"),
            (.today, "2026-10-21T07:00:00Z"),
            (.sevenDays, "2026-10-15T07:00:00Z"),
            (.thirtyDays, "2026-09-22T07:00:00Z"),
            (.month, "2026-10-01T07:00:00Z"),
            (.all, "1970-01-01T00:00:00Z")
        ]
        for (period, from) in expected {
            let query = ActivityQuery.make(period: period, now: now, calendar: calendar)
            XCTAssertEqual(query.from, date(from), period.title)
            XCTAssertEqual(query.to, now)
            XCTAssertEqual(query.rangeItems.map(\.name), ["from", "to"])
            XCTAssertEqual(query.rangeItems.first?.value, String(Int(date(from).timeIntervalSince1970 * 1000)))
        }
        XCTAssertEqual(ActivityQuery.make(period: .hour, now: now, calendar: calendar).legacySince, 3600)
        XCTAssertEqual(ActivityQuery.make(period: .today, now: now, calendar: calendar).legacySince, 45000)
        for period in [ActivityPeriod.sevenDays, .thirtyDays, .month, .all, .custom] {
            XCTAssertNil(ActivityQuery.make(period: period, now: now, calendar: calendar).fallbackItems)
        }
    }

    func testCustomDatesAreInclusiveReversibleAndDSTSafe() {
        let first = date("2026-11-01T20:00:00Z")
        let second = date("2026-10-31T20:00:00Z")
        let query = ActivityQuery.make(period: .custom, calendar: calendar, customFrom: first, customTo: second)
        XCTAssertEqual(query.from, date("2026-10-31T07:00:00Z"))
        XCTAssertEqual(query.to, date("2026-11-02T08:00:00Z"))
        XCTAssertEqual(query, ActivityQuery.make(period: .custom, calendar: calendar, customFrom: second, customTo: first))
    }

    func testTodayFallbackAtMidnightStillHasASecond() {
        let query = ActivityQuery.make(period: .today, now: date("2026-10-21T07:00:00Z"), calendar: calendar)
        XCTAssertEqual(query.legacySince, 1)
    }

    func testOldRouterFallsBackForHourAndToday() async throws {
        let text = try fixtureText("activity-legacy")
        for period in [ActivityPeriod.hour, .today] {
            let client = MockRouter.client { _ in .json(text) }
            let query = ActivityQuery.make(period: period, now: date("2026-10-21T19:30:00Z"), calendar: calendar)
            let result = try await client.activitySummary(query: query)
            XCTAssertTrue(result.periodAvailable)
            XCTAssertFalse(result.summary.isRange)
            XCTAssertTrue(result.note.contains("2,000"))
            let requests = MockRouter.requests()
            XCTAssertEqual(requests.count, 2)
            XCTAssertTrue(requests[0].query?.contains("from=") == true)
            XCTAssertEqual(requests[1].query, "since=\(query.legacySince!)")
            XCTAssertTrue(requests.allSatisfy { $0.method == "GET" && $0.path == "/api/requests/summary" })
        }
    }

    func testOldRouterDoesNotMislabelLastHourAsLongHistory() async throws {
        let text = try fixtureText("activity-legacy")
        for period in [ActivityPeriod.sevenDays, .thirtyDays, .month, .all, .custom] {
            let client = MockRouter.client { _ in .json(text) }
            let result = try await client.activitySummary(query: .make(period: period))
            XCTAssertFalse(result.periodAvailable)
            XCTAssertTrue(result.note.contains("no totals"))
            XCTAssertEqual(MockRouter.requests().count, 1)
        }
    }

    func testNewRouterUsesRangeWithoutFallbackOrProviderQuery() async throws {
        let text = try fixtureText("activity-range")
        let client = MockRouter.client { _ in .json(text) }
        let result = try await client.activitySummary(query: .make(period: .sevenDays))
        XCTAssertTrue(result.summary.isRange)
        XCTAssertTrue(result.periodAvailable)
        XCTAssertEqual(result.summary.bucket(for: "sample-a")?.count, 7)
        XCTAssertEqual(MockRouter.requests().count, 1)
        XCTAssertFalse(MockRouter.requests()[0].query?.contains("provider") == true)
    }

    func testRecentRequestsQueryAndNewestFirstOrder() async throws {
        let text = try fixtureText("activity-requests")
        let client = MockRouter.client { _ in .json(text) }
        let rows = try await client.recentRequests(provider: "sample & one")
        XCTAssertEqual(rows.map(\.id), ["example-new", "example-old", "example-minimal"])
        let sent = try XCTUnwrap(MockRouter.requests().first)
        let components = try XCTUnwrap(URLComponents(string: "http://localhost/?\(sent.query ?? "")"))
        let items = components.queryItems ?? []
        XCTAssertEqual(items.first { $0.name == "n" }?.value, "200")
        XCTAssertEqual(items.first { $0.name == "kind" }?.value, "messages,image")
        XCTAssertEqual(items.first { $0.name == "provider" }?.value, "sample & one")
        XCTAssertEqual(sent.path, "/api/requests")
        XCTAssertEqual(sent.method, "GET")
    }

    func testRouterLogIsPlainText() async throws {
        let client = MockRouter.client { _ in
            .init(contentType: "text/plain; charset=utf-8", body: Data("Example line\nSecond line\n".utf8))
        }
        let text = try await client.activityRouterLog()
        XCTAssertEqual(text, "Example line\nSecond line\n")
        XCTAssertEqual(MockRouter.requests().first?.path, "/api/logs")
        XCTAssertEqual(MockRouter.requests().first?.query, "n=200")
        XCTAssertEqual(MockRouter.requests().first?.method, "GET")
    }
}

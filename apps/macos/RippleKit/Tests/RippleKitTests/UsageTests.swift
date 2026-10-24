import XCTest
@testable import RippleKit

/// The fixtures are made up and pinned to this instant (2027-01-15 08:00 UTC).
private let now = Date(timeIntervalSince1970: 1_800_000_000)
private let hour: TimeInterval = 3600
private let day: TimeInterval = 86_400

final class UsageBuilderTests: XCTestCase {
    // WHY: the per-account /api/limits is what newer routers serve. Resets are epoch ms and
    // providers without subscription limits (google) are not account rows.
    func testPerAccountLimitsBecomeRows() throws {
        let response = try JSONDecoder().decode(LimitsResponse.self, from: fixture("limits-per-account"))
        let rows = try XCTUnwrap(UsageBuilder.fromLimits(response, now: now))
        XCTAssertEqual(rows.map(\.accountId), ["acct-a", "acct-b", "pro-1"])

        let work = rows[0]
        XCTAssertEqual(work.kind, .claude)
        XCTAssertTrue(work.isActive)
        XCTAssertTrue(work.isBlocked, "a spent 5-hour window blocks even with week to spare")
        XCTAssertEqual(work.weekly?.resetsAt, Date(timeIntervalSince1970: 1_800_345_600))

        let personal = rows[1]
        XCTAssertTrue(personal.isPreferred)
        XCTAssertEqual(personal.health, .cooling(until: Date(timeIntervalSince1970: 1_800_000_600)))
        XCTAssertTrue(personal.isStale)

        let pro = rows[2]
        XCTAssertEqual(pro.kind, .chatgpt)
        XCTAssertEqual(pro.provider, "chatgpt-subscription")
        XCTAssertNil(pro.fiveHour, "a weekly-only plan has no 5-hour window")
        XCTAssertEqual(pro.weekly?.usedPercent, 52)
    }

    // WHY: a router with only anonymous legacy rows cannot say which account is which; nil sends
    // the store to the account endpoints instead of drawing nameless rows.
    func testLegacyLimitsAreNotUsed() throws {
        let response = try JSONDecoder().decode(LimitsResponse.self, from: fixture("limits-legacy"))
        XCTAssertEqual(response.providers.first?.accounts.first?.windows.count, 2)
        XCTAssertNil(UsageBuilder.fromLimits(response, now: now))
    }

    // WHY: 0.9.x has no per-account limits; the popover is built from /api/claude-accounts and
    // /api/status. Reset times there are epoch seconds and the pool's states come from credentials.
    func testAccountEndpointsBecomeRows() throws {
        let claude = try JSONDecoder().decode(ClaudeAccountsResponse.self, from: fixture("accounts-claude"))
        let status = try RouterStatus(document: JSONValue(data: fixture("accounts-status")))
        let rows = UsageBuilder.fromAccounts(claude: claude, status: status, now: now)
        XCTAssertEqual(rows.map(\.accountId), ["current", "0b5c6a1e-0000-4000-8000-000000000001",
                                               "0b5c6a1e-0000-4000-8000-000000000002", "own-1", "codex", "own-2"])

        let current = rows[0]
        XCTAssertFalse(current.isPreferred, "a stored preferred account leads, not the current login")
        XCTAssertEqual(current.fiveHour?.usedPercent, 30)
        XCTAssertEqual(current.weekly?.resetsAt, Date(timeIntervalSince1970: 1_800_345_600))
        XCTAssertFalse(current.isStale)

        let spare = rows[1]
        XCTAssertTrue(spare.isPreferred)
        XCTAssertEqual(spare.health, .cooling(until: now.addingTimeInterval(120)))
        XCTAssertTrue(spare.isStale, "a quota read 11 days ago is stale")

        XCTAssertNil(rows[2].weekly, "no quota, no windows")
        XCTAssertTrue(rows[2].isStale)

        let own = rows[3]
        XCTAssertEqual(own.label, "me@example.com", "an empty label falls back to the email")
        XCTAssertEqual(own.plan, "prolite")
        XCTAssertTrue(own.isActive)
        XCTAssertNil(own.fiveHour)
        XCTAssertEqual(own.weekly?.usedPercent, 88, "a weekly-only plan reports its week as primary")

        XCTAssertEqual(rows[4].health, .cooling(until: now.addingTimeInterval(600)))
        XCTAssertEqual(rows[5].health, .other("unknown"), "an unknown router state is kept, not read as ready")
    }
}

final class DrainAdvisorTests: XCTestCase {
    private func account(_ id: String, active: Bool = false, weeklyUsed: Double, weeklyResetsIn: TimeInterval,
                         fiveHourUsed: Double = 0, health: AccountHealth = .ready) -> AccountUsage {
        AccountUsage(kind: .claude, provider: "claude", accountId: id, label: id, isActive: active, health: health,
                     fiveHour: UsageWindowState(usedPercent: fiveHourUsed, windowMinutes: Quota.fiveHourMinutes, resetsAt: now.addingTimeInterval(2 * hour)),
                     weekly: UsageWindowState(usedPercent: weeklyUsed, windowMinutes: Quota.weeklyMinutes, resetsAt: now.addingTimeInterval(weeklyResetsIn)))
    }

    // WHY: what is left on a week is lost at its reset, so the soonest reset is drained first,
    // even when another account has more room.
    func testSoonestWeeklyResetIsDrainedFirst() throws {
        let soon = account("soon", weeklyUsed: 70, weeklyResetsIn: day)
        let later = account("later", active: true, weeklyUsed: 10, weeklyResetsIn: 5 * day)
        let advice = try XCTUnwrap(DrainAdvisor.advice(for: [later, soon], now: now))
        XCTAssertEqual(advice.drainFirst.accountId, "soon")
        XCTAssertEqual(advice.expiringPercent, 30)
        XCTAssertEqual(advice.useNow?.accountId, "soon")
        XCTAssertTrue(DrainAdvisor.differsFromRouting(advice, accounts: [later, soon]))
        XCTAssertFalse(DrainAdvisor.differsFromRouting(advice, accounts: [account("soon", active: true, weeklyUsed: 70, weeklyResetsIn: day), later]))
    }

    func testSpentFiveHourWindowHandsTheLoadOver() throws {
        let soon = account("soon", weeklyUsed: 70, weeklyResetsIn: day, fiveHourUsed: 100)
        let later = account("later", weeklyUsed: 10, weeklyResetsIn: 5 * day)
        let advice = try XCTUnwrap(DrainAdvisor.advice(for: [soon, later], now: now))
        XCTAssertEqual(advice.drainFirst.accountId, "soon")
        XCTAssertEqual(advice.availableFrom, now.addingTimeInterval(2 * hour))
        XCTAssertEqual(advice.useNow?.accountId, "later")
    }

    func testAccountsWithoutRoomOrNotReadyAreLeftOut() {
        let full = account("full", weeklyUsed: 97, weeklyResetsIn: day)
        let cooling = account("cooling", weeklyUsed: 10, weeklyResetsIn: 2 * day, health: .cooling(until: nil))
        let only = account("only", weeklyUsed: 10, weeklyResetsIn: 5 * day)
        XCTAssertNil(DrainAdvisor.advice(for: [full, cooling, only], now: now), "one candidate leaves nothing to choose")
    }
}

final class MenuBarGaugeTests: XCTestCase {
    private func account(_ kind: ProviderKind, _ id: String, active: Bool = false, preferred: Bool = false,
                         weeklyUsed: Double?, fiveHourUsed: Double = 0, stale: Bool = false) -> AccountUsage {
        AccountUsage(kind: kind, provider: kind.rawValue, accountId: id, label: id, isActive: active, isPreferred: preferred,
                     fiveHour: UsageWindowState(usedPercent: fiveHourUsed, windowMinutes: Quota.fiveHourMinutes, resetsAt: now),
                     weekly: weeklyUsed.map { UsageWindowState(usedPercent: $0, windowMinutes: Quota.weeklyMinutes, resetsAt: now.addingTimeInterval(day)) },
                     isStale: stale)
    }

    func testUnknownAndDown() {
        XCTAssertEqual(MenuBarGauge.make(accounts: [], online: nil), MenuBarGauge(mood: .idle, fill: 1))
        XCTAssertEqual(MenuBarGauge.make(accounts: [account(.claude, "a", weeklyUsed: 10)], online: false), MenuBarGauge(mood: .down, fill: 0))
        XCTAssertEqual(MenuBarGauge.make(accounts: [account(.claude, "a", weeklyUsed: nil)], online: true).mood, .idle)
    }

    // WHY: the ring shows the weekly room left on the tightest account actually serving, not on
    // a spare one; and in 5% steps, so a drifting percent does not redraw the status item.
    func testRingFollowsTightestServingAccount() {
        let accounts = [
            account(.claude, "spare", weeklyUsed: 95),
            account(.claude, "serving", active: true, weeklyUsed: 37),
            account(.chatgpt, "pro", preferred: true, weeklyUsed: 52),
        ]
        XCTAssertEqual(MenuBarGauge.make(accounts: accounts, online: true), MenuBarGauge(mood: .ok, fill: 0.5))
        var drifted = accounts
        drifted[2] = account(.chatgpt, "pro", preferred: true, weeklyUsed: 51)
        XCTAssertEqual(MenuBarGauge.make(accounts: drifted, online: true), MenuBarGauge.make(accounts: accounts, online: true))
    }

    func testBlockedAndStale() {
        let blocked = MenuBarGauge.make(accounts: [account(.claude, "a", active: true, weeklyUsed: 20, fiveHourUsed: 100, stale: true)], online: true)
        XCTAssertEqual(blocked.mood, .blocked)
        XCTAssertTrue(blocked.isStale)
        XCTAssertEqual(blocked.fill, 0.8, accuracy: 0.0001)
    }
}

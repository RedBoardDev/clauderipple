import XCTest
@testable import RippleKit

/// Pinned instant for the made-up fixtures (2027-01-15 08:00 UTC).
private let now = Date(timeIntervalSince1970: 1_800_000_000)

final class ClaudeAccountRowsTests: XCTestCase {
    private func response(_ text: String) throws -> ClaudeAccountsResponse {
        try JSONDecoder().decode(ClaudeAccountsResponse.self, from: Data(text.utf8))
    }

    // WHY: rows follow the order the router tries accounts in, so "First" and "Use first" mean
    // what the router does: a stored preferred account leads, then the current login.
    func testPreferredStoredAccountLeadsThenCurrentLogin() throws {
        let rows = try JSONDecoder().decode(ClaudeAccountsResponse.self, from: fixture("accounts-claude")).rows(now: now)
        XCTAssertEqual(rows.map(\.id), ["0b5c6a1e-0000-4000-8000-000000000001", "current", "0b5c6a1e-0000-4000-8000-000000000002"])
        XCTAssertEqual(rows.map(\.isFirst), [true, false, false])
        XCTAssertTrue(rows[1].isCurrentLogin)
        XCTAssertFalse(rows[1].isStored)
        XCTAssertEqual(rows[0].email, "spare@example.com")
        XCTAssertNil(rows[2].email, "an email equal to the label is not repeated")
        XCTAssertTrue(rows[2].needsSignIn, "an expired grant needs a new sign-in")
        XCTAssertFalse(rows[0].needsSignIn)
    }

    func testWithoutPreferenceTheCurrentLoginLeads() throws {
        let data = try response(#"{"current":{"id":"current","label":"Current Claude login"},"accounts":[{"id":"a","label":"A","expiresAt":1900000000000,"needsReauth":false,"preferred":false}]}"#)
        XCTAssertEqual(data.rows(now: now).map(\.id), ["current", "a"])
        XCTAssertEqual(data.rows(now: now).map(\.isFirst), [true, false])
        XCTAssertTrue(data.hasChoice)
    }

    func testWithoutCurrentLoginTheFirstStoredAccountLeads() throws {
        let data = try response(#"{"current":null,"accounts":[{"id":"a","label":"A","needsReauth":true,"preferred":false},{"id":"b","label":"B","preferred":false}]}"#)
        let rows = data.rows(now: now)
        XCTAssertEqual(rows.map(\.isFirst), [true, false])
        XCTAssertTrue(rows[0].needsSignIn)
        XCTAssertFalse(rows[1].needsSignIn, "no expiry known is not an expiry")
    }

    func testOneAccountOffersNoChoice() throws {
        XCTAssertFalse(try response(#"{"current":{"id":"current","label":"Current Claude login"},"accounts":[]}"#).hasChoice)
    }
}

final class AccountProvidersTests: XCTestCase {
    // WHY: only Claude-login providers have accounts (an API-key Claude provider has none), and
    // Google API-key providers are not Antigravity logins.
    func testProvidersWithAccountsAreFoundInConfigOrder() throws {
        let providers = AccountProviders(config: try JSONValue(data: fixture("accounts-config")))
        XCTAssertEqual(providers.claude, ["claude"])
        XCTAssertEqual(providers.claudeRotating, [])
        XCTAssertEqual(providers.chatgpt, ["chatgpt-subscription"])
        XCTAssertEqual(providers.google, ["gemini"])
    }

    // WHY: the rotation switch writes the whole config back; it must change one key and nothing
    // else (provider order is routing order), and "off" removes the key as the dashboard does.
    func testRotationTogglesOneKeyAndKeepsTheRest() throws {
        let original = try JSONValue(data: fixture("accounts-config"))
        var config = original
        try AccountProviders.setRotation(true, provider: "claude", in: &config)
        XCTAssertEqual(config["providers"]?.keys, original["providers"]?.keys)
        XCTAssertEqual(config.value(at: ["providers", "claude", "accountPool"]), .bool(true))
        XCTAssertEqual(AccountProviders(config: config).claudeRotating, ["claude"])
        XCTAssertEqual(config.value(at: ["providers", "claude-api", "apiKey"]), original.value(at: ["providers", "claude-api", "apiKey"]))

        try AccountProviders.setRotation(false, provider: "claude", in: &config)
        XCTAssertEqual(config.serialized(), original.serialized())
    }

    func testRotationOnAProviderRemovedMeanwhileFails() throws {
        var config = try JSONValue(data: fixture("accounts-config"))
        XCTAssertThrowsError(try AccountProviders.setRotation(true, provider: "gone", in: &config))
        XCTAssertNil(config.value(at: ["providers", "gone"]), "a failed toggle must not create the provider")
    }
}

final class AccountFormattingTests: XCTestCase {
    private func quota(_ text: String) throws -> Quota {
        try JSONDecoder().decode(Quota.self, from: Data(text.utf8))
    }

    func testQuotaLine() throws {
        let both = try quota(#"{"rate_limits":{"primary":{"used_percent":14.4,"window_minutes":300},"secondary":{"used_percent":10,"window_minutes":10080}}}"#)
        XCTAssertEqual(Format.quotaLine(both, now: now), "5h 14% · Week 10%")
        let weeklyOnly = try quota(#"{"rate_limits":{"primary":{"used_percent":88,"window_minutes":10080},"secondary":null}}"#)
        XCTAssertEqual(Format.quotaLine(weeklyOnly, now: now), "Week 88%")
        XCTAssertNil(Format.quotaLine(nil, now: now))
        XCTAssertNil(Format.quotaLine(try quota(#"{"rate_limits":null}"#), now: now))
    }

    // WHY: the reset only matters once a window is spent; then it is the one thing worth reading.
    func testSpentWindowSaysWhenItReopens() throws {
        let spent = try quota(#"{"rate_limits":{"primary":{"used_percent":100,"window_minutes":300,"reset_at":1800005400},"secondary":{"used_percent":40,"window_minutes":10080}}}"#)
        XCTAssertEqual(Format.quotaLine(spent, now: now), "5h 100%, reopens in 1h 30m · Week 40%")
    }
}

final class AccountRoutesTests: XCTestCase {
    func testChatGptStatesDecodeAndUnknownOnesAreKept() throws {
        let status = try RouterStatus(document: JSONValue(data: fixture("accounts-status")))
        let accounts = try XCTUnwrap(status.chatgptAccounts.first?.accounts)
        XCTAssertEqual(accounts.map(\.state), [.ready, .cooling, .unknown])
        XCTAssertTrue(accounts[1].isBorrowed)
        XCTAssertFalse(accounts[0].isBorrowed)
        XCTAssertFalse(accounts[0].needsSignIn)
        XCTAssertEqual(accounts[1].cooldownSeconds, 600)
    }

    func testRemoveAllClaudeAccountsRunsTheLogoutRoute() async throws {
        let client = MockRouter.client { _ in .json(#"{"ok":true,"output":"Removed 2 accounts."}"#) }
        let result = try await client.removeAllClaudeAccounts()
        XCTAssertTrue(result.ok)
        let sent = try XCTUnwrap(MockRouter.requests().first)
        XCTAssertEqual(sent.method, "POST")
        XCTAssertEqual(sent.path, "/api/claude-logout")
    }

    // WHY: a failed CLI run answers 500 with its output; the user should read that, not "HTTP 500".
    func testFailedLogoutKeepsTheCLIOutput() async {
        let client = MockRouter.client { _ in .json(#"{"ok":false,"output":"keychain locked"}"#, status: 500) }
        do {
            _ = try await client.removeAllClaudeAccounts()
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? AdminError, .http(status: 500, message: "keychain locked"))
        }
    }

    func testChatGptPatchSendsOnlyTheGivenMembers() async throws {
        let client = MockRouter.client { _ in .json(#"{"ok":true}"#) }
        try await client.updateChatGptAccount("own-1", clearCooldown: true)
        let sent = try XCTUnwrap(MockRouter.requests().first)
        XCTAssertEqual(sent.method, "PATCH")
        XCTAssertEqual(sent.json?.serialized(), #"{"clearCooldown":true}"#)
    }
}

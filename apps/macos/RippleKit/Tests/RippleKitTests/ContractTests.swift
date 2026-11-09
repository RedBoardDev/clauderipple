import XCTest

@testable import RippleKit

/// WHY: these are recorded by the real router, not examples maintained alongside our models.
final class ContractTests: XCTestCase {
    private func decode<T: Decodable>(_ name: String, as type: T.Type = T.self) throws -> T {
        try JSONDecoder().decode(type, from: fixture("contract/\(name)"))
    }
    private func document(_ name: String) throws -> JSONValue { try JSONValue(data: fixture("contract/\(name)")) }

    func testEveryRecordedFixtureHasAnExplicitContractTest() throws {
        let directory = try XCTUnwrap(Bundle.module.url(forResource: "contract", withExtension: nil, subdirectory: "Fixtures"))
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).sorted()
        XCTAssertEqual(
            names,
            [
                "claude-accounts", "claude-models", "claude-oauth", "chatgpt-accounts", "chatgpt-login", "codex", "config",
                "context-windows", "effort-levels", "limits", "meta", "mod-options", "mod-settings", "mod-settings-put", "power",
                "power-setup", "requests", "status", "summary-range", "summary-ring", "update",
            ].map { "\($0).json" }.sorted())
    }

    func testVersionHandshakeAndBuiltSchemaMatchRecordedRouter() throws {
        let meta: AdminContractMetadata = try decode("meta")
        XCTAssertFalse(meta.routerVersion.isEmpty)
        XCTAssertEqual(meta.modSettingsSchemaVersion, ModSettingsEditor.schemaVersion)
        XCTAssertEqual(meta.routerVersion, AdminContractMetadata.tested.routerVersion)
        XCTAssertEqual(meta.modSettingsSchemaVersion, AdminContractMetadata.tested.modSettingsSchemaVersion)
    }

    func testClaudeAccountsContract() throws {
        let response: ClaudeAccountsResponse = try decode("claude-accounts")
        let current = try XCTUnwrap(response.current)
        XCTAssertEqual(current.id, "current")
        XCTAssertEqual(current.label, "Current Claude login")
        XCTAssertEqual(current.source, "observed")
        XCTAssertFalse(current.paused)
        XCTAssertEqual(current.quota?.fiveHour?.usedPercent, 24)
        let account = try XCTUnwrap(response.accounts.first)
        XCTAssertEqual(response.accounts.count, 1)
        XCTAssertEqual(account.label, "claude@example.test")
        XCTAssertEqual(account.email, "claude@example.test")
        XCTAssertEqual(account.expiresAt, 1_800_003_600_000)
        XCTAssertFalse(account.needsReauth)
        XCTAssertFalse(account.preferred)
        XCTAssertFalse(account.paused)
        XCTAssertEqual(account.quota?.weekly?.usedPercent, 42)
        XCTAssertEqual(account.quota?.weekly?.resetAt, 1_800_086_400)
    }

    func testChatGptAccountsContract() throws {
        let response: ChatGptAccountsResponse = try decode("chatgpt-accounts")
        XCTAssertEqual(response.provider, "chatgpt")
        let account = try XCTUnwrap(response.accounts.first)
        XCTAssertEqual(response.accounts.count, 1)
        XCTAssertEqual(account.label, "gpt@example.test")
        XCTAssertEqual(account.email, "gpt@example.test")
        XCTAssertEqual(account.planType, "contract-plan")
        XCTAssertEqual(account.expiresAt, 1_800_003_600_000)
        XCTAssertFalse(account.needsReauth)
        XCTAssertFalse(account.paused)
        XCTAssertEqual(account.source, "own")
        XCTAssertEqual(account.state, .cooling)
        XCTAssertEqual(account.cooldownSeconds, 60)
        XCTAssertTrue(account.active)
        XCTAssertEqual(account.quota?.weekly?.usedPercent, 42)
    }

    func testStatusAndClientCapabilitiesContract() throws {
        let doc = try document("status")
        let status = try RouterStatus(document: doc)
        XCTAssertEqual(status.version, AdminContractMetadata.tested.routerVersion)
        XCTAssertEqual(status.readiness?.ready, false)
        XCTAssertEqual(status.readiness?.problems, ["settings", "provider:claude", "provider:chatgpt"])
        XCTAssertEqual(status.stats?.inFlight, 1)
        XCTAssertEqual(status.stats?.messagesInFlight, 1)
        XCTAssertEqual(status.stats?.started, 3)
        XCTAssertEqual(status.stats?.completed, 2)
        XCTAssertEqual(status.stats?.failed, 0)
        XCTAssertEqual(status.consecutiveUpstreamFailures, 0)
        XCTAssertEqual(status.routes, 1)
        XCTAssertEqual(status.adminPort, 18792)
        XCTAssertNotNil(status.startedAt)
        XCTAssertEqual(status.settings?.pointsAtRouter, false)
        XCTAssertEqual(status.statusMod, false)
        XCTAssertEqual(status.picker?.enabled, false)
        XCTAssertEqual(status.providers.map(\.name), ["chatgpt", "claude"])
        XCTAssertEqual(status.providers.map(\.reachable), [false, false])
        XCTAssertEqual(status.providers.map(\.usable), [false, false])
        XCTAssertEqual(status.claudeProvider?.authSource, "observed")
        XCTAssertEqual(status.credentials["claude"]?.count, 2)
        XCTAssertEqual(status.credentials["claude"]?.first?.state, "ready")
        XCTAssertEqual(status.credentials["claude"]?.first?.failures, 0)
        XCTAssertEqual(status.chatgptAccounts.first?.accounts.first?.quota?.fiveHour?.usedPercent, 24)
        let capabilities = ClientCapabilities(document: doc)
        XCTAssertEqual(capabilities.pickerModels, ["Contract GPT"])
        XCTAssertTrue(capabilities.canSearch(provider: "chatgpt", model: "gpt-6-1-sol"))
    }

    func testLimitsContractExplicitlyUsesAnonymousFallback() throws {
        let limits: LimitsResponse = try decode("limits")
        XCTAssertEqual(limits.providers.count, 2)
        let provider = try XCTUnwrap(limits.providers.first)
        XCTAssertEqual(provider.provider, "claude")
        XCTAssertEqual(provider.type, "anthropic")
        XCTAssertEqual(provider.title, "Claude")
        XCTAssertEqual(provider.accounts.count, 2)
        let account = try XCTUnwrap(provider.accounts.first)
        XCTAssertEqual(account.account, 0)
        XCTAssertEqual(account.at, 1_800_000_000_000)
        XCTAssertEqual(account.windows.map(\.usedPercent), [24, 42])
        XCTAssertEqual(account.windows.map(\.windowMinutes), [300, 10080])
        XCTAssertEqual(account.windows.last?.resetAt, 1_800_086_400)
        XCTAssertNil(UsageBuilder.fromLimits(limits, now: Date(timeIntervalSince1970: 1_800_000_000)))
    }

    func testConfigAndCatalogContracts() throws {
        let config = try document("config")
        try AdminConfiguration.validate(config)
        let routing = RoutingConfiguration(document: config)
        XCTAssertEqual(Set(routing.providers.map(\.id)), ["claude", "chatgpt"])
        XCTAssertEqual(routing.routes.first?.provider, "chatgpt")
        XCTAssertEqual(routing.routes.first?.model, "gpt-6-1-sol")
        XCTAssertEqual(routing.routes.first?.effort, "medium")
        XCTAssertEqual(AccountProviders(config: config).claudeRotating, ["claude"])
        let models: ClaudeModelsResponse = try decode("claude-models")
        XCTAssertFalse(models.models.isEmpty)
        XCTAssertEqual(models.models.first?.id, "claude-haiku-5-5")
        XCTAssertEqual(models.source, "fallback")
        let efforts: EffortLevelsResponse = try decode("effort-levels")
        XCTAssertFalse(try XCTUnwrap(efforts.providers["chatgpt"]).default.isEmpty)
        let windows: ContextWindowsResponse = try decode("context-windows")
        XCTAssertEqual(windows.windows["gpt-6-1-sol"], 475000)
        let codex: CodexIntegration = try decode("codex")
        XCTAssertFalse(codex.enabled)
        XCTAssertEqual(codex.configPath, "/contract/home/codex/config.toml")
    }

    func testModSettingsBodyIsExactlyTheBodyVerifiedByNode() throws {
        let snapshot = try ModSettingsSnapshot(document: document("mod-settings"))
        let body = try ModSettingsEditor(snapshot: snapshot).putBody()
        let expected = try document("mod-settings-put")
        // JSONValue preserves key order; compare JSON semantics because the recorder sorts keys.
        XCTAssertEqual(
            try JSONSerialization.jsonObject(with: body.data()) as? NSDictionary,
            try JSONSerialization.jsonObject(with: expected.data()) as? NSDictionary)
        let review = try XCTUnwrap(snapshot.settings.value(at: ["domainRules", "review"]))
        let ladder = try review.decode(ModDomainLadder.self)
        XCTAssertEqual(ladder.mode, "ladder")
        XCTAssertEqual(ladder.rungs["hard"]?.first?.target.model, "opus")
        XCTAssertEqual(ladder.rungs["light"]?.first?.effort, "medium")
        let options: ModOptions = try decode("mod-options")
        XCTAssertEqual(options.providers.count, 2)
        XCTAssertTrue(options.models.contains { $0.model == "gpt-6-1-sol" })
        XCTAssertEqual(options.agents.count, 2)
        XCTAssertFalse(options.workerChoices.isEmpty)
        XCTAssertFalse(options.claudeEfforts?.isEmpty ?? true)
    }

    func testPowerAndJobsContract() throws {
        let power: PowerStatus = try decode("power")
        XCTAssertEqual(power.platform, "darwin")
        XCTAssertEqual(power.awake.mode, .working)
        XCTAssertTrue(power.awake.applied)
        XCTAssertEqual(power.awake.setup, "ok")
        XCTAssertEqual(power.awake.reason, "contract model call")
        XCTAssertEqual(power.awake.battery?.percent, 82)
        XCTAssertEqual(power.awake.battery?.onBattery, false)
        XCTAssertEqual(power.awake.thermal, "normal")
        XCTAssertEqual(power.awake.lidClosed, true)
        XCTAssertNil(power.awake.until)
        XCTAssertTrue(power.tether.enabled)
        XCTAssertFalse(power.tether.pinned)
        XCTAssertEqual(power.tether.state, "watching")
        XCTAssertEqual(power.tether.network, "wifi")
        XCTAssertEqual(power.tether.hotspotSsid, "Contract hotspot")
        XCTAssertEqual(power.tether.lastSwitch?.ok, true)
        XCTAssertEqual(power.tether.lastProbe?.ok, true)
        let setup: JobState = try decode("power-setup")
        XCTAssertFalse(setup.running)
        let oauth: ClaudeOAuthState = try decode("claude-oauth")
        XCTAssertFalse(oauth.running)
        XCTAssertNil(oauth.url)
        XCTAssertEqual(oauth.manual, false)
        let login: ChatGptLoginState = try decode("chatgpt-login")
        XCTAssertEqual(login.running, false)
        XCTAssertEqual(login.signedIn, true)
        XCTAssertEqual(login.accountCount, 1)
        let update: UpdateCheck = try decode("update")
        XCTAssertEqual(update.current, AdminContractMetadata.tested.routerVersion)
        XCTAssertEqual(update.latest, "99.0.0")
        XCTAssertTrue(update.newer)
        XCTAssertTrue(update.canUpdate)
        XCTAssertEqual(update.kind, "npm")
        XCTAssertEqual(update.running, false)
    }

    func testActivityContract() throws {
        for name in ["summary-range", "summary-ring"] {
            let summary: RequestSummary = try decode(name)
            XCTAssertEqual(summary.total.count, 1)
            XCTAssertEqual(summary.total.ok, 1)
            XCTAssertEqual(summary.total.failed, 0)
            XCTAssertEqual(summary.total.input, 100)
            XCTAssertEqual(summary.total.cached, 900)
            XCTAssertEqual(summary.total.cacheWrite, 50)
            XCTAssertEqual(summary.total.output, 75)
            XCTAssertEqual(summary.total.cacheHitPercent, 85.7)
            XCTAssertEqual(summary.total.avgMs, 1250)
            XCTAssertEqual(summary.models.first?.model, "gpt-6-1-sol")
            XCTAssertEqual(summary.providers["chatgpt"]?.count, 1)
            XCTAssertEqual(summary.isRange, name == "summary-range")
        }
        let requests: RecentRequests = try decode("requests")
        let record = try XCTUnwrap(requests.requests.first)
        XCTAssertEqual(record.id, "contract-request")
        XCTAssertNotNil(record.date)
        XCTAssertEqual(record.status, .number(200))
        XCTAssertEqual(record.ms, 1250)
        XCTAssertEqual(record.ok, true)
        XCTAssertEqual(record.provider, "chatgpt")
        XCTAssertEqual(record.target, "gpt-6-1-sol")
        XCTAssertEqual(record.usage?.cached, 900)
        XCTAssertEqual(record.stream, true)
    }

    func testUnknownFieldsAreHarmlessButMissingAndMistypedRequiredFieldsAreIncompatible() async throws {
        var doc = try document("claude-accounts")
        doc["future"] = .bool(true)
        let additive = doc.serialized()
        _ = try await MockRouter.client { _ in .json(additive) }.claudeAccounts()
        for value in [Optional<JSONValue>.none, .string("false")] {
            var broken = doc
            broken.set(value, at: ["current", "paused"])
            let text = broken.serialized()
            do {
                _ = try await MockRouter.client { _ in .json(text) }.claudeAccounts()
                XCTFail("Expected incompatible current.paused")
            } catch {
                XCTAssertEqual(error as? AdminError, .incompatible(route: "/api/claude-accounts", codingPath: "current.paused"))
            }
        }
    }

    func testStatusNeverDropsAnIncompatibleProvider() throws {
        var status = try document("status")
        status.set(.string("yes"), at: ["providers", "claude", "usable"])
        XCTAssertThrowsError(try RouterStatus(document: status)) { error in
            XCTAssertEqual(error as? AdminError, .incompatible(route: "/api/status", codingPath: "providers.claude.usable"))
        }
    }

    func testMalformedOptionalQuotaIsNotSwallowed() async throws {
        var doc = try document("claude-accounts")
        doc.set(.string("twenty-four"), at: ["current", "quota", "rate_limits", "primary", "used_percent"])
        let text = doc.serialized()
        do {
            _ = try await MockRouter.client { _ in .json(text) }.claudeAccounts()
            XCTFail("Expected incompatible quota")
        } catch {
            XCTAssertEqual(
                error as? AdminError,
                .incompatible(route: "/api/claude-accounts", codingPath: "current.quota.rate_limits.primary.used_percent"))
        }
    }

    func testConfigDecodeFailureNeverSendsPUT() async throws {
        var doc = try document("config")
        doc["providers"] = nil
        let text = doc.serialized()
        let client = MockRouter.client { _ in .json(text) }
        do {
            _ = try await client.updateConfig { $0["autoUpdate"] = .bool(true) }
            XCTFail("Expected incompatible config")
        } catch {
            XCTAssertEqual(error as? AdminError, .incompatible(route: "/api/config", codingPath: "providers"))
        }
        XCTAssertEqual(MockRouter.requests().map(\.method), ["GET"])
    }

    @MainActor
    func testPowerDecodeFailureBlocksPanelWrites() async throws {
        let status = try fixtureText("contract/status")
        let accounts = try fixtureText("contract/claude-accounts")
        let limits = try fixtureText("contract/limits")
        let summary = try fixtureText("contract/summary-range")
        var doc = try document("power")
        doc.set(nil, at: ["awake", "applied"])
        let broken = doc.serialized()
        let client = MockRouter.client { request in
            .json(
                [
                    "/api/status": status, "/api/limits": limits, "/api/claude-accounts": accounts,
                    "/api/power": broken, "/api/requests/summary": summary,
                ][request.path] ?? "{}")
        }
        let store = RouterStore(client: client)
        await store.refresh()
        XCTAssertNil(store.power)
        do {
            try await store.setAwake(.on)
            XCTFail("Expected incompatible power")
        } catch {
            XCTAssertEqual(error as? AdminError, .incompatible(route: "/api/power", codingPath: "awake.applied"))
        }
        XCTAssertTrue(MockRouter.requests().allSatisfy { $0.method == "GET" })
    }

    @MainActor
    func testPollingSurfacesNestedDecodeFailuresAndRecoversOnlyAfterGoodRead() async throws {
        let status = try fixtureText("contract/status")
        var claude = try document("claude-accounts")
        claude.set(nil, at: ["current", "paused"])
        let broken = claude.serialized()
        let limits = try fixtureText("contract/limits")
        let summary = try fixtureText("contract/summary-range")
        let power = try fixtureText("contract/power")
        let client = MockRouter.client { request in
            .json(
                [
                    "/api/status": status, "/api/limits": limits, "/api/claude-accounts": broken, "/api/power": power,
                    "/api/requests/summary": summary,
                ][request.path] ?? "{}")
        }
        let store = RouterStore(client: client)
        await store.refresh()
        XCTAssertEqual(store.lastError, .incompatible(route: "/api/claude-accounts", codingPath: "current.paused"))
        XCTAssertTrue(store.accounts.isEmpty)
        XCTAssertTrue(
            store.lastError?.userMessage.contains("Router API changed: /api/claude-accounts current.paused. Update the app.") == true)
        await store.refresh()
        XCTAssertTrue(store.lastError?.isIncompatible == true, "A successful status read must not erase another route's error")
        XCTAssertNil(store.untestedRouterVersion)
        let good = try fixtureText("contract/claude-accounts")
        // Replace the stand-in's answers; the store keeps its original URLSession.
        _ = MockRouter.client { request in
            .json(
                [
                    "/api/status": status, "/api/limits": limits, "/api/claude-accounts": good, "/api/power": power,
                    "/api/requests/summary": summary,
                ][request.path] ?? "{}")
        }
        await store.refresh()
        XCTAssertNil(store.lastError)
        XCTAssertFalse(store.accounts.isEmpty)
        let other = RouterStore(preview: [], status: DemoData.status())
        XCTAssertEqual(other.untestedRouterVersion, "0.11.1")
    }
}

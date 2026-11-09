import Foundation

public extension AdminClient {
    /// The admin endpoint can spend 30 seconds running the CLI's registry lookup.
    static var updateTimeout: TimeInterval { 40 }
    /// Match the tray's short diagnostic log tail.
    static var recoveryLogLines: Int { 40 }
    /// Power is live machine state, not a slowly changing account quota.
    static var powerPollInterval: Duration { .seconds(5) }
    /// Setup waits for the OS password dialog; poll without keeping a request open.
    static var setupPollInterval: Duration { .milliseconds(1500) }

    func recentRouterLogs() async throws -> String {
        try await getText("/api/logs", query: [URLQueryItem(name: "n", value: String(Self.recoveryLogLines))])
    }

    func checkForUpdates() async throws -> UpdateCheck {
        // `send` accepts GET and exposes the longer timeout without changing the shared client.
        try await send("GET", "/api/update", timeout: Self.updateTimeout)
    }

    func startUpdate() async throws -> UpdateCheck {
        try await send("POST", "/api/update", timeout: Self.updateTimeout)
    }

    func setTetherEnabled(_ enabled: Bool) async throws -> PowerStatus {
        try await send("PUT", "/api/power", json: .object([("tether", .object([("enabled", .bool(enabled))]))]))
    }

    func powerSetup() async throws -> JobState { try await get("/api/power/setup") }

    func startPowerSetup(ssid: String? = nil) async throws {
        let body = JSONValue.object(ssid.map { [("ssid", JSONValue.string($0))] } ?? [])
        try await send("POST", "/api/power/setup", json: body)
    }

    /// Returns after the first terminal job state (success, cancellation or failure). Cancellation
    /// propagates through the sleep so a hidden pane cannot keep a polling loop alive.
    func pollPowerSetup(interval: Duration = AdminClient.setupPollInterval,
                        onChange: @Sendable (JobState) async -> Void) async throws -> JobState {
        while true {
            try Task.checkCancellation()
            let job = try await powerSetup()
            await onChange(job)
            if !job.shouldPoll { return job }
            try await Task.sleep(for: interval)
        }
    }
}

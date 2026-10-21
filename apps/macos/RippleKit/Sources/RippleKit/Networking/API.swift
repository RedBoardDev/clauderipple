import Foundation

/// Typed admin routes shared by the popover and the Accounts pane. Each settings pane keeps its own
/// routes in its own `API+<Pane>.swift` extension.
public extension AdminClient {
    // MARK: Status and limits

    func status(refresh: Bool = false) async throws -> RouterStatus {
        let doc = try await getDocument("/api/status", query: refresh ? [URLQueryItem(name: "refresh", value: "1")] : [])
        return try RouterStatus(document: doc)
    }

    func limits(refresh: Bool = false) async throws -> LimitsResponse {
        try await get("/api/limits", query: refresh ? [URLQueryItem(name: "refresh", value: "1")] : [])
    }

    // MARK: Claude accounts

    func claudeAccounts() async throws -> ClaudeAccountsResponse {
        try await get("/api/claude-accounts")
    }

    /// Account used first by new conversations; nil returns to the current login.
    func setPreferredClaudeAccount(_ id: String?) async throws {
        try await send("PUT", "/api/claude-accounts", json: .object([("preferred", id.map(JSONValue.string) ?? .null)]))
    }

    func renameClaudeAccount(_ id: String, label: String) async throws {
        try await send("PATCH", "/api/claude-accounts/\(Self.pathSegment(id))", json: .object([("label", .string(label))]))
    }

    func removeClaudeAccount(_ id: String) async throws {
        try await send("DELETE", "/api/claude-accounts/\(Self.pathSegment(id))")
    }

    /// Starts the browser PKCE login; the router opens the browser itself.
    func startClaudeOAuth(manual: Bool = false) async throws -> ClaudeOAuthState {
        try await send("POST", "/api/claude-oauth", json: manual ? .object([("manual", .bool(true))]) : nil)
    }

    func claudeOAuthState() async throws -> ClaudeOAuthState {
        try await get("/api/claude-oauth")
    }

    func submitClaudeOAuthCode(_ code: String) async throws -> ClaudeOAuthState {
        try await send("POST", "/api/claude-oauth/code", json: .object([("code", .string(code))]))
    }

    func cancelClaudeOAuth() async throws {
        try await send("POST", "/api/claude-oauth/cancel")
    }

    // MARK: ChatGPT accounts

    func chatgptAccounts(provider: String? = nil) async throws -> ChatGptAccountsResponse {
        try await get("/api/chatgpt-accounts", query: provider.map { [URLQueryItem(name: "provider", value: $0)] } ?? [])
    }

    /// Rename, pause/resume, or clear a cooldown (only the members given are sent).
    func updateChatGptAccount(_ id: String, label: String? = nil, paused: Bool? = nil, clearCooldown: Bool = false) async throws {
        var body = JSONValue.object([])
        if let label { body["label"] = .string(label) }
        if let paused { body["paused"] = .bool(paused) }
        if clearCooldown { body["clearCooldown"] = .bool(true) }
        try await send("PATCH", "/api/chatgpt-accounts/\(Self.pathSegment(id))", json: body)
    }

    func removeChatGptAccount(_ id: String) async throws {
        try await send("DELETE", "/api/chatgpt-accounts/\(Self.pathSegment(id))")
    }

    func startChatGptLogin() async throws -> ChatGptLoginState {
        try await send("POST", "/api/chatgpt-login")
    }

    func chatgptLoginState() async throws -> ChatGptLoginState {
        try await get("/api/chatgpt-login")
    }

    // MARK: Activity and power (popover readouts)

    /// Today's totals: the durable range when the router has it, else its in-memory ring since midnight.
    func summarySinceMidnight(now: Date = Date(), calendar: Calendar = .current) async throws -> RequestSummary {
        let midnight = calendar.startOfDay(for: now)
        let fromMs = Int(midnight.timeIntervalSince1970 * 1000)
        let ranged: RequestSummary = try await get("/api/requests/summary", query: [URLQueryItem(name: "from", value: String(fromMs))])
        if ranged.isRange { return ranged }
        let since = max(1, Int(now.timeIntervalSince(midnight)))
        return try await get("/api/requests/summary", query: [URLQueryItem(name: "since", value: String(since))])
    }

    func power() async throws -> PowerStatus {
        try await get("/api/power")
    }

    func setAwakeMode(_ mode: AwakeStatus.Mode, until: Date? = nil) async throws -> PowerStatus {
        var awake = JSONValue.object([("mode", .string(mode.rawValue))])
        awake["until"] = until.map { .string($0.ISO8601Format()) } ?? .null
        return try await send("PUT", "/api/power", json: .object([("awake", awake)]))
    }

    // MARK: Config (whole-document read/modify/write)

    /// The full router config. It carries provider credentials: keep it in memory only, never log it.
    func config() async throws -> JSONValue {
        try await getDocument("/api/config")
    }

    /// Re-reads the config, applies `change` to the fresh copy and writes it back, so an edit made
    /// elsewhere meanwhile (the dashboard, a capability measurement) is not overwritten.
    /// Returns the router's warning, if any (CLI slot sync).
    @discardableResult
    func updateConfig(_ change: @Sendable (inout JSONValue) throws -> Void) async throws -> String? {
        var config = try await config()
        try change(&config)
        let answer = try await sendDocument("PUT", "/api/config", json: config)
        return answer["warning"]?.stringValue
    }

    static func pathSegment(_ id: String) -> String {
        id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? id
    }
}

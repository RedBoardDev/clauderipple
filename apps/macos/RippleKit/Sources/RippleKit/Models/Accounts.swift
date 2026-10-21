import Foundation

/// `GET /api/claude-accounts`.
public struct ClaudeAccountsResponse: Decodable, Sendable {
    public struct Current: Decodable, Sendable {
        public let id: String
        public let label: String
        public let source: String?
        public let quota: Quota?
    }

    public let current: Current?
    public let accounts: [ClaudeAccount]
}

public struct ClaudeAccount: Decodable, Sendable, Identifiable, Equatable {
    public let id: String
    public let label: String
    public let email: String?
    /// Epoch milliseconds.
    public let expiresAt: Double?
    public let needsReauth: Bool
    public let preferred: Bool
    public let quota: Quota?

    enum CodingKeys: String, CodingKey { case id, label, email, expiresAt, needsReauth, preferred, quota }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        email = try c.decodeIfPresent(String.self, forKey: .email)
        expiresAt = try c.decodeIfPresent(Double.self, forKey: .expiresAt)
        needsReauth = try c.decodeIfPresent(Bool.self, forKey: .needsReauth) ?? false
        preferred = try c.decodeIfPresent(Bool.self, forKey: .preferred) ?? false
        quota = try? c.decodeIfPresent(Quota.self, forKey: .quota)
    }
}

/// `GET /api/chatgpt-accounts` (one provider) and `status.chatgpt.accounts` (all providers).
public struct ChatGptAccountsResponse: Decodable, Sendable {
    public let provider: String?
    public let accounts: [ChatGptAccount]
}

public struct ChatGptAccount: Decodable, Sendable, Identifiable, Equatable {
    public enum State: String, Decodable, Sendable {
        case ready, cooling, quarantined, paused
        case needsLogin = "needs-login"
        case unknown

        public init(from decoder: Decoder) throws {
            self = State(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
        }
    }

    public let id: String
    public let label: String
    public let email: String?
    public let planType: String?
    public let expiresAt: Double?
    public let needsReauth: Bool
    public let paused: Bool
    /// "own" (router login) or "codex" (borrowed from Codex, which this app cannot rename or remove).
    public let source: String?
    /// Absent on a summary-only fallback list.
    public let state: State?
    public let cooldownSeconds: Double?
    public let quota: Quota?
    public let active: Bool

    enum CodingKeys: String, CodingKey {
        case id, label, email, planType, expiresAt, needsReauth, paused, source, state, cooldownSeconds, quota, active
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        email = try c.decodeIfPresent(String.self, forKey: .email)
        planType = try c.decodeIfPresent(String.self, forKey: .planType)
        expiresAt = try c.decodeIfPresent(Double.self, forKey: .expiresAt)
        needsReauth = try c.decodeIfPresent(Bool.self, forKey: .needsReauth) ?? false
        paused = try c.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        source = try c.decodeIfPresent(String.self, forKey: .source)
        state = try c.decodeIfPresent(State.self, forKey: .state)
        cooldownSeconds = try c.decodeIfPresent(Double.self, forKey: .cooldownSeconds)
        quota = try? c.decodeIfPresent(Quota.self, forKey: .quota)
        active = try c.decodeIfPresent(Bool.self, forKey: .active) ?? false
    }

    /// The Codex login is borrowed: the router can clear its cooldown but not rename, pause or remove it.
    public var isBorrowed: Bool { source == "codex" }
}

/// Claude OAuth attempt (`GET/POST /api/claude-oauth`).
public struct ClaudeOAuthState: Decodable, Sendable, Equatable {
    public let running: Bool
    public let url: String?
    public let manual: Bool?
    public let ok: Bool?
    public let error: String?
    public let opened: Bool?
}

/// ChatGPT CLI login job (`GET/POST /api/chatgpt-login`).
public struct ChatGptLoginState: Decodable, Sendable, Equatable {
    public let running: Bool?
    public let started: Bool?
    public let ok: Bool?
    public let output: String?
    public let signedIn: Bool?
    public let accountCount: Int?
}

// MARK: Accounts pane

/// One Claude account as the Accounts pane lists it.
public struct ClaudeAccountRow: Sendable, Equatable, Identifiable {
    /// "current" for the external Claude Code / Claude Desktop login.
    public let id: String
    public let label: String
    public let email: String?
    public let quota: Quota?
    public let isCurrentLogin: Bool
    /// New conversations start on this account.
    public let isFirst: Bool
    /// Refused or expired: the router skips it until it is signed in again.
    public let needsSignIn: Bool

    /// The external login belongs to Claude Code / Claude Desktop; the router cannot rename or remove it.
    public var isStored: Bool { !isCurrentLogin }
}

public extension ClaudeAccountsResponse {
    /// More than one account, so "Use first" means something.
    var hasChoice: Bool { (current == nil ? 0 : 1) + accounts.count > 1 }

    /// The accounts in the order the router tries them: the preferred stored account first, else the
    /// current login; then the current login; then the other stored accounts as stored.
    func rows(now: Date = Date()) -> [ClaudeAccountRow] {
        var stored = accounts
        let preferredIndex = stored.firstIndex { $0.preferred }
        if let preferredIndex, preferredIndex > 0 { stored.insert(stored.remove(at: preferredIndex), at: 0) }
        let leader = preferredIndex != nil ? stored.first?.id : (current != nil ? "current" : stored.first?.id)
        let nowMs = now.timeIntervalSince1970 * 1000
        var rows = stored.map { account in
            ClaudeAccountRow(id: account.id, label: account.label, email: account.email == account.label ? nil : account.email,
                             quota: account.quota, isCurrentLogin: false, isFirst: account.id == leader,
                             needsSignIn: account.needsReauth || account.expiresAt.map { $0 <= nowMs } == true)
        }
        if let current {
            let row = ClaudeAccountRow(id: current.id, label: current.label, email: nil, quota: current.quota,
                                       isCurrentLogin: true, isFirst: leader == current.id, needsSignIn: false)
            rows.insert(row, at: preferredIndex == nil ? 0 : min(1, rows.count))
        }
        return rows
    }
}

public extension ChatGptAccount {
    /// Expired or refused: signing in again with the same account restores it in place.
    var needsSignIn: Bool { state == .needsLogin || state == .quarantined }
}

/// Which configured providers carry subscription accounts, read from the router config.
public struct AccountProviders: Sendable, Equatable {
    /// Claude providers signed in with a Claude login (not an API key), in config order.
    public let claude: [String]
    /// The ones with account rotation (`accountPool`) on.
    public let claudeRotating: Set<String>
    public let chatgpt: [String]
    /// Google Antigravity logins; managed in the web dashboard.
    public let google: [String]

    public init(config: JSONValue) {
        let providers = config["providers"]?.objectValue ?? []
        func names(_ match: (JSONValue) -> Bool) -> [String] { providers.filter { match($0.value) }.map(\.key) }
        claude = names { $0["type"]?.stringValue == "anthropic" && $0["auth"]?.stringValue == "claude-code" }
        claudeRotating = Set(names { $0["type"]?.stringValue == "anthropic" && $0["accountPool"]?.boolValue == true })
        chatgpt = names { $0["type"]?.stringValue == "chatgpt" }
        google = names { $0["type"]?.stringValue == "google" && $0["auth"]?.stringValue == "antigravity" }
    }

    /// Turns account rotation on or off for one Claude provider. Off removes the key, as the
    /// dashboard does, so the config keeps its default shape.
    public static func setRotation(_ on: Bool, provider: String, in config: inout JSONValue) throws {
        guard config.value(at: ["providers", provider]) != nil else {
            throw AdminError.http(status: 404, message: "Provider \(provider) is no longer configured.")
        }
        config.set(on ? .bool(true) : nil, at: ["providers", provider, "accountPool"])
    }
}

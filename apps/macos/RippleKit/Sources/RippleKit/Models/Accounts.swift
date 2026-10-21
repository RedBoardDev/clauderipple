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

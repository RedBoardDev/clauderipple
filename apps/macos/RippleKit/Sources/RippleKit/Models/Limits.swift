import Foundation

/// `GET /api/limits`. Two generations share the envelope:
/// - legacy: anonymous accounts (`account` index + `windows` array, `reset_at` in epoch seconds);
/// - per-account (feature/limits-view): every Claude and ChatGPT account adds `id`, `label`,
///   `preferred`, `active`, `health`, `usageWindows` (epoch-ms `resetAt`), `stale`, `fetchedAt`
///   and `weeklyPace` (not shown by the app, so not decoded). All additive members are optional.
public struct LimitsResponse: Decodable, Sendable {
    public let providers: [LimitsProvider]
}

public struct LimitsProvider: Decodable, Sendable {
    public let provider: String
    public let type: String
    public let title: String?
    public let accounts: [LimitsAccount]
}

public struct LimitsAccount: Decodable, Sendable {
    public struct LegacyWindow: Decodable, Sendable, Equatable {
        public let kind: String
        public let label: String?
        public let usedPercent: Double
        public let windowMinutes: Int?
        /// Epoch seconds.
        public let resetAt: Double?

        enum CodingKeys: String, CodingKey {
            case kind, label
            case usedPercent = "used_percent"
            case windowMinutes = "window_minutes"
            case resetAt = "reset_at"
        }
    }

    public struct UsageWindow: Decodable, Sendable, Equatable {
        public let usedPercent: Double
        public let windowMinutes: Int
        /// Epoch milliseconds.
        public let resetAt: Double?
    }

    public struct UsageWindows: Decodable, Sendable, Equatable {
        public let fiveHour: UsageWindow?
        public let weekly: UsageWindow?
    }

    public struct Health: Decodable, Sendable, Equatable {
        public let state: String
        /// Epoch milliseconds.
        public let pausedUntil: Double?
    }

    public let account: Int
    public let windows: [LegacyWindow]
    /// Epoch milliseconds; 0 when unknown.
    public let at: Double
    public let id: String?
    public let label: String?
    public let preferred: Bool?
    public let active: Bool?
    public let health: Health?
    public let usageWindows: UsageWindows?
    public let unknown: Bool?
    public let stale: Bool?
    public let fetchedAt: Double?

    enum CodingKeys: String, CodingKey {
        case account, windows, at, id, label, preferred, active, health, usageWindows, unknown, stale, fetchedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        account = try c.decodeIfPresent(Int.self, forKey: .account) ?? 0
        windows = (try? c.decodeIfPresent([LegacyWindow].self, forKey: .windows)) ?? []
        at = try c.decodeIfPresent(Double.self, forKey: .at) ?? 0
        id = try c.decodeIfPresent(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label)
        preferred = try c.decodeIfPresent(Bool.self, forKey: .preferred)
        active = try c.decodeIfPresent(Bool.self, forKey: .active)
        health = try? c.decodeIfPresent(Health.self, forKey: .health)
        usageWindows = try? c.decodeIfPresent(UsageWindows.self, forKey: .usageWindows)
        unknown = try c.decodeIfPresent(Bool.self, forKey: .unknown)
        stale = try c.decodeIfPresent(Bool.self, forKey: .stale)
        fetchedAt = try c.decodeIfPresent(Double.self, forKey: .fetchedAt)
    }

    /// Whether this is a per-account entry (the newer contract) rather than an anonymous legacy row.
    public var isPerAccount: Bool { id != nil }
}

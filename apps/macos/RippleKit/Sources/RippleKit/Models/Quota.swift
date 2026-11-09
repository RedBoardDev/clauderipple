import Foundation

/// One rate-limit window as the router reports it inside an account's `quota`
/// (`claude.usage` and `codex.rate_limits` share this shape).
public struct QuotaWindow: Decodable, Sendable, Equatable {
    public let usedPercent: Double
    public let windowMinutes: Int?
    /// Epoch seconds, as the providers report it.
    public let resetAt: Double?
    public let resetAfterSeconds: Double?

    enum CodingKeys: String, CodingKey {
        case usedPercent = "used_percent"
        case windowMinutes = "window_minutes"
        case resetAt = "reset_at"
        case resetAfterSeconds = "reset_after_seconds"
    }

    public init(usedPercent: Double, windowMinutes: Int?, resetAt: Double?, resetAfterSeconds: Double? = nil) {
        self.usedPercent = usedPercent
        self.windowMinutes = windowMinutes
        self.resetAt = resetAt
        self.resetAfterSeconds = resetAfterSeconds
    }

    /// Reset time; a millisecond-looking value is accepted too (the router normalizes the same way).
    public func resetDate(observedAt: Date?) -> Date? {
        if let resetAt, resetAt > 0 {
            return Date(timeIntervalSince1970: resetAt > Self.millisecondThreshold ? resetAt / 1000 : resetAt)
        }
        if let resetAfterSeconds, let observedAt { return observedAt.addingTimeInterval(resetAfterSeconds) }
        return nil
    }

    /// Above this a timestamp is in milliseconds (1e12 ms is 2001; 1e12 s is year 33658).
    static let millisecondThreshold: Double = 1e12
}

public struct QuotaCredits: Decodable, Sendable, Equatable {
    public let hasCredits: Bool?
    public let unlimited: Bool?
    /// The router passes the provider's value through: a string or a number.
    public let balance: String?

    enum CodingKeys: String, CodingKey {
        case hasCredits = "has_credits"
        case unlimited
        case balance
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        hasCredits = try c.decodeIfPresent(Bool.self, forKey: .hasCredits)
        unlimited = try c.decodeIfPresent(Bool.self, forKey: .unlimited)
        if let s = try? c.decodeIfPresent(String.self, forKey: .balance) {
            balance = s
        } else if let n = try? c.decodeIfPresent(Double.self, forKey: .balance) {
            balance = n.rounded() == n ? String(Int(n)) : String(n)
        } else {
            balance = nil
        }
    }
}

/// The parts of an account's `quota` object this app reads. Unknown members are ignored, and
/// every member is optional: the source type is `Record<string, unknown>`.
public struct Quota: Decodable, Sendable, Equatable {
    public struct RateLimits: Decodable, Sendable, Equatable {
        public let primary: QuotaWindow?
        public let secondary: QuotaWindow?
    }

    public let type: String?
    public let planType: String?
    public let rateLimits: RateLimits?
    public let credits: QuotaCredits?
    /// When the router fetched it, epoch milliseconds.
    public let at: Double?
    public let stale: Bool?

    enum CodingKeys: String, CodingKey {
        case type
        case planType = "plan_type"
        case rateLimits = "rate_limits"
        case credits
        case at
        case stale
    }

    public var fetchedAt: Date? { at.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// Window lengths that name the two windows the app shows.
    public static let fiveHourMinutes = 300
    public static let weeklyMinutes = 10_080

    /// The 5-hour and weekly windows, told apart by length rather than by position: a ChatGPT plan
    /// with only a weekly limit reports it as `primary`.
    public var fiveHour: QuotaWindow? { window(minutes: Self.fiveHourMinutes, fallback: rateLimits?.primary) }
    public var weekly: QuotaWindow? { window(minutes: Self.weeklyMinutes, fallback: rateLimits?.secondary) }

    private func window(minutes: Int, fallback: QuotaWindow?) -> QuotaWindow? {
        let all = [rateLimits?.primary, rateLimits?.secondary].compactMap { $0 }
        if let match = all.first(where: { $0.windowMinutes == minutes }) { return match }
        // Without a length the position is the only clue (older payloads).
        if let fallback, fallback.windowMinutes == nil { return fallback }
        return nil
    }
}

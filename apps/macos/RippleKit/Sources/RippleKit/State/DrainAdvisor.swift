import Foundation

/// Which account of a provider should carry the load now, so that no weekly allowance resets unused.
///
/// This is the read-only half of a later "smart switch": today the popover only suggests, and the
/// user applies it with one click (Claude: preferred account). The rule, in order:
/// 1. only ready accounts with a known weekly window and real room left take part;
/// 2. the one whose week resets first should be drained first, since what it has left is lost at reset;
/// 3. if that account's 5-hour window is spent, the next one carries the load until it reopens.
public struct DrainAdvice: Sendable, Equatable {
    /// The account whose week should be used up first.
    public let drainFirst: AccountUsage
    /// Weekly share that expires unused at its reset unless it is used.
    public let expiringPercent: Double
    /// Set when `drainFirst` is blocked by its 5-hour window: when it reopens.
    public let availableFrom: Date?
    /// Who should carry the load until then (nil when no other account can).
    public let meanwhile: AccountUsage?

    /// The account the router should route new conversations to right now.
    public var useNow: AccountUsage? { availableFrom == nil ? drainFirst : meanwhile }
}

public enum DrainAdvisor {
    /// Below this much weekly room an account is not worth steering toward.
    public static let minimumRoomPercent: Double = 5

    public static func advice(for accounts: [AccountUsage], now: Date) -> DrainAdvice? {
        let candidates = accounts
            .filter { $0.health.isUsable && ($0.weekly?.leftPercent ?? 0) >= minimumRoomPercent && $0.weekly?.resetsAt != nil }
            .sorted { lhs, rhs in
                let l = lhs.weekly!.resetsAt!, r = rhs.weekly!.resetsAt!
                return l != r ? l < r : lhs.weekly!.leftPercent > rhs.weekly!.leftPercent
            }
        // With a single account there is nothing to choose.
        guard candidates.count > 1, let first = candidates.first else { return nil }
        let blockedUntil: Date? = first.fiveHour.flatMap { $0.isExhausted ? ($0.resetsAt ?? now) : nil }
        let meanwhile = blockedUntil == nil ? nil : candidates.dropFirst().first { $0.fiveHour?.isExhausted != true }
        return DrainAdvice(drainFirst: first, expiringPercent: first.weekly!.leftPercent,
                           availableFrom: blockedUntil, meanwhile: meanwhile)
    }

    /// Whether the advice says something the router is not already doing (worth showing).
    public static func differsFromRouting(_ advice: DrainAdvice, accounts: [AccountUsage]) -> Bool {
        guard let target = advice.useNow else { return advice.availableFrom != nil }
        let serving = accounts.first { $0.kind == target.kind && $0.isActive }
            ?? accounts.first { $0.kind == target.kind && $0.isPreferred }
        return serving?.id != target.id
    }
}

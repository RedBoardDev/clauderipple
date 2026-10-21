import Foundation

/// Exactly what the menu-bar icon renders, and nothing more, so it re-renders only when the picture
/// changes (a percent drifting inside the same step does not redraw the status item).
public struct MenuBarGauge: Sendable, Equatable {
    public enum Mood: Sendable, Equatable {
        /// Router answering, the serving accounts have room.
        case ok
        /// A serving account is blocked (5-hour or weekly window spent).
        case blocked
        /// Router not answering.
        case down
        /// Nothing known yet (first poll, or no account reports limits).
        case idle
    }

    public let mood: Mood
    /// Share of the ring drawn, 0…1: weekly room left on the tightest serving account.
    public let fill: Double
    /// Figures older than their freshness window: drawn dimmed.
    public let isStale: Bool

    public init(mood: Mood, fill: Double, isStale: Bool = false) {
        self.mood = mood
        self.fill = fill
        self.isStale = isStale
    }

    /// The ring moves in 5% steps: finer than that is invisible at 18 pt and only costs redraws.
    public static let step = 0.05

    /// - Parameters:
    ///   - accounts: every Claude and ChatGPT account.
    ///   - online: whether the router answered the last poll.
    public static func make(accounts: [AccountUsage], online: Bool?) -> MenuBarGauge {
        guard let online else { return MenuBarGauge(mood: .idle, fill: 1) }
        guard online else { return MenuBarGauge(mood: .down, fill: 0) }
        let serving = servingAccounts(accounts).filter { $0.weekly != nil }
        guard !serving.isEmpty else { return MenuBarGauge(mood: .idle, fill: 1) }
        let tightest = serving.min { $0.weekly!.leftPercent < $1.weekly!.leftPercent }!
        let fill = (tightest.weekly!.leftPercent / 100 / step).rounded() * step
        let blocked = serving.contains { $0.isBlocked }
        return MenuBarGauge(mood: blocked ? .blocked : .ok, fill: min(1, max(0, fill)),
                            isStale: serving.contains { $0.isStale })
    }

    /// Per provider: the active account, else the preferred one, else the first usable one.
    static func servingAccounts(_ accounts: [AccountUsage]) -> [AccountUsage] {
        ProviderKind.allCases.compactMap { kind in
            let group = accounts.filter { $0.kind == kind }
            return group.first { $0.isActive } ?? group.first { $0.isPreferred } ?? group.first { $0.health.isUsable } ?? group.first
        }
    }
}

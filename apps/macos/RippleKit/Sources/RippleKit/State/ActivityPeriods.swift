import Foundation

public enum ActivityPeriod: String, CaseIterable, Sendable, Identifiable {
    case hour, today, sevenDays, thirtyDays, month, all, custom

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .hour: "Last hour"
        case .today: "Today"
        case .sevenDays: "7 days"
        case .thirtyDays: "30 days"
        case .month: "This month"
        case .all: "All time"
        case .custom: "Custom"
        }
    }
}

/// Local calendar days, including both custom dates; the API's upper bound is exclusive.
public struct ActivityQuery: Sendable, Equatable {
    /// Wire timestamps are milliseconds, unlike the legacy `since` seconds.
    public static let millisecondsPerSecond: Double = 1000
    /// The legacy ring's rolling-hour default.
    public static let hourSeconds: TimeInterval = 3600
    /// Include today in the seven/thirty calendar-day windows, as the dashboard does.
    private static let sevenDayOffset = -6
    private static let thirtyDayOffset = -29

    public let from: Date
    public let to: Date
    public let legacySince: Int?

    public static func make(period: ActivityPeriod, now: Date = Date(), calendar: Calendar = .current,
                            customFrom: Date = Date(), customTo: Date = Date()) -> ActivityQuery {
        let midnight = calendar.startOfDay(for: now)
        let from: Date
        var to = now
        let legacySince: Int?
        switch period {
        case .hour:
            from = now.addingTimeInterval(-hourSeconds)
            legacySince = Int(hourSeconds)
        case .today:
            from = midnight
            // One second at midnight avoids an empty window caused only by integer truncation.
            legacySince = max(1, Int(now.timeIntervalSince(midnight)))
        case .sevenDays:
            from = calendar.date(byAdding: .day, value: sevenDayOffset, to: midnight)!
            legacySince = nil
        case .thirtyDays:
            from = calendar.date(byAdding: .day, value: thirtyDayOffset, to: midnight)!
            legacySince = nil
        case .month:
            from = calendar.dateInterval(of: .month, for: now)!.start
            legacySince = nil
        case .all:
            from = Date(timeIntervalSince1970: 0)
            legacySince = nil
        case .custom:
            from = calendar.startOfDay(for: min(customFrom, customTo))
            let last = calendar.startOfDay(for: max(customFrom, customTo))
            to = calendar.date(byAdding: .day, value: 1, to: last)!
            legacySince = nil
        }
        return ActivityQuery(from: from, to: to, legacySince: legacySince)
    }

    public var rangeItems: [URLQueryItem] {
        [URLQueryItem(name: "from", value: String(Int(from.timeIntervalSince1970 * Self.millisecondsPerSecond))),
         URLQueryItem(name: "to", value: String(Int(to.timeIntervalSince1970 * Self.millisecondsPerSecond)))]
    }

    public var fallbackItems: [URLQueryItem]? {
        legacySince.map { [URLQueryItem(name: "since", value: String($0))] }
    }
}

public struct ActivitySummary: Sendable {
    public let summary: RequestSummary
    /// Long periods cannot be reconstructed from an old router's last-hour response.
    public let periodAvailable: Bool

    public var note: String {
        if summary.isRange {
            return "Hourly history; boundary hours may include requests outside the selected times."
        }
        if periodAvailable {
            return "This router only keeps recent requests (up to 2,000). Totals may not cover the whole period."
        }
        return "This router version only keeps recent requests (up to 2,000). Longer periods require a newer router; no totals are shown for this period."
    }
}

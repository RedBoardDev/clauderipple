import Foundation
import SwiftUI

public extension Font {
    /// Monospaced-digit data font, so percentages and countdowns keep their width as digits change.
    static func data(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight).monospacedDigit()
    }
}

public enum Format {
    private static let minute: TimeInterval = 60
    private static let hour: TimeInterval = 3600
    private static let day: TimeInterval = 86_400

    /// Time left until `date`: "45m", "2h 13m", "3d 4h". A reset already passed reads "now": the
    /// router has not re-read the window yet, and a negative countdown would only confuse.
    public static func countdown(to date: Date, now: Date = Date()) -> String {
        let left = date.timeIntervalSince(now)
        guard left > minute else { return left > 0 ? "<1m" : "now" }
        if left < hour { return "\(Int(left / minute))m" }
        if left < day {
            let h = Int(left / hour)
            let m = Int(left.truncatingRemainder(dividingBy: hour) / minute)
            return m == 0 ? "\(h)h" : "\(h)h \(m)m"
        }
        let d = Int(left / day)
        let h = Int(left.truncatingRemainder(dividingBy: day) / hour)
        return h == 0 ? "\(d)d" : "\(d)d \(h)h"
    }

    /// How long ago `date` was: "just now", "4m ago", "2h ago", "3d ago".
    public static func age(of date: Date, now: Date = Date()) -> String {
        let secs = max(0, now.timeIntervalSince(date))
        if secs < minute { return "just now" }
        if secs < hour { return "\(Int(secs / minute))m ago" }
        if secs < day { return "\(Int(secs / hour))h ago" }
        return "\(Int(secs / day))d ago"
    }

    /// A whole percent, clamped to 0…100 for display ("100%" rather than "103%" for an overdrawn
    /// window: the bar cannot draw past full either).
    public static func percent(_ value: Double) -> String {
        "\(Int(min(100, max(0, value)).rounded()))%"
    }

    /// Signed percentage points for a pace delta: "+12 pts", "−4 pts", "on pace".
    public static func paceDelta(_ delta: Double) -> String {
        let rounded = Int(delta.rounded())
        if rounded == 0 { return "on pace" }
        return rounded > 0 ? "+\(rounded) pts" : "−\(-rounded) pts"
    }

    /// Absolute reset time for tooltips: "Thu 14:05", or "14:05" when it is today.
    public static func resetTime(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        let style: Date.FormatStyle = calendar.isDate(date, inSameDayAs: now)
            ? .dateTime.hour().minute()
            : .dateTime.weekday(.abbreviated).hour().minute()
        return date.formatted(style)
    }

    /// Compact token count: 950, 12.4k, 3.1M.
    public static func tokens(_ n: Double) -> String {
        if n < 1000 { return "\(Int(n))" }
        if n < 1_000_000 { return String(format: "%.1fk", n / 1000) }
        return String(format: "%.1fM", n / 1_000_000)
    }
}

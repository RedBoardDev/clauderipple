import SwiftUI

/// One account in the panel: name, badges, plan, then a row per usage window.
public struct AccountCard: View {
    let account: AccountUsage
    let now: Date

    public init(account: AccountUsage, now: Date) {
        self.account = account
        self.now = now
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            header
            if account.hasWindows {
                VStack(alignment: .leading, spacing: 5) {
                    if let fiveHour = account.fiveHour {
                        WindowRow(title: "5h", window: fiveHour, dimmed: account.isStale, now: now)
                    }
                    if let weekly = account.weekly {
                        WindowRow(title: "Week", window: weekly, dimmed: account.isStale, now: now)
                    }
                }
            } else {
                Text(account.health == .needsLogin ? "Sign in again from Settings → Accounts." : "No usage reported yet.")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
        .accessibilityElement(children: .combine)
    }

    private var header: some View {
        HStack(spacing: 5) {
            Text(account.label)
                .font(.system(size: 13, weight: .semibold))
                .lineLimit(1)
                .truncationMode(.middle)
            ForEach(Array(account.badges(now: now).enumerated()), id: \.offset) { $0.element }
            Spacer(minLength: 4)
            if account.isStale, let fetchedAt = account.fetchedAt {
                Text(Format.age(of: fetchedAt, now: now))
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .help("Last reading from the provider; the router has not refreshed it since.")
            } else if let plan = account.plan {
                Text(Self.planTitle(plan))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Plan names as the providers spell them in their apps ("prolite" → "Pro Lite").
    static func planTitle(_ raw: String) -> String {
        switch raw.lowercased() {
        case "prolite": "Pro Lite"
        case "pro": "Pro"
        case "plus": "Plus"
        case "team": "Team"
        case "max": "Max"
        default: raw.prefix(1).uppercased() + raw.dropFirst()
        }
    }
}

/// "5h ▕████────▏ 97%  1h 12m"
struct WindowRow: View {
    let title: String
    let window: UsageWindowState
    let dimmed: Bool
    let now: Date

    /// Fixed columns keep every bar the same length, account to account.
    static let titleWidth: CGFloat = 32
    static let percentWidth: CGFloat = 36
    static let resetWidth: CGFloat = 52

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .frame(width: Self.titleWidth, alignment: .leading)
            UsageBar(usedPercent: window.usedPercent, dimmed: dimmed)
            Text(Format.percent(window.usedPercent))
                .font(.data(12, weight: .semibold))
                .foregroundStyle(window.isExhausted ? AnyShapeStyle(Theme.bad) : AnyShapeStyle(.primary))
                .frame(width: Self.percentWidth, alignment: .trailing)
            Group {
                if let reset = window.resetsAt {
                    Text(Format.countdown(to: reset, now: now))
                        .help("Resets \(Format.resetTime(reset, now: now))")
                } else {
                    Text("—")
                }
            }
            .font(.data(11))
            .foregroundStyle(.secondary)
            .frame(width: Self.resetWidth, alignment: .trailing)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title == "5h" ? "Five-hour" : "Weekly") window, \(Format.percent(window.usedPercent)) used"
            + (window.resetsAt.map { ", resets in \(Format.countdown(to: $0, now: now))" } ?? ""))
    }
}

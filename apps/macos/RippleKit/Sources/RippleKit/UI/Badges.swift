import SwiftUI

/// Small tinted chip: Active, Preferred, Paused, Needs login.
public struct StatusBadge: View {
    public enum Tone: Sendable { case ok, accent, warn, bad, neutral }

    let text: String
    let tone: Tone
    let symbol: String?

    public init(_ text: String, tone: Tone, symbol: String? = nil) {
        self.text = text
        self.tone = tone
        self.symbol = symbol
    }

    public var body: some View {
        let color = self.color
        HStack(spacing: 3) {
            if let symbol { Image(systemName: symbol).font(.system(size: 8.5, weight: .bold)) }
            Text(text)
        }
        .font(.system(size: 10.5, weight: .semibold))
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 6)
        .padding(.vertical, 1.5)
        .background(color.opacity(tone == .neutral ? 0.08 : 0.14), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
        .foregroundStyle(tone == .neutral ? AnyShapeStyle(.secondary) : AnyShapeStyle(color))
    }

    private var color: Color {
        switch tone {
        case .ok: Theme.ok
        case .accent: Theme.accent
        case .warn: Theme.warn
        case .bad: Theme.bad
        case .neutral: .primary
        }
    }
}

public extension AccountUsage {
    /// The badges an account wears, most important first.
    @MainActor
    func badges(now: Date = Date()) -> [StatusBadge] {
        var out: [StatusBadge] = []
        switch health {
        case .ready: break
        case let .cooling(until):
            out.append(StatusBadge(until.map { "Paused · \(Format.countdown(to: $0, now: now))" } ?? "Cooling", tone: .warn, symbol: "pause.fill"))
        case .paused: out.append(StatusBadge("Paused", tone: .warn, symbol: "pause.fill"))
        case .needsLogin: out.append(StatusBadge("Sign in again", tone: .bad, symbol: "exclamationmark"))
        case let .other(state): out.append(StatusBadge(state.capitalized, tone: .neutral))
        }
        if isActive { out.append(StatusBadge("Active", tone: .ok)) }
        if isPreferred { out.append(StatusBadge("Preferred", tone: .accent, symbol: "star.fill")) }
        return out
    }
}

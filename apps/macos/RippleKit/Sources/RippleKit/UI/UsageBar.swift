import SwiftUI

/// A usage bar with an optional pace tick.
///
/// Drawn in one `Canvas` rather than stacked shapes: a single draw call per bar, and no compositing
/// layers inside the panel (CodexBar notes GPU-composited modifiers misbehaving in menu-bar windows
/// on macOS 26).
public struct UsageBar: View {
    let usedPercent: Double
    /// Where usage would be at an even pace, 0…100. Nil hides the tick.
    let expectedPercent: Double?
    let dimmed: Bool

    public init(usedPercent: Double, expectedPercent: Double? = nil, dimmed: Bool = false) {
        self.usedPercent = usedPercent
        self.expectedPercent = expectedPercent
        self.dimmed = dimmed
    }

    /// The tick overshoots the bar by this much above and below, so it reads on a full bar too.
    static let tickOverhang: CGFloat = 2.5
    static let tickWidth: CGFloat = 2

    public var body: some View {
        let tone = Theme.usageTone(usedPercent)
        Canvas { context, size in
            let height = Metrics.barHeight
            let y = (size.height - height) / 2
            let track = Path(roundedRect: CGRect(x: 0, y: y, width: size.width, height: height), cornerRadius: height / 2)
            context.fill(track, with: .color(Theme.track))
            let fraction = min(1, max(0, usedPercent / 100))
            if fraction > 0 {
                // A sliver under one bar-height still draws as a dot, so 1% is visible.
                let width = max(height, size.width * fraction)
                let fill = Path(roundedRect: CGRect(x: 0, y: y, width: width, height: height), cornerRadius: height / 2)
                context.fill(fill, with: .color(tone.opacity(dimmed ? 0.45 : 1)))
            }
            if let expectedPercent {
                let x = size.width * min(1, max(0, expectedPercent / 100))
                let tick = CGRect(x: min(size.width - Self.tickWidth, max(0, x - Self.tickWidth / 2)),
                                  y: y - Self.tickOverhang, width: Self.tickWidth, height: height + 2 * Self.tickOverhang)
                context.fill(Path(roundedRect: tick, cornerRadius: Self.tickWidth / 2), with: .color(.primary.opacity(0.62)))
            }
        }
        .frame(height: Metrics.barHeight + 2 * Self.tickOverhang)
        .accessibilityElement()
        .accessibilityLabel("\(Int(usedPercent.rounded())) percent used")
        .accessibilityValue(expectedPercent.map { "Even pace would be \(Int($0.rounded())) percent" } ?? "")
    }
}

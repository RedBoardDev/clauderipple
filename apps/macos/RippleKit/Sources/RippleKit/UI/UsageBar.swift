import SwiftUI

/// A usage bar.
///
/// Drawn in one `Canvas` rather than stacked shapes: a single draw call per bar, and no compositing
/// layers inside the panel (CodexBar notes GPU-composited modifiers misbehaving in menu-bar windows
/// on macOS 26).
public struct UsageBar: View {
    let usedPercent: Double
    let dimmed: Bool

    public init(usedPercent: Double, dimmed: Bool = false) {
        self.usedPercent = usedPercent
        self.dimmed = dimmed
    }

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
        }
        .frame(height: Metrics.barHeight)
        .accessibilityElement()
        .accessibilityLabel("\(Int(usedPercent.rounded())) percent used")
    }
}

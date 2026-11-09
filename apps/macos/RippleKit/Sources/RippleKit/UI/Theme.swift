import AppKit
import SwiftUI

/// ClaudeRipple palette: the brand tokens (brand/README.md, packages/mod/hooks/ui/theme.ts), each a
/// light/dark pair resolved by the current appearance. Text and surfaces stay system colours so the
/// app reads native in both appearances; the accent appears only where something wants attention.
public enum Theme {
    public static let accent = Color(light: 0x6A56D6, dark: 0xA594F5)
    public static let ok = Color(light: 0x1A8A4A, dark: 0x3ECB7D)
    public static let warn = Color(light: 0xB5820A, dark: 0xE0B436)
    public static let bad = Color(light: 0xC73434, dark: 0xEF5A5A)

    /// Unfilled part of a usage bar.
    public static let track = Color.primary.opacity(0.09)
    /// Hairline around raised cards.
    public static let hairline = Color.primary.opacity(0.08)
    /// Card fill: a faint lift over the panel material, so the depth comes from the material.
    public static let cardFill = Color(lightRGBA: (1, 1, 1, 0.55), darkRGBA: (1, 1, 1, 0.055))
    /// Hover wash for menu-style rows.
    public static let hover = Color.primary.opacity(0.08)

    /// Usage at or above this reads as a warning, and at `badAt` as spent.
    public static let warnAt: Double = 80
    public static let badAt: Double = 95

    /// Fill colour for a usage percentage.
    public static func usageTone(_ usedPercent: Double) -> Color {
        if usedPercent >= badAt { return bad }
        if usedPercent >= warnAt { return warn }
        return accent
    }

    // Motion: one entrance curve and one press spring, as Binsight uses.
    public static let entrance = Animation.timingCurve(0.16, 1, 0.3, 1, duration: 0.22)
    public static let springPress = Animation.spring(response: 0.3, dampingFraction: 0.8)
}

/// Spacing and corner scale shared by the panel and the settings window.
public enum Metrics {
    /// Panel edge to any label, card or row.
    public static let inset: CGFloat = 14
    /// Gap above a section label.
    public static let sectionGap: CGFloat = 12
    /// Gap between a section label and its first row.
    public static let labelGap: CGFloat = 6
    public static let cardRadius: CGFloat = 12
    public static let rowRadius: CGFloat = 7
    public static let barHeight: CGFloat = 6
    /// The popover's width: wide enough for "Week ▕bar▏ 100% 6d 23h" with a readable bar.
    public static let panelWidth: CGFloat = 348
}

public extension Color {
    /// A light/dark pair resolved against the drawing appearance.
    init(light: UInt32, dark: UInt32) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            NSColor(hex: appearance.isDark ? dark : light)
        })
    }

    init(lightRGBA: (CGFloat, CGFloat, CGFloat, CGFloat), darkRGBA: (CGFloat, CGFloat, CGFloat, CGFloat)) {
        self.init(nsColor: NSColor(name: nil) { appearance in
            let c = appearance.isDark ? darkRGBA : lightRGBA
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: c.3)
        })
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
                  blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
    }
}

extension NSAppearance {
    var isDark: Bool { bestMatch(from: [.darkAqua, .aqua, .vibrantDark, .vibrantLight]).map { $0 == .darkAqua || $0 == .vibrantDark } ?? false }
}

public extension View {
    /// Raised card: faint fill, continuous corners, 1 px hairline. No glass: Liquid Glass belongs to
    /// controls and chrome, and glass on the panel's own material would be glass on glass.
    func cardSurface(radius: CGFloat = Metrics.cardRadius) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        return background(Theme.cardFill, in: shape)
            .overlay(shape.strokeBorder(Theme.hairline, lineWidth: 1))
    }

    /// Pointing-hand cursor over a clickable control. Pops on disappear too: a popover often closes
    /// with the pointer inside it, and a bare push/pop pair would leak the cursor onto other apps.
    func pointingHandCursor() -> some View { modifier(PointingHandCursor()) }
}

struct PointingHandCursor: ViewModifier {
    @State private var pushed = false

    func body(content: Content) -> some View {
        content
            .onHover { $0 ? push() : pop() }
            .onDisappear(perform: pop)
    }

    private func push() {
        guard !pushed else { return }
        pushed = true
        NSCursor.pointingHand.push()
    }

    private func pop() {
        guard pushed else { return }
        pushed = false
        NSCursor.pop()
    }
}

/// Menu-row button style with a native hover and press highlight (plain buttons have none).
public struct HoverRowStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        Row(configuration: configuration)
    }

    private struct Row: View {
        let configuration: Configuration
        @State private var hovering = false

        var body: some View {
            configuration.label
                .background(hovering || configuration.isPressed ? Theme.hover : .clear,
                            in: RoundedRectangle(cornerRadius: Metrics.rowRadius, style: .continuous))
                .contentShape(Rectangle())
                .onHover { hovering = $0 }
        }
    }
}

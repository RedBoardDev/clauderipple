import AppKit
import SwiftUI

/// Draws the status-item image: the mono mascot whose ring is the gauge.
///
/// - ok: faint full ring (track) + solid arc for the weekly room left, eyes open;
/// - blocked: the brand's "warn" gapped ring as track, so a spent window is visible at a glance;
/// - down: thinner ring, closed eyes (brand "down" state);
/// - idle: the plain mono mark.
/// Stale figures render at reduced alpha. The result is a template image, so AppKit inverts it for
/// dark menu bars, selection and inactive screens; no colour is ever baked in.
public enum MenuBarIcon {
    /// Status-item height in points; the brand's template tray size is 22 pt.
    public static let pointSize: CGFloat = 18
    static let trackAlpha: Double = 0.3
    static let staleAlpha: Double = 0.5
    /// Down state: ring radius 17.7 and width 3.4 (brand/README.md).
    static let downRadius: CGFloat = 17.7
    static let downWidth: CGFloat = 3.4

    @MainActor
    public static func image(for gauge: MenuBarGauge) -> NSImage {
        let renderer = ImageRenderer(content: Glyph(gauge: gauge).frame(width: pointSize, height: pointSize))
        renderer.scale = 2
        let image = renderer.nsImage ?? NSImage(systemSymbolName: "circle", accessibilityDescription: nil)!
        image.isTemplate = true
        image.size = NSSize(width: pointSize, height: pointSize)
        image.accessibilityDescription = accessibilityLabel(for: gauge)
        return image
    }

    public static func accessibilityLabel(for gauge: MenuBarGauge) -> String {
        switch gauge.mood {
        case .down: "ClaudeRipple: router not answering"
        case .idle: "ClaudeRipple"
        case .ok: "ClaudeRipple: \(Int((gauge.fill * 100).rounded())) percent of the week left"
        case .blocked: "ClaudeRipple: a usage window is spent, \(Int((gauge.fill * 100).rounded())) percent of the week left"
        }
    }

    /// Black-on-clear drawing; AppKit tints it as a template.
    struct Glyph: View {
        let gauge: MenuBarGauge

        var body: some View {
            Canvas { context, size in
                let g = RippleMarkGeometry.self
                context.scaleBy(x: size.width / g.grid, y: size.height / g.grid)
                context.opacity = gauge.isStale ? MenuBarIcon.staleAlpha : 1
                let ink = GraphicsContext.Shading.color(.black)
                let faint = GraphicsContext.Shading.color(.black.opacity(MenuBarIcon.trackAlpha))
                let round = StrokeStyle(lineWidth: g.ringWidth, lineCap: .round)
                context.fill(g.crest(), with: ink)
                switch gauge.mood {
                case .idle:
                    context.stroke(g.ringArc(fraction: 1), with: ink, lineWidth: g.ringWidth)
                    context.fill(g.eyes(), with: ink)
                case .ok:
                    context.stroke(g.ringArc(fraction: 1), with: faint, lineWidth: g.ringWidth)
                    context.stroke(g.ringArc(fraction: gauge.fill), with: ink, style: round)
                    context.fill(g.eyes(), with: ink)
                case .blocked:
                    context.stroke(g.gappedRing(), with: faint, style: round)
                    context.stroke(g.ringArc(fraction: gauge.fill), with: ink, style: round)
                    context.fill(g.eyes(), with: ink)
                case .down:
                    context.stroke(g.ringArc(fraction: 1, radius: MenuBarIcon.downRadius), with: ink, lineWidth: MenuBarIcon.downWidth)
                    context.fill(g.closedEyes(), with: ink)
                }
                // Ears are dropped at this size (the brand's 16–18 px rule): they blur into the ring.
            }
        }
    }
}

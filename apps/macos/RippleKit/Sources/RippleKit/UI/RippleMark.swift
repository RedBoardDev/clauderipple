import SwiftUI

/// The ClaudeRipple mascot ("리플이 v2"), on its 56-unit grid (brand/mark-mono.svg): a hollow ring
/// that doubles as a gauge, a crest curling right from 12 o'clock, two ear arcs, two capsule eyes.
/// The ring is never filled (brand rule).
public enum RippleMarkGeometry {
    public static let grid: CGFloat = 56
    public static let center = CGPoint(x: 28, y: 31)
    public static let ringRadius: CGFloat = 16.5
    /// Mono (template) weights.
    public static let ringWidth: CGFloat = 6.4
    public static let earRadius: CGFloat = 24.5
    public static let earWidth: CGFloat = 4
    /// Ear arcs span ±26° around 3 and 9 o'clock (endpoints 50.02,20.26 → 50.02,41.74).
    public static let earHalfAngle: Double = 26

    public static func crest() -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 24.7, y: 12.29))
        p.addCurve(to: CGPoint(x: 35, y: 2.6), control1: CGPoint(x: 24.2, y: 6.2), control2: CGPoint(x: 29.2, y: 2.4))
        p.addCurve(to: CGPoint(x: 41.6, y: 9.8), control1: CGPoint(x: 39.6, y: 2.8), control2: CGPoint(x: 42.6, y: 6.2))
        p.addCurve(to: CGPoint(x: 36.8, y: 7.6), control1: CGPoint(x: 40.6, y: 8), control2: CGPoint(x: 38.6, y: 7))
        p.addCurve(to: CGPoint(x: 36.33, y: 13.92), control1: CGPoint(x: 35, y: 8.2), control2: CGPoint(x: 35, y: 11))
        p.closeSubpath()
        return p
    }

    public static func ears() -> Path {
        var p = Path()
        p.addArc(center: center, radius: earRadius, startAngle: .degrees(-earHalfAngle), endAngle: .degrees(earHalfAngle), clockwise: false)
        p.move(to: point(onRadius: earRadius, degrees: 180 - earHalfAngle))
        p.addArc(center: center, radius: earRadius, startAngle: .degrees(180 - earHalfAngle), endAngle: .degrees(180 + earHalfAngle), clockwise: false)
        return p
    }

    /// Open eyes: two upright capsules.
    public static func eyes() -> Path {
        var p = Path()
        p.addRoundedRect(in: CGRect(x: 19.9, y: 25, width: 5, height: 8.4), cornerSize: CGSize(width: 2.5, height: 2.5))
        p.addRoundedRect(in: CGRect(x: 31.1, y: 25, width: 5, height: 8.4), cornerSize: CGSize(width: 2.5, height: 2.5))
        return p
    }

    /// Closed eyes (router down): two flat capsules on the eye line.
    public static func closedEyes() -> Path {
        var p = Path()
        p.addRoundedRect(in: CGRect(x: 19.4, y: 29.2, width: 6, height: 2.6), cornerSize: CGSize(width: 1.3, height: 1.3))
        p.addRoundedRect(in: CGRect(x: 30.6, y: 29.2, width: 6, height: 2.6), cornerSize: CGSize(width: 1.3, height: 1.3))
        return p
    }

    /// The colour mark's smile (not drawn in the mono template).
    public static func mouth() -> Path {
        var p = Path()
        p.move(to: CGPoint(x: 24.8, y: 36.2))
        p.addQuadCurve(to: CGPoint(x: 31.2, y: 36.2), control: CGPoint(x: 28, y: 38.8))
        return p
    }

    /// The ring as an arc from 12 o'clock, clockwise, covering `fraction` of the circle.
    public static func ringArc(fraction: Double, radius: CGFloat = ringRadius) -> Path {
        var p = Path()
        let f = min(1, max(0, fraction))
        guard f > 0 else { return p }
        if f >= 1 {
            p.addEllipse(in: CGRect(x: center.x - radius, y: center.y - radius, width: 2 * radius, height: 2 * radius))
            return p
        }
        p.addArc(center: center, radius: radius, startAngle: .degrees(-90), endAngle: .degrees(-90 + 360 * f), clockwise: false)
        return p
    }

    /// The brand's "warn" ring: a 58°→378° arc, i.e. a gap just right of the crest.
    public static func gappedRing() -> Path {
        var p = Path()
        p.addArc(center: center, radius: ringRadius, startAngle: .degrees(58 - 90), endAngle: .degrees(378 - 90), clockwise: false)
        return p
    }

    static func point(onRadius r: CGFloat, degrees: Double) -> CGPoint {
        let rad = degrees * .pi / 180
        return CGPoint(x: center.x + r * CGFloat(cos(rad)), y: center.y + r * CGFloat(sin(rad)))
    }
}

/// The colour mark (accent body, ink face), for the panel header and About.
public struct RippleMarkView: View {
    let size: CGFloat

    public init(size: CGFloat = 20) { self.size = size }

    public var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / RippleMarkGeometry.grid
            context.scaleBy(x: scale, y: scale)
            let accent = GraphicsContext.Shading.color(Theme.accent)
            context.fill(RippleMarkGeometry.crest(), with: accent)
            context.stroke(RippleMarkGeometry.ringArc(fraction: 1), with: accent, lineWidth: 5)
            context.stroke(RippleMarkGeometry.ears(), with: accent, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
            let ink = GraphicsContext.Shading.color(.primary)
            context.fill(RippleMarkGeometry.eyes(), with: ink)
            context.stroke(RippleMarkGeometry.mouth(), with: ink, style: StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

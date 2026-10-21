import AppKit
import RippleKit
import SwiftUI

/// `ClaudeRipple --snapshot <dir> [--demo] [--panes overview,accounts,…]` renders the panel and the
/// given settings panes offscreen, in light and dark, to PNGs in <dir>, then quits.
///
/// For visual checks without screen-recording rights (a shell cannot capture the menu bar). The
/// panel is drawn on a popover-material view; the system's live blur of what lies behind the menu
/// bar cannot be reproduced offscreen, so the backdrop is the material's resting tint.
@MainActor
enum SnapshotMode {
    struct Request {
        let directory: URL
        let demo: Bool
        let panes: [SettingsPane]
    }

    static func request(from arguments: [String] = CommandLine.arguments) -> Request? {
        guard let flag = arguments.firstIndex(of: "--snapshot"), arguments.indices.contains(flag + 1) else { return nil }
        let panes = arguments.firstIndex(of: "--panes").flatMap { i in
            arguments.indices.contains(i + 1) ? arguments[i + 1].split(separator: ",").compactMap { SettingsPane(rawValue: String($0)) } : nil
        } ?? []
        return Request(directory: URL(fileURLWithPath: arguments[flag + 1], isDirectory: true),
                       demo: arguments.contains("--demo"), panes: panes)
    }

    /// Long enough for the first poll of a live router (status, limits or accounts, summary).
    static let liveSettle: Duration = .seconds(6)
    /// One render pass for SwiftUI to lay out and draw before the bitmap is taken.
    static let renderSettle: Duration = .milliseconds(600)
    static let settingsSize = CGSize(width: 860, height: 640)

    static func run(_ request: Request, app: AppController) async {
        try? FileManager.default.createDirectory(at: request.directory, withIntermediateDirectories: true)
        let store = request.demo ? DemoData.store() : app.store
        if !request.demo { try? await Task.sleep(for: liveSettle) }
        let suffix = request.demo ? "-demo" : ""
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            let panel = PanelView(app: app).environment(store).tint(Theme.accent)
            await write(panel, width: Metrics.panelWidth, height: nil, appearance: appearance, material: .popover,
                        to: request.directory.appending(path: "panel\(suffix)-\(name).png"))
            await write(IconSheet(), width: IconSheet.width, height: nil, appearance: appearance, material: .menu,
                        to: request.directory.appending(path: "menubar-icons-\(name).png"))
            for pane in request.panes {
                SettingsNavigation.shared.pane = pane
                let root = SettingsRoot(app: app).environment(store).tint(Theme.accent)
                await write(root, width: settingsSize.width, height: settingsSize.height, appearance: appearance, material: nil,
                            to: request.directory.appending(path: "settings-\(pane.rawValue)\(suffix)-\(name).png"))
            }
        }
        NSApplication.shared.terminate(nil)
    }

    /// Every icon state at menu-bar size and magnified, tinted the way the status item tints a
    /// template image.
    private struct IconSheet: View {
        static let width: CGFloat = 640
        private static let magnified: CGFloat = 3
        private static let states: [(String, MenuBarGauge)] = [
            ("full", MenuBarGauge(mood: .ok, fill: 1)),
            ("half", MenuBarGauge(mood: .ok, fill: 0.5)),
            ("low", MenuBarGauge(mood: .ok, fill: 0.15)),
            ("stale", MenuBarGauge(mood: .ok, fill: 0.6, isStale: true)),
            ("blocked", MenuBarGauge(mood: .blocked, fill: 0.4)),
            ("down", MenuBarGauge(mood: .down, fill: 0)),
            ("idle", MenuBarGauge(mood: .idle, fill: 1)),
        ]

        var body: some View {
            HStack(alignment: .bottom, spacing: 18) {
                ForEach(Self.states, id: \.0) { name, gauge in
                    let image = MenuBarIcon.image(for: gauge)
                    VStack(spacing: 6) {
                        Image(nsImage: image).renderingMode(.template).foregroundStyle(.primary)
                        Image(nsImage: image).renderingMode(.template).resizable().interpolation(.high)
                            .frame(width: image.size.width * Self.magnified, height: image.size.height * Self.magnified)
                            .foregroundStyle(.primary)
                        Text(name).font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(16)
        }
    }

    private static func write(_ view: some View, width: CGFloat, height: CGFloat?, appearance: NSAppearance.Name,
                              material: NSVisualEffectView.Material?, to url: URL) async {
        let hosting = NSHostingView(rootView: AnyView(view.frame(width: width, height: height)))
        let size = hosting.fittingSize
        let frame = NSRect(origin: .zero, size: CGSize(width: width, height: height ?? size.height))
        let container: NSView
        if let material {
            let effect = NSVisualEffectView(frame: frame)
            effect.material = material
            effect.state = .active
            effect.blendingMode = .withinWindow
            container = effect
        } else {
            container = NSView(frame: frame)
            container.wantsLayer = true
            container.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        }
        hosting.frame = container.bounds
        hosting.autoresizingMask = [.width, .height]
        container.addSubview(hosting)
        // Offscreen but ordered in, so AppKit and SwiftUI actually draw it.
        let window = NSWindow(contentRect: frame.offsetBy(dx: -20_000, dy: -20_000), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: appearance)
        window.contentView = container
        window.orderFrontRegardless()
        try? await Task.sleep(for: renderSettle)
        container.layoutSubtreeIfNeeded()
        container.display()
        if let rep = container.bitmapImageRepForCachingDisplay(in: container.bounds) {
            container.cacheDisplay(in: container.bounds, to: rep)
            try? rep.representation(using: .png, properties: [:])?.write(to: url)
        }
        window.orderOut(nil)
    }
}

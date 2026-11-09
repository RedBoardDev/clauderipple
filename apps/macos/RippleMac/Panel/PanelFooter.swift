import AppKit
import RippleKit
import SwiftUI

/// Settings, web dashboard, Quit, as menu-style rows.
struct PanelFooter: View {
    let app: AppController
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(spacing: 1) {
            row("gearshape", "Settings…", shortcut: "⌘,") { SettingsRoot.open(with: openWindow) }
                .keyboardShortcut(",", modifiers: .command)
            row("safari", "Open web dashboard", shortcut: nil) { app.openWebDashboard() }
            row("power", "Quit ClaudeRipple", shortcut: "⌘Q") { NSApplication.shared.terminate(nil) }
                .keyboardShortcut("q", modifiers: .command)
        }
        .padding(6)
    }

    /// 6 pt of footer padding plus 8 here lands the icon on `Metrics.inset`, in line with the cards.
    private func row(_ icon: String, _ title: String, shortcut: String?, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).frame(width: 18).foregroundStyle(.secondary)
                Text(title).font(.system(size: 13))
                Spacer()
                if let shortcut {
                    Text(shortcut).font(.system(size: 12)).foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .contentShape(Rectangle())
        }
        .buttonStyle(HoverRowStyle())
    }
}

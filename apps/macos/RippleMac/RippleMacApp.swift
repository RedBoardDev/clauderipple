import RippleKit
import SwiftUI

/// The menu-bar label, in its own view so observation is scoped to the one value it draws.
private struct MenuBarLabel: View {
    let store: RouterStore

    var body: some View {
        // Reads only `gauge`, which changes in 5% steps, so the status item redraws rarely.
        Image(nsImage: MenuBarIcon.image(for: store.gauge))
    }
}

@main
struct RippleMacApp: App {
    // init() builds the one controller: polling starts at launch, not on the first click
    // (MenuBarExtra builds its content lazily).
    @State private var app: AppController

    init() {
        _app = State(initialValue: AppController())
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView(app: app)
                .environment(app.store)
                .tint(Theme.accent)
                .onAppear { app.store.panelVisible = true }
                .onDisappear { app.store.panelVisible = false }
        } label: {
            MenuBarLabel(store: app.store)
        }
        .menuBarExtraStyle(.window)

        Window("ClaudeRipple Settings", id: SettingsRoot.windowID) {
            SettingsRoot(app: app)
                .environment(app.store)
                .tint(Theme.accent)
        }
        .defaultSize(width: 860, height: 620)
        .windowResizability(.contentMinSize)
        .defaultLaunchBehavior(.suppressed)
        .commands {
            CommandGroup(replacing: .appSettings) {
                SettingsWindowButton()
            }
        }
    }
}

/// ⌘, from anywhere in the app opens the settings window.
private struct SettingsWindowButton: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Settings…") { SettingsRoot.open(with: openWindow) }
            .keyboardShortcut(",", modifiers: .command)
    }
}

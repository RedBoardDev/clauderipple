import AppKit
import RippleKit
import SwiftUI

/// The settings window's panes, in sidebar order.
enum SettingsPane: String, CaseIterable, Identifiable, Hashable {
    case overview, accounts, mapping, workers, clients, activity, laptop, general, about

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .accounts: "Accounts"
        case .mapping: "Model mapping"
        case .workers: "Workers and effort"
        case .clients: "Clients"
        case .activity: "Activity"
        case .laptop: "Laptop"
        case .general: "General"
        case .about: "About"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "gauge.with.dots.needle.67percent"
        case .accounts: "person.2.fill"
        case .mapping: "arrow.triangle.branch"
        case .workers: "slider.horizontal.3"
        case .clients: "app.connected.to.app.below.fill"
        case .activity: "chart.bar.xaxis"
        case .laptop: "laptopcomputer"
        case .general: "gearshape.fill"
        case .about: "info.circle.fill"
        }
    }

    /// Sidebar groups.
    static let groups: [(title: String, panes: [SettingsPane])] = [
        ("Router", [.overview, .accounts, .mapping, .workers, .clients]),
        ("Monitor", [.activity, .laptop]),
        ("App", [.general, .about]),
    ]
}

/// Which pane the window shows; shared so the panel can open the window on a given pane.
@MainActor
@Observable
final class SettingsNavigation {
    static let shared = SettingsNavigation()
    var pane: SettingsPane = .overview
}

/// The settings window: a System Settings style sidebar and one pane at a time.
struct SettingsRoot: View {
    static let windowID = "settings"
    let app: AppController
    @State private var navigation = SettingsNavigation.shared

    /// Opens (or brings forward) the window, optionally on a pane. The app is a menu-bar agent, so it
    /// has to activate itself or the window opens behind the frontmost app.
    static func open(with openWindow: OpenWindowAction, pane: SettingsPane? = nil) {
        if let pane { SettingsNavigation.shared.pane = pane }
        openWindow(id: windowID)
        NSApp.activate()
    }

    var body: some View {
        NavigationSplitView {
            List(selection: Binding(get: { navigation.pane }, set: { if let pane = $0 { navigation.pane = pane } })) {
                ForEach(SettingsPane.groups, id: \.title) { group in
                    Section(group.title) {
                        ForEach(group.panes) { pane in
                            Label(pane.title, systemImage: pane.symbol).tag(pane)
                        }
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 190, ideal: 210, max: 260)
        } detail: {
            detail(navigation.pane)
                .navigationTitle(navigation.pane.title)
                .frame(minWidth: 560, minHeight: 520)
        }
        // While the window is open the app shows in the Dock and ⌘-Tab, like any window; closed,
        // it goes back to being a menu-bar agent.
        .onAppear { NSApp.setActivationPolicy(.regular) }
        .onDisappear { NSApp.setActivationPolicy(.accessory) }
    }

    @ViewBuilder
    private func detail(_ pane: SettingsPane) -> some View {
        switch pane {
        case .overview: OverviewPane(app: app)
        case .accounts: AccountsPane(app: app)
        case .mapping: MappingPane(app: app)
        case .workers: WorkersPane(app: app)
        case .clients: ClientsPane(app: app)
        case .activity: ActivityPane(app: app)
        case .laptop: LaptopPane(app: app)
        case .general: GeneralPane(app: app)
        case .about: AboutPane(app: app)
        }
    }
}

/// Placeholder body for a pane under construction.
struct PanePlaceholder: View {
    let pane: SettingsPane

    var body: some View {
        ContentUnavailableView(pane.title, systemImage: pane.symbol, description: Text("Coming in this build."))
    }
}

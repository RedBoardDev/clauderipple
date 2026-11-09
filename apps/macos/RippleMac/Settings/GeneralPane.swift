import RippleKit
import SwiftUI

struct GeneralPane: View {
    let app: AppController
    @Environment(RouterStore.self) private var store
    @AppStorage(AppController.notificationsKey) private var notifyRouterDown = true
    @State private var launchAtLogin = LaunchAtLogin.isEnabled
    @State private var loginError: String?

    var body: some View {
        Form {
            Section("Startup") {
                Toggle("Launch at login", isOn: Binding(get: { launchAtLogin }, set: { enabled in
                    loginError = LaunchAtLogin.set(enabled)
                    launchAtLogin = LaunchAtLogin.isEnabled
                }))
                InlineError(loginError)
            }
            Section("Notifications") {
                Toggle("Notify me when the router stops answering", isOn: $notifyRouterDown)
                FormNote("ClaudeRipple notifies you after the router has stopped answering for a short while, rather than during a normal startup.")
            }
            Section("Web dashboard") {
                Button("Open web dashboard", systemImage: "arrow.up.forward.app") { app.openWebDashboard() }
                    .buttonStyle(.glass)
                FormNote("Provider editing, Google accounts and phone pairing stay on the web dashboard. Phone pairing links are credentials; only show them when you need them.")
            }
        }
        .formStyle(.grouped)
        .onAppear { launchAtLogin = LaunchAtLogin.isEnabled }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            launchAtLogin = LaunchAtLogin.isEnabled
        }
    }
}

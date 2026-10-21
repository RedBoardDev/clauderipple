import AppKit
import Observation
import RippleKit
import UserNotifications

/// Owns the app's long-lived pieces, outside any view: the store's polling starts at launch, and the
/// "router down" notification fires whether or not the panel was ever opened.
@MainActor
final class AppController {
    let store: RouterStore
    private var downNotified = false
    private var watcher: Task<Void, Never>?

    /// The tray waited this long before calling an outage one: a router still coming up after login
    /// must not raise a notification.
    static let downNotifyAfter: TimeInterval = 20
    static let notificationsKey = "notifyRouterDown"

    init() {
        store = RouterStore()
        UserDefaults.standard.register(defaults: [Self.notificationsKey: true])
        store.start()
        watchConnection()
    }

    /// Checks the outage rule every few seconds. Polling rather than observing: the rule is about
    /// elapsed time, which no property change announces.
    private func watchConnection() {
        watcher = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                self?.evaluateOutage()
            }
        }
    }

    private func evaluateOutage() {
        guard let since = store.downSince else {
            downNotified = false
            return
        }
        guard !downNotified, Date().timeIntervalSince(since) >= Self.downNotifyAfter,
              UserDefaults.standard.bool(forKey: Self.notificationsKey) else { return }
        downNotified = true
        Self.postDownNotification()
    }

    private static func postDownNotification() {
        Task {
            let center = UNUserNotificationCenter.current()
            // An unsigned build cannot get notification rights; the panel still says it.
            guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
            let content = UNMutableNotificationContent()
            content.title = "ClaudeRipple isn't answering"
            content.body = "Claude can't reach its models until the router is back. Open ClaudeRipple to repair it or switch to direct mode."
            try? await center.add(UNNotificationRequest(identifier: "router-down", content: content, trigger: nil))
        }
    }

    /// The router's own dashboard, for the screens that stay on the web (providers, phone).
    func openWebDashboard(section: String? = nil) {
        var url = store.client.baseURL
        if let section { url = url.appending(path: "/").appending(fragment: section) }
        NSWorkspace.shared.open(url)
    }
}

private extension URL {
    func appending(fragment: String) -> URL {
        var components = URLComponents(url: self, resolvingAgainstBaseURL: false)!
        components.fragment = fragment
        return components.url ?? self
    }
}
